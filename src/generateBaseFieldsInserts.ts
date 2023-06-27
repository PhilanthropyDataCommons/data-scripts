// Takes a comma-separated values (CSV) file and creates a canonical fields INSERT SQL file.
// The CSV is usually derived from the following URL using xlsx export and `xslx2csv`:
// https://docs.google.com/spreadsheets/d/1Ep3_MEIyIbhxJ5TpH5x4Q1fRZqr1CFHXZ_uv3fEOSEk
import {
  createWriteStream,
  readFileSync,
} from 'fs';
import { EOL } from 'os';
import { AssertionError } from 'assert';
import { parse as csvParse } from 'csv-parse/sync';
import { parse } from 'ts-command-line-args';
import { assertIsCsvRow } from './csv';
import { logger } from './logger';

interface Args {
  inputFile: string;
  outputFile: string;
}

const args = parse<Args>({
  inputFile: String,
  outputFile: String,
});

const csvParser = csvParse(readFileSync(args.inputFile, 'utf8'), {
  columns: true,
  skip_records_with_empty_values: true,
}) as unknown[];
const sqlOutput = createWriteStream(args.outputFile, 'utf8');

sqlOutput.write(`INSERT INTO base_fields (label, short_code, data_type) VALUES${EOL}`);

let firstRowArrived = false;

Promise.all(csvParser.map((row) => {
  assertIsCsvRow(row);
  const label = row.Label;
  if (typeof label !== 'string') {
    throw new AssertionError({ message: 'Expected label to be a string' });
  }
  const shortCode = row['Internal field name'];
  if (typeof shortCode !== 'string') {
    throw new AssertionError({ message: 'Expected shortCode to be a string' });
  }
  const dataType = row.Type;
  if (typeof dataType !== 'string') {
    throw new AssertionError({ message: 'Expected dataType to be a string' });
  }

  if (firstRowArrived) {
    return `,${EOL}('${label}', '${shortCode}', '${dataType}' )`;
  }
  firstRowArrived = true;
  return `('${label}', '${shortCode}', '${dataType}' )`;
})).then((insertStatements) => {
  insertStatements.forEach((statement) => sqlOutput.write(statement));
  sqlOutput.write(`;${EOL}`);
  sqlOutput.close();
}).catch((error: unknown) => {
  logger.error(error, 'Error while reading CSV or writing SQL.');
});
