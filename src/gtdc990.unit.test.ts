import { describe, expect, it } from '@jest/globals';
import {
  extractResultsFromResponse,
  isBmfRecord,
  parseGivingTuesdayDate,
  selectChangemakers,
  toGivingTuesdayEin,
} from './gtdc990.js';
import type { Changemaker, ChangemakerBundle } from '@pdc/sdk';

// Minimal Changemaker fixture; selectChangemakers only reads `id`, but the SDK
// type requires the full shape, so fill the rest with inert defaults.
const makeChangemaker = (id: number, taxId: string): Changemaker => ({
  id,
  taxId,
  name: `Org ${id}`,
  createdAt: '2024-01-01T00:00:00Z',
  createdBy: 'test',
  fiscalSponsors: [],
  fields: [],
});

describe('toGivingTuesdayEin', () => {
  it('strips a hyphen', () => {
    expect(toGivingTuesdayEin('84-2929872')).toBe('842929872');
  });

  it('leaves an already-normalized EIN unchanged', () => {
    expect(toGivingTuesdayEin('842929872')).toBe('842929872');
  });

  it('zero-pads a short EIN to nine digits', () => {
    expect(toGivingTuesdayEin('100514')).toBe('000100514');
  });
});

describe('parseGivingTuesdayDate', () => {
  it('converts a zero-padded YYYY_MM_DD value to ISO', () => {
    expect(parseGivingTuesdayDate('2024_02_13')).toBe('2024-02-13');
  });

  it('zero-pads single-digit month and day', () => {
    expect(parseGivingTuesdayDate('2024_4_4')).toBe('2024-04-04');
  });

  it('returns null for null input', () => {
    expect(parseGivingTuesdayDate(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseGivingTuesdayDate(undefined)).toBeNull();
  });

  it('returns null for an unparseable value', () => {
    expect(parseGivingTuesdayDate('not-a-date')).toBeNull();
  });
});

describe('isBmfRecord', () => {
  it('accepts a record with a string ein and organization name', () => {
    expect(isBmfRecord({ ein: '842929872', primary_name_of_organization: 'GIVING TUESDAY INC' })).toBe(true);
  });

  it('rejects a record missing the organization name', () => {
    expect(isBmfRecord({ ein: '842929872' })).toBe(false);
  });

  it('rejects a record with a non-string ein', () => {
    expect(isBmfRecord({ ein: 842929872, primary_name_of_organization: 'GIVING TUESDAY INC' })).toBe(false);
  });
});

describe('extractResultsFromResponse', () => {
  const record = { ein: '842929872', primary_name_of_organization: 'GIVING TUESDAY INC' };
  const validResponse = {
    statusCode: 200,
    body: { query: '842929872', no_results: 1, results: [record] },
  };

  it('returns the results array when the response is well-formed', () => {
    expect(extractResultsFromResponse(validResponse, '842929872')).toStrictEqual([record]);
  });

  it('returns an empty array when there are no results', () => {
    const empty = { statusCode: 200, body: { query: '000000001', no_results: 0, results: [] } };
    expect(extractResultsFromResponse(empty, '000000001')).toStrictEqual([]);
  });

  it('throws a clear error when the response is null', () => {
    expect(() => extractResultsFromResponse(null, '842929872')).toThrow(
      /GivingTuesday query returned no data for EIN 842929872/v,
    );
  });

  it('throws a clear error when the response is undefined', () => {
    expect(() => extractResultsFromResponse(undefined, '842929872')).toThrow(
      /GivingTuesday query returned no data for EIN 842929872/v,
    );
  });

  it('throws a clear error when the body is missing', () => {
    /* eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion --
    simulate a malformed runtime response where body is absent. */
    const malformed = { statusCode: 502 } as unknown as Parameters<typeof extractResultsFromResponse>[0];
    expect(() => extractResultsFromResponse(malformed, '842929872')).toThrow(/malformed response for EIN 842929872/v);
  });

  it('throws a clear error when results is not an array', () => {
    /* eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion --
    simulate a malformed runtime response where results is not an array. */
    const malformed = {
      statusCode: 200,
      body: { query: '842929872', no_results: 1, results: null },
    } as unknown as Parameters<typeof extractResultsFromResponse>[0];
    expect(() => extractResultsFromResponse(malformed, '842929872')).toThrow(/malformed response for EIN 842929872/v);
  });
});

describe('selectChangemakers', () => {
  const bundle: ChangemakerBundle = {
    entries: [makeChangemaker(1, '11-1111111'), makeChangemaker(2, '22-2222222'), makeChangemaker(3, '33-3333333')],
    total: 3,
  };

  it('returns the full bundle unchanged when no ID is supplied', () => {
    expect(selectChangemakers(bundle, undefined)).toBe(bundle);
  });

  it('scopes to the single matching changemaker and updates total', () => {
    const result = selectChangemakers(bundle, 2);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toBe(2);
    expect(result.total).toBe(1);
  });

  it('returns an empty bundle with total 0 for an unknown ID', () => {
    const result = selectChangemakers(bundle, 999);
    expect(result.entries).toStrictEqual([]);
    expect(result.total).toBe(0);
  });

  it('does not mutate the original bundle when filtering', () => {
    selectChangemakers(bundle, 2);
    expect(bundle.entries).toHaveLength(3);
    expect(bundle.total).toBe(3);
  });
});
