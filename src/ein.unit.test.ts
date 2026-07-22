import { describe, expect, it } from '@jest/globals';
import { isValidEin } from './ein.js';

describe('isValidEin', () => {
  it('accepts a hyphenated EIN', () => {
    expect(isValidEin('12-3456789')).toBe(true);
  });

  it('accepts an unhyphenated EIN', () => {
    expect(isValidEin('123456789')).toBe(true);
  });

  it('rejects an EIN with too few digits', () => {
    expect(isValidEin('12-345')).toBe(false);
  });

  it('rejects an EIN with too many digits', () => {
    expect(isValidEin('123-4567890')).toBe(false);
  });

  it('rejects a non-numeric string', () => {
    expect(isValidEin('ab-cdefghi')).toBe(false);
  });
});
