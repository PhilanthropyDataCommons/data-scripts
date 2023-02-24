// Takes a pipe-separated values file and creates a canonical fields INSERT SQL file.
import fs from 'fs';
import os from 'os';
import CsvReadableStream from 'csv-reader';
import { parse } from 'ts-command-line-args';

interface Args {
  inputFile: string;
  outputFile: string;
}

const args = parse<Args>({
  inputFile: String,
  outputFile: String,
});

const psvInput = fs.createReadStream(args.inputFile, 'utf8');
const sqlOutput = fs.createWriteStream(args.outputFile, 'utf8');

sqlOutput.write(`INSERT INTO canonical_fields (id, label, short_code, data_type) OVERRIDING SYSTEM VALUE VALUES${os.EOL}`);

let firstRowArrived = false;
psvInput.pipe(
  new CsvReadableStream({
    parseNumbers: true,
    parseBooleans: true,
    trim: true,
    delimiter: '|',
    asObject: true,
  }),
).on('data', (row: Object) => {
  const record = Object.values(row)[0];
  const string = record.replace(/\"/g,'\'').replace(/\'\'/g,'\"')
  const values = string.match(/('.*?'|[^',\s]+)(?=\s*,|\s*$)/g)

  const id = values[0];
  let label = values[1];
  const shortCode = values[2];
  const dataType = values[3];

  if( label[0] === '\"'){
    label = label.slice(1,-1)
  }
  if (firstRowArrived) {
      sqlOutput.write(`,${os.EOL}(${id}, '${label}' , '${shortCode}', ${dataType} )`);
  }
  else {
      sqlOutput.write(`(${id}, '${label}', '${shortCode}', ${dataType})`);
  }
  firstRowArrived = true;
}).on('end', () => {
  sqlOutput.write(`;${os.EOL}`);
  sqlOutput.close();
});
