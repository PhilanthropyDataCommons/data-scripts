// Takes a csv file and creates a JSON body for POST /applicationForms.
import fs from 'fs';
import CsvReadableStream from 'csv-reader';
import { parse } from 'ts-command-line-args';
import  axios  from 'axios'
import { AxiosError } from 'axios';
interface Args {
  inputFile: string;
  outputFile: string;
  opportunityId: number;
  funder: string;
  bearerToken: string;
  apiUrl: string;
}

interface csvRow {
  [key: string]: any;
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
  apiUrl: String
});

const csvInput = fs.createReadStream(args.inputFile, 'utf8');
const jsonOutput = fs.createWriteStream(args.outputFile, 'utf8');
const { opportunityId, funder, bearerToken, apiUrl } = args;

let applicationForm: ApplicationForm = {
    opportunityId,
    fields: [],
}
let counter = 0;

console.log('about to get canonical fields');
axios(apiUrl+'/canonicalFields',{
  'method': 'GET',
  'headers' : {
    'accept': 'application/json',
    'Authorization': 'Bearer ' + bearerToken
  }
}).then((response) => {
  console.log('I have canonical fields, about to process them');
  let fields: BaseField[] = response.data;
  csvInput.pipe(
    new CsvReadableStream({
      parseNumbers: true,
      parseBooleans: true,
      trim: true,
      allowQuotes: true,
      asObject: true,
    }),
  ).on('data', (row: csvRow) => {
    csvInput.pause();
    const label = funder + ': field label';
    const id = funder + ': external ID';
    const pos = funder + ': form position';
    if (row[label] !== '') {
      const shortCode = row['Internal field name'];
      const fieldsFiltered = fields.filter(e  => e['shortCode'] === shortCode);
      var field: BaseField;
      if (fieldsFiltered.length === 1 && fieldsFiltered[0] !== undefined) {
        field = fieldsFiltered[0];
      } else {
        throw new Error(`Found ${fieldsFiltered.length} base fields (expected 1): shortCode=${shortCode}`);
      }
      const applicationFormField: ApplicationFormField = {
        canonicalFieldId: field.id,
        position: row[pos] === '' ? counter++ : row[pos],
        label: row[label],
      }
      applicationForm.fields.push(applicationFormField);
    }
    csvInput.resume();
  }).on('end', async () => {
    console.log('Waiting a few seconds for things to finish up');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    jsonOutput.write(JSON.stringify(applicationForm));
    jsonOutput.close();
  });
}).catch((error:any) => {
  console.log(error);
});
