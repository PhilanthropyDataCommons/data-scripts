// Takes a pipe-separated values file and creates a canonical fields INSERT SQL file.
import fs, { WriteStream } from 'fs';
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

sqlOutput.write(`INSERT INTO canonical_fields (id, label, short_code, data_type, created_at) OVERRIDING SYSTEM VALUE VALUES${os.EOL}`);

let firstRowArrived = false;
psvInput.pipe(
  new CsvReadableStream({
    parseNumbers: true,
    parseBooleans: true,
    trim: true,
    delimiter: '|',
    asObject: true,
  }),
).on('data', (row: any) => {
  const label = row.label.replace('\'', '\'\'');
  const shortCode = row.shortCode.replace('\'', '\'\'');
  const dataType = row.dataType.replace('\'', '\'\'');
  const createdAt = row.createdAt.replace('\'', '\'\'');
  if (firstRowArrived) {
    sqlOutput.write(`,${os.EOL}(${row.id}, '${label}', '${shortCode}', '${dataType}', '${createdAt}')`);
  }
  else {
    sqlOutput.write(`(${row.id}, '${label}', '${shortCode}', '${dataType}', '${createdAt}')`);
  }
  firstRowArrived = true;
}).on('end', () => {
  sqlOutput.write(`;${os.EOL}`);
  sqlOutput.close();
});
