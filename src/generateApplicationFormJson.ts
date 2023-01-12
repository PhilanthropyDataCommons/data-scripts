// Takes a pipe-separated values file and creates a JSON body for POST /applicationForms.
import fs from 'fs';
import CsvReadableStream from 'csv-reader';
import { parse } from 'ts-command-line-args';

interface Args {
  inputFile: string;
  outputFile: string;
  opportunityId: number;
}

interface ApplicationFormField {
  canonicalFieldId: number;
  position: number;
  label: string;
}
interface ApplicationForm {
  opportunityId: number;
  fields: ApplicationFormField[];
}

interface SpreadsheetAdditionalColumns {
  funderField: string;
}

const args = parse<Args>({
  inputFile: String,
  outputFile: String,
  opportunityId: Number,
});

const psvInput = fs.createReadStream(args.inputFile, 'utf8');
const jsonOutput = fs.createWriteStream(args.outputFile, 'utf8');
const { opportunityId } = args;

let applicationForm: ApplicationForm = {
    opportunityId,
    fields: [],
}

psvInput.pipe(
  new CsvReadableStream({
    parseNumbers: true,
    parseBooleans: true,
    trim: true,
    delimiter: '|',
    asObject: true,
  }),
).on('data', (row: ApplicationFormField & SpreadsheetAdditionalColumns) => {
  const applicationFormField: ApplicationFormField = {
    canonicalFieldId: row.canonicalFieldId,
    position: row.position,
    label: row.label,
  }
  applicationForm.fields.push(applicationFormField);
}).on('end', () => {
  jsonOutput.write(JSON.stringify(applicationForm));
  jsonOutput.close();
});
