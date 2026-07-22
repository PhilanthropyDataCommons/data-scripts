import { AssertionError } from 'node:assert';
import { describe, expect, it } from '@jest/globals';
import { assertIsCsvRow } from './csv.js';

describe('assertIsCsvRow', () => {
  it('accepts a non-empty record of string values', () => {
    expect(() => {
      assertIsCsvRow({ a: '1' });
    }).not.toThrow();
  });

  it('throws an AssertionError for null', () => {
    expect(() => {
      assertIsCsvRow(null);
    }).toThrow(AssertionError);
  });

  it('throws an AssertionError for an empty object', () => {
    expect(() => {
      assertIsCsvRow({});
    }).toThrow(AssertionError);
  });

  it('throws an AssertionError for a non-string value', () => {
    expect(() => {
      assertIsCsvRow({ a: 1 });
    }).toThrow(AssertionError);
  });
});
