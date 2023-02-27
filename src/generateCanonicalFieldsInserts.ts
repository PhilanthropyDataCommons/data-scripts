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

const csvInput = fs.createReadStream(args.inputFile, 'utf8');
const sqlOutput = fs.createWriteStream(args.outputFile, 'utf8');

sqlOutput.write(`INSERT INTO canonical_fields (id, label, short_code, data_type) OVERRIDING SYSTEM VALUE VALUES${os.EOL}`);

let firstRowArrived = false;
csvInput.pipe(
  new CsvReadableStream({
    parseNumbers: true,
    parseBooleans: true,
    trim: true,
    allowQuotes: true,
    asObject: true,
  }),
).on('data', (row: any) => {
  const rowID = row['ID'];
  const label = row['Label'];
  const shortCode = row['Internal field name'];
  const dataType = row['Type'];

  if (firstRowArrived) {
    sqlOutput.write(`,${os.EOL}(${rowID}, '${label}' , '${shortCode}', '${dataType}' )`);
  }
  else {
    sqlOutput.write(`(${rowID}, '${label}', '${shortCode}', '${dataType}' )`);
  }
  firstRowArrived = true;
}).on('end', () => {
  sqlOutput.write(`;${os.EOL}`);
  sqlOutput.close();
});
