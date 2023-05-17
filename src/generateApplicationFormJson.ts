// Takes a csv file and creates a JSON body for POST /applicationForms.
import fs from 'fs';
import CsvReadableStream from 'csv-reader';
import { parse } from 'ts-command-line-args';
import axios, { AxiosError } from 'axios';

interface Args {
  inputFile: string;
  outputFile: string;
  opportunityId: number;
  funder: string;
  bearerToken: string;
  apiUrl: string;
}

type CsvRow = Record<string, string>;
interface ApplicationFormField {
  canonicalFieldId: number;
  position: number | string | undefined;
  label: string | undefined;
}
interface ApplicationForm {
  opportunityId: number;
  fields: ApplicationFormField[];
}

interface CanonicalField {
  id: number;
  label: string;
  shortCode: string;
  dataType: string;
  createdAt: string;
}

const args = parse<Args>({
  inputFile: String,
  outputFile: String,
  opportunityId: Number,
  funder: String,
  bearerToken: String,
  apiUrl: String,
});

const csvInput = fs.createReadStream(args.inputFile, 'utf8');
const jsonOutput = fs.createWriteStream(args.outputFile, 'utf8');
const {
  opportunityId, funder, bearerToken, apiUrl,
} = args;

const applicationForm: ApplicationForm = {
  opportunityId,
  fields: [],
};
let counter = 0;

axios(`${apiUrl}/canonicalFields`, {
  method: 'GET',
  headers: {
    accept: 'application/json',
    Authorization: `Bearer ${bearerToken}`,
  },
}).then((response) => {
  const fields: CanonicalField[] = response.data as CanonicalField[];
  csvInput.pipe(
    new CsvReadableStream({
      parseNumbers: true,
      parseBooleans: true,
      trim: true,
      allowQuotes: true,
      asObject: true,
    }),
  ).on('data', (row: CsvRow) => {
    const label = `${funder}: field label`;
    const id = `${funder}: external ID`;
    const pos = `${funder}: form position`;
    let field: CanonicalField | undefined;
    if (row[id] !== '') {
      const shortCode = row['Internal field name'];
      field = fields.find((e) => e.shortCode === shortCode);
      if (field) {
        const applicationFormField: ApplicationFormField = {
          canonicalFieldId: field.id,
          position: row[pos] ? '' : (counter += 1),
          label: row[label],
        };
        applicationForm.fields.push(applicationFormField);
      }
    }
  }).on('end', () => {
    jsonOutput.write(JSON.stringify(applicationForm));
    jsonOutput.close();
  });
}).catch((error: AxiosError) => {
  console.log(error.response?.data);
});
