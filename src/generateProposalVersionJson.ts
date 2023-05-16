// Takes a CSV file and creates a JSON body for POST /proposalVersions.
import fs from 'fs';
import CsvReadableStream from 'csv-reader';
import { parse } from 'ts-command-line-args';
import axios from 'axios'
import { AxiosError } from 'axios';

interface Args {
  inputFile: string;
  applicantColumnName: string;
  applicationFormId: number;
  proposalExternalIdColumnName: string;
  bearerToken: string;
  apiUrl: string;
}

interface csvRow {
  [key: string]: any;
}

interface Applicant {
  readonly id: number;
  externalId: string;
  readonly optedIn: boolean;
  readonly createdAt: Date;
}

interface ApplicationFormField {
  readonly id: number;
  canonicalFieldId: number;
  position: number;
  label: string;
  readonly createdAt: Date;
}

interface ApplicationForm {
  readonly id: number;
  opportunityId: number;
  version: number;
  readonly createdAt: Date;
  readonly fields: ApplicationFormField[];
}

interface ProposalFieldValue {
  applicationFormFieldId: number;
  position: number;
  value: string;
}

interface ProposalVersion {
  proposalId: number;
  applicationFormId: number;
  fieldValues: ProposalFieldValue[];
}

interface Proposal {
  readonly id: number;
  applicantId: number;
  opportunityId: number;
  externalId: string;
  readonly createdAt: Date;
}

interface Bundle<T> {
  entries: T[];
}

type ProposalWrite = Omit<Proposal, 'createdAt' | 'id' | 'versions'>;

const args = parse<Args>({
  inputFile: String,
  applicantColumnName: String,
  applicationFormId: Number,
  proposalExternalIdColumnName: String,
  bearerToken: String,
  apiUrl: String
});

const csvInput = fs.createReadStream(args.inputFile, 'utf8');
const {
  applicantColumnName,
  applicationFormId,
  proposalExternalIdColumnName,
  bearerToken,
  apiUrl
} = args;

const headers = {
  'accept': 'application/json',
  'authorization': 'Bearer ' + bearerToken,
}

let count = 1;
let lastCount = 0;
const requestTimeoutMs = 60000;

