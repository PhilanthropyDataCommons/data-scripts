// Takes a comma-separated values (CSV) file and creates a JSON body for POST /applicationForms.
// The CSV is usually derived from the following URL using xlsx export and `xslx2csv`:
// https://docs.google.com/spreadsheets/d/1Ep3_MEIyIbhxJ5TpH5x4Q1fRZqr1CFHXZ_uv3fEOSEk
import {
  createReadStream,
  createWriteStream,
} from 'fs';
import CsvReadableStream from 'csv-reader';
import { parse } from 'ts-command-line-args';
import axios, { AxiosError } from 'axios';
import { logger } from './logger';

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
  baseFieldId: number;
  position: number | string | undefined;
  label: string | undefined;
}
interface ApplicationForm {
  opportunityId: number;
  fields: ApplicationFormField[];
}

interface BaseField {
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

const csvInput = createReadStream(args.inputFile, 'utf8');
const jsonOutput = createWriteStream(args.outputFile, 'utf8');
const {
  opportunityId, funder, bearerToken, apiUrl,
} = args;

const applicationForm: ApplicationForm = {
  opportunityId,
  fields: [],
};
let counter = 0;

axios(`${apiUrl}/baseFields`, {
  method: 'GET',
  headers: {
    accept: 'application/json',
    Authorization: `Bearer ${bearerToken}`,
  },
}).then((response) => {
  const fields: BaseField[] = response.data as BaseField[];
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
    let field: BaseField | undefined;
    if (row[id] !== '') {
      const shortCode = row['Internal field name'];
      field = fields.find((e) => e.shortCode === shortCode);
      if (field) {
        const applicationFormField: ApplicationFormField = {
          baseFieldId: field.id,
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
  logger.error({ error }, 'Error getting base fields');
});
