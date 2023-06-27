// Takes a comma-separated values (CSV) file and creates a JSON body for POST /applicationForms.
// The CSV is usually derived from the following URL using xlsx export and `xslx2csv`:
// https://docs.google.com/spreadsheets/d/1Ep3_MEIyIbhxJ5TpH5x4Q1fRZqr1CFHXZ_uv3fEOSEk
import {
  createWriteStream,
  readFileSync,
} from 'fs';
import { parse as csvParse } from 'csv-parse/sync';
import { parse } from 'ts-command-line-args';
import axios, { AxiosError } from 'axios';
import { assertIsCsvRow } from './csv';
import { logger } from './logger';

interface Args {
  inputFile: string;
  outputFile: string;
  opportunityId: number;
  funder: string;
  bearerToken: string;
  apiUrl: string;
}

interface ApplicationFormField {
  baseFieldId: number;
  position: number;
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
  createdAt: Date;
}

const args = parse<Args>({
  inputFile: String,
  outputFile: String,
  opportunityId: Number,
  funder: String,
  bearerToken: String,
  apiUrl: String,
});

const csvParser = csvParse(readFileSync(args.inputFile, 'utf8'), {
  columns: true,
}) as unknown[];

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
  const label = `${funder}: field label`;
  const pos = `${funder}: form position`;
  Promise.all(csvParser.map((row) => {
    assertIsCsvRow(row);
    let field: BaseField;
    if (row[label] !== '') {
      const shortCode = row['Internal field name'];
      const fieldsFiltered = fields.filter((e) => e.shortCode === shortCode);
      if (fieldsFiltered.length === 1 && fieldsFiltered[0] !== undefined) {
        [field] = fieldsFiltered;
      } else {
        const code = shortCode !== undefined ? shortCode : 'undefined';
        throw new Error(`Found ${fieldsFiltered.length} base fields (expected 1): shortCode=${code}`);
      }
      const position = row[pos];
      const applicationFormField: ApplicationFormField = {
        baseFieldId: field.id,
        position: typeof position === 'number' ? position : (counter += 1),
        label: row[label],
      };
      return applicationFormField;
    }
    return undefined;
  })).then((applicationFormFields) => {
    applicationFormFields.forEach((field) => {
      if (field !== undefined) {
        applicationForm.fields.push(field);
      }
    });
    jsonOutput.write(JSON.stringify(applicationForm));
    jsonOutput.close();
  }).catch((error: unknown) => {
    logger.error(`Error creating form fields: ${JSON.stringify(error)}`);
  });
}).catch((error: AxiosError) => {
  logger.error({ error }, 'Error getting base fields');
});