try {
  let form = (await
    axios.get<ApplicationForm>(`${apiUrl}/applicationForms/${applicationFormId}`, {
      headers,
      params: {
        includeFields: 'true',
      },
    })
  ).data;

  console.log(JSON.stringify(form));

  const proposals = (await
    axios.get<Bundle<Proposal>>(`${apiUrl}/proposals`, {
      headers,
      params: {
        _page: 1,
        _count: 100000,
      }
    })
  ).data.entries;

  console.log(`Proposals found: ${proposals}`);

  csvInput.pipe(
    new CsvReadableStream({
      parseNumbers: false,
      parseBooleans: false,
      trim: true,
      allowQuotes: true,
      asObject: true,
    }),
  ).on('data', async (row: csvRow) => {
    // First, we need the applicant id (not its external id), so look it up.
    // Extract the applicant external id from the given field name.
    const applicantExternalId: string = row[applicantColumnName];
    console.log(`Posting or getting applicant with externalId=${applicantExternalId}`)
    let applicant: Applicant | undefined;
    let finalApplicant: Applicant;

    const applicants = (
      await axios.get<Applicant[]>(
        `${apiUrl}/applicants`,
        {
          timeout: requestTimeoutMs,
          headers,
        }
      )
    ).data;

    if (applicants !== undefined && applicants.length > 0) {
      applicant = applicants.filter(a => a.externalId === applicantExternalId)[0];
    }

    if (applicant === undefined) {
      try {
        applicant = (
          await axios.post(
            `${apiUrl}/applicants`,
            { externalId: applicantExternalId },
            {
              timeout: requestTimeoutMs,
              headers,
            },
          )
        ).data;
      } catch (error: any) {
        if (error instanceof AxiosError
          && error.response !== undefined
          && error.response.status === 409) {
          console.log(`Got a 409 when posting applicant ${applicantExternalId}, getting again.`);
          // Get the applicants again.
          const applicantsAgain = (
            await axios.get<Applicant[]>(
              `${apiUrl}/applicants`,
              {
                timeout: requestTimeoutMs,
                headers,
              }
            )
          ).data;

          if (applicantsAgain !== undefined && applicantsAgain.length > 0) {
            applicant = applicantsAgain.filter(a => a.externalId === applicantExternalId)[0];
          }
        }
      }
    }

    if (applicant === undefined) {
      throw new Error('Could not GET or POST an applicant.');
    } else {
      finalApplicant = applicant;
    }

    console.log(`Applicant PDC id: ${finalApplicant.id}`);

    // Second, we need a proposal ID for the given applicant/opportunity/externalid combination.
    // We assume the applicant has been found or created above and that the opportunity has been
    // created before the application form. We get the opportunity ID from the application form.
    // Extract the proposal external id from the given field name.
    const proposalExternalId: string = row[proposalExternalIdColumnName];
    console.log(`proposal external id: ${proposalExternalId}`);
    let proposal: Proposal | undefined;
    let finalProposal: Proposal;

    // Pick the only existing proposal with given opportunity id, applicant id, and external id.
    if (proposals !== undefined && proposals.length > 0) {
      proposal = proposals.filter(
        p => (p.opportunityId == form.opportunityId
          && p.applicantId == finalApplicant.id)
          && p.externalId == proposalExternalId
      )[0];
    }

    // If the proposal did not exist, create it.
    if (proposal === undefined) {
      console.log(`No existing proposal for opportunityId=${form.opportunityId}, applicantId=${finalApplicant.id}, and externalId=${proposalExternalId}`);
      proposal = (
        await axios.post(
          `${apiUrl}/proposals`,
          {
            applicantId: finalApplicant.id,
            opportunityId: form.opportunityId,
            externalId: proposalExternalId,
          },
          {
            timeout: requestTimeoutMs,
            headers,
          },
        )
      ).data;
    } else {
      console.log(`Found existing proposal with id=${proposal.id} for opportunityId=${form.opportunityId}, applicantId=${finalApplicant.id}, and externalId=${proposalExternalId}`);
    }

    if (proposal === undefined) {
      throw new Error('Could not GET or POST a proposal.');
    } else {
      finalProposal = proposal;
    }

    console.log(`Proposal id: ${finalProposal.id}`);

    // Third, we create a proposal version and populate the fieldValues array.
    let proposalVersion: ProposalVersion = {
      proposalId: finalProposal.id,
      applicationFormId,
      fieldValues: [],
    }

    for (let key in row) {
      // Where the CSV header name matches the label in the application field form, add a value.
      const formFields: ApplicationFormField[] = form.fields.filter(field => field.label === key);
      // We can replicate the same application form field to multiple canonical fields.
      // The specific use case is "Organization Legal Name" to "Organization Name".
      for (let formField of formFields) {
        const fieldValue = row[key];
        if (formField !== undefined && fieldValue !== null && fieldValue !== '') {
          const proposalValue: ProposalFieldValue = {
            applicationFormFieldId: formField.id,
            position: formField.position,
            value: row[key],
          }
          proposalVersion.fieldValues.push(proposalValue);
        } else {
          console.log(`Field value for '${key}' for proposal '${finalProposal.id}' was null or empty: skipped.`);
        }
      }
      if (formFields.length === 0) {
        console.log(`Failed to find any field label matching '${key}' in row ${row}, got ${formFields.length}`);
      }
    }

    // Fourth, post a proposal version using the data finally assembled in `proposalVersion`.
    await axios.post(
      `${apiUrl}/proposalVersions`,
      proposalVersion,
      {
        timeout: requestTimeoutMs,
        headers,
      },
    );

    count += 1;
  }).on('end', () => {
    console.log('Reached the end of the CSV.');
    count += 1;
  });

  while (count > lastCount) {
    console.log(`Count was greater than last time: ${count} > ${lastCount}`);
    lastCount = count;
    // Wait 4x as long as the axios request timeout to give a chance for 3 requests.
    await new Promise((resolve) => { setTimeout(resolve, requestTimeoutMs * 4) });
  }

  console.log('Finished waiting for all the POSTs');
} catch (error: unknown) {
  console.log(error);
}
