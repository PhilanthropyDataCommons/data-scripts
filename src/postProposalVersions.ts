// Takes a CSV file, creates JSON bodies for POST /proposalVersions, posts them.
import { readFileSync } from 'fs';
import { parse as csvParse } from 'csv-parse/sync';
import { parse as argParse } from 'ts-command-line-args';
import axios, { AxiosError } from 'axios';
import { assertIsCsvRow } from './csv';
import { logger } from './logger';
import type { CsvRow } from './csv';

interface Args {
  inputFile: string;
  applicantColumnName: string;
  applicationFormId: number;
  proposalExternalIdColumnName: string;
  bearerToken: string;
  apiUrl: string;
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

const args = argParse<Args>({
  inputFile: String,
  applicantColumnName: String,
  applicationFormId: Number,
  proposalExternalIdColumnName: String,
  bearerToken: String,
  apiUrl: String,
});

const {
  applicantColumnName,
  applicationFormId,
  proposalExternalIdColumnName,
  bearerToken,
  apiUrl,
} = args;

const headers = {
  accept: 'application/json',
  authorization: `Bearer ${bearerToken}`,
};

const requestTimeoutMs = 60000;

const jsonSubstring = (json: object) => JSON.stringify(json).substring(0, 40);

const getOrPostApplicantByExternalId = async (applicantExternalId: string) => {
  let applicant: Applicant | undefined;
  let finalApplicant: Applicant;

  const applicants = (
    await axios.get<Applicant[]>(
      `${apiUrl}/applicants`,
      {
        timeout: requestTimeoutMs,
        headers,
      },
    )
  ).data;

  if (applicants.length > 0) {
    [applicant] = applicants.filter((a) => a.externalId === applicantExternalId);
  }

  if (applicant === undefined) {
    try {
      applicant = (
        await axios.post<Applicant>(
          `${apiUrl}/applicants`,
          { externalId: applicantExternalId },
          {
            timeout: requestTimeoutMs,
            headers,
          },
        )
      ).data;
    } catch (error: unknown) {
      if (error instanceof AxiosError
        && error.response !== undefined
        && error.response.status === 409) {
        // Get the applicants again.
        const applicantsAgain = (
          await axios.get<Applicant[]>(
            `${apiUrl}/applicants`,
            {
              timeout: requestTimeoutMs,
              headers,
            },
          )
        ).data;

        if (applicantsAgain.length > 0) {
          [applicant] = applicantsAgain.filter((a) => a.externalId === applicantExternalId);
        }
      }
    }
  }

  if (applicant === undefined) {
    throw new Error('Could not GET or POST an applicant.');
  } else {
    finalApplicant = applicant;
  }

  return finalApplicant;
};

const getOrPostProposal = async (
  proposals: Proposal[],
  opportunityId: number,
  applicant: Applicant,
  proposalExternalId: string,
) => {
  let proposal: Proposal | undefined;

  // Pick the only existing proposal with given opportunity id, applicant id, and external id.
  // This should work because there is a unique constraint across these three fields.
  if (proposals.length > 0) {
    [proposal] = proposals.filter(
      (p) => (p.opportunityId === opportunityId
        && p.applicantId === applicant.id
        && p.externalId === proposalExternalId
      ),
    );
  }

  // If the proposal did not exist, create it.
  if (proposal === undefined) {
    logger.info(`No existing proposal for opportunityId=${opportunityId}, applicantId=${applicant.id}, and externalId=${proposalExternalId}`);
    proposal = (
      await axios.post<Proposal>(
        `${apiUrl}/proposals`,
        {
          applicantId: applicant.id,
          opportunityId,
          externalId: proposalExternalId,
        },
        {
          timeout: requestTimeoutMs,
          headers,
        },
      )
    ).data;
  } else {
    logger.info(`Found existing proposal with id=${proposal.id} for opportunityId=${opportunityId}, applicantId=${applicant.id}, and externalId=${proposalExternalId}`);
  }
  return proposal;
};

const postProposalVersion = async (
  proposal: Proposal,
  form: ApplicationForm,
  row: CsvRow,
) => {
  const proposalVersion: ProposalVersion = {
    proposalId: proposal.id,
    applicationFormId,
    fieldValues: [],
  };
  Object.keys(row).forEach((key) => {
    // Where the CSV header name matches the label in the application field form, add a value.
    const formFields: ApplicationFormField[] = form.fields.filter((field) => field.label === key);
    // We can replicate the same application form field to multiple canonical fields.
    // The specific use case is "Organization Legal Name" to "Organization Name".
    Object.values(formFields).forEach((formField) => {
      const fieldValue = row[key];
      if (fieldValue === undefined) {
        throw new Error(`Undefined value for key '${key}' in row`);
      } else if (fieldValue !== '') {
        const proposalValue: ProposalFieldValue = {
          applicationFormFieldId: formField.id,
          position: formField.position,
          value: fieldValue,
        };
        proposalVersion.fieldValues.push(proposalValue);
      } else {
        logger.info(`Field value for '${key}' for proposal '${proposal.id}' was null or empty: skipped.`);
      }
    });
    if (formFields.length === 0) {
      logger.info(`Failed to find any field label matching '${key}' in row '${jsonSubstring(row)}...', got ${formFields.length}`);
    }
  });

  // Post the new proposal version using the data in `proposalVersion`.
  await axios.post<ProposalVersion>(
    `${apiUrl}/proposalVersions`,
    proposalVersion,
    {
      timeout: requestTimeoutMs,
      headers,
    },
  );
};

const postProposalVersions = async () => {
  let rowsRead = 0;
  let versionsPosted = 0;

  try {
    const form = (
      await axios.get<ApplicationForm>(`${apiUrl}/applicationForms/${applicationFormId}`, {
        headers,
        params: {
          includeFields: 'true',
        },
      })
    ).data;

    logger.info(`Got the relevant application form: '${jsonSubstring(form)}...'`);

    const proposals = (
      await axios.get<Bundle<Proposal>>(`${apiUrl}/proposals`, {
        headers,
        params: {
          _page: 1,
          _count: 100000,
        },
      })
    ).data.entries;

    logger.info(`Got ${proposals.length} existing proposals.`);

    const csvParser = csvParse(readFileSync(args.inputFile, 'utf8'), {
      columns: true,
    }) as unknown[];

    await Promise.all(csvParser.map(async (row) => {
      assertIsCsvRow(row);
      rowsRead += 1;
      logger.info(`Read CSV row: '${jsonSubstring(row)}...'`);
      // First, we need the applicant id (not its external id), so look it up or create it.
      // Extract the applicant external id from the given field name.
      const applicantExternalId = row[applicantColumnName];
      if (applicantExternalId === undefined) {
        throw new Error(`Row '${jsonSubstring(row)}...' had undefined applicantExternalId value`);
      }
      const applicant = await getOrPostApplicantByExternalId(applicantExternalId);

      // Second, we need a proposal ID for the given applicant/opportunity/externalid combination.
      // We assume the applicant has been found or created above and that the opportunity has been
      // created before the application form. We get the opportunity ID from the application form.
      // Extract the proposal external id from the given field name.
      const proposalExternalId = row[proposalExternalIdColumnName];
      if (proposalExternalId === undefined) {
        throw new Error(`Row '${jsonSubstring(row)}...' had undefined proposalExternalId value`);
      }
      logger.info(`Found proposal external id: ${proposalExternalId}`);
      const proposal = await getOrPostProposal(
        proposals,
        form.opportunityId,
        applicant,
        proposalExternalId,
      );
      logger.info(`Proposal id: ${proposal.id}`);

      // Third, we create a proposal version, populate the fieldValues array, and post it.
      await postProposalVersion(proposal, form, row);
      versionsPosted += 1;
    }));

    logger.info(`Finished. Read ${rowsRead} rows, posted ${versionsPosted} proposal versions.`);
  } catch (error: unknown) {
    logger.info(error);
  }
};

postProposalVersions()
  .then(() => {
    logger.info('Really finished.');
  }).catch((error: unknown) => {
    logger.info(error);
  });
