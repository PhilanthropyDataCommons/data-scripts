// Takes a comma-separated values (CSV) file and creates a canonical fields INSERT SQL file.
// The CSV is usually derived from the following URL using xlsx export and `xslx2csv`:
// https://docs.google.com/spreadsheets/d/1Ep3_MEIyIbhxJ5TpH5x4Q1fRZqr1CFHXZ_uv3fEOSEk
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

interface CsvRow {
  Label: string,
  'Internal field name' : string,
  Type: string
}

const csvInput = fs.createReadStream(args.inputFile, 'utf8');
const sqlOutput = fs.createWriteStream(args.outputFile, 'utf8');

sqlOutput.write(`INSERT INTO base_fields (label, short_code, data_type) VALUES${os.EOL}`);

let firstRowArrived = false;
csvInput.pipe(
  new CsvReadableStream({
    parseNumbers: true,
    parseBooleans: true,
    trim: true,
    allowQuotes: true,
    asObject: true,
  }),
).on('data', (row: CsvRow) => {
  const label = row.Label;
  const shortCode = row['Internal field name'];
  const dataType = row.Type;

  if (firstRowArrived) {
    sqlOutput.write(`,${os.EOL}('${label}', '${shortCode}', '${dataType}' )`);
  } else {
    sqlOutput.write(`('${label}', '${shortCode}', '${dataType}' )`);
  }
  firstRowArrived = true;
}).on('end', () => {
  sqlOutput.write(`;${os.EOL}`);
  sqlOutput.close();
});
