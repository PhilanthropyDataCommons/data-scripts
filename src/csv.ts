import { AssertionError } from 'assert';

export type CsvRow = Record<string, string>;

export function assertIsCsvRow(row: unknown): asserts row is CsvRow {
  if (row === null
    || typeof row !== 'object'
    || Object.keys(row).length === 0
    || Object.keys(row).some((key) => typeof key !== 'string')
    || Object.values(row).some((value) => typeof value !== 'string')) {
    throw new AssertionError({ message: 'Given row is not a CsvRow!' });
  }
}
