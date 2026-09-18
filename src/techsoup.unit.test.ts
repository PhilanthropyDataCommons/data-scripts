import { describe, expect, it } from '@jest/globals';
import { extractEin, extractGoodAsOf, getFrontmatterValue, parseFrontmatter, toFieldValueString } from './okf.js';
import { getChangemakerByEin, selectChangemakers } from './techsoup.js';
import type { Changemaker, ChangemakerBundle } from '@pdc/sdk';

// Minimal Changemaker fixture; the helpers under test only read `id`/`taxId`,
// but the SDK type requires the full shape, so fill the rest with inert defaults.
const makeChangemaker = (id: number, taxId: string): Changemaker => ({
  id,
  taxId,
  name: `Org ${id}`,
  createdAt: '2024-01-01T00:00:00Z',
  createdBy: 'test',
  fiscalSponsors: [],
  fields: [],
});

// A trimmed-down but structurally faithful OKF README frontmatter (nested block
// map, flow sequences, an inline flow map, a block sequence of mappings, and a
// trailing comment) to exercise the whole minimal parser.
const README_FRONTMATTER = `---
type: org
title: "synthetic-Black Mountain Workforce Partnership"
description: "A fabricated post-coal workforce training organization."
aliases: ["synthetic-Black Mountain Workforce", "Black Mountain Workforce Partnership"]
synthetic: true
status: stable
generated: { by: claude-code/claude-opus-5, at: 2026-07-29T00:00:00Z }
sources:
  - id: org-site
    resource: "https://example.org"
    last_modified: 2026-03-02
  - id: registry
    resource: "simulated registry extract"
    last_modified: 2026-01-15
x-civic:
  # ---- REQUIRED by civic/0.6. ----
  profile: civic/0.6
  registration_country: US
  registration:
    scheme: "IRS-EIN"
    id: "00-1000008"
    tax_status: "501(c)(3)"
  ntee: ["J22"]      # optional US-only layer
  situation: US-KY-letcher
  verifiable_by: [techsoup]
---

# Body content that must be ignored by the parser.
`;

describe('parseFrontmatter', () => {
  const fm = parseFrontmatter(README_FRONTMATTER);

  it('parses top-level scalars', () => {
    expect(fm.type).toBe('org');
    expect(fm.title).toBe('synthetic-Black Mountain Workforce Partnership');
    expect(fm.status).toBe('stable');
  });

  it('parses a flow sequence of quoted strings', () => {
    expect(fm.aliases).toStrictEqual(['synthetic-Black Mountain Workforce', 'Black Mountain Workforce Partnership']);
  });

  it('parses an inline flow mapping', () => {
    expect(fm.generated).toStrictEqual({ by: 'claude-code/claude-opus-5', at: '2026-07-29T00:00:00Z' });
  });

  it('parses a nested block mapping under x-civic', () => {
    expect(getFrontmatterValue(fm, 'x-civic.registration.scheme')).toBe('IRS-EIN');
    expect(getFrontmatterValue(fm, 'x-civic.registration.id')).toBe('00-1000008');
    expect(getFrontmatterValue(fm, 'x-civic.registration_country')).toBe('US');
    expect(getFrontmatterValue(fm, 'x-civic.situation')).toBe('US-KY-letcher');
  });

  it('consumes a block sequence of mappings without disturbing later keys', () => {
    expect(Array.isArray(fm.sources)).toBe(true);
    expect(getFrontmatterValue(fm, 'x-civic.ntee')).toStrictEqual(['J22']);
    expect(getFrontmatterValue(fm, 'x-civic.verifiable_by')).toStrictEqual(['techsoup']);
  });

  it('strips a trailing comment from a value', () => {
    expect(getFrontmatterValue(fm, 'x-civic.ntee')).toStrictEqual(['J22']);
  });

  it('returns an empty object when there is no frontmatter', () => {
    expect(parseFrontmatter('# Just a heading\n\nSome text.')).toStrictEqual({});
  });
});

describe('getFrontmatterValue', () => {
  const fm = { a: { b: { c: 'deep' } }, list: [1, 2] };

  it('follows a dotted path', () => {
    expect(getFrontmatterValue(fm, 'a.b.c')).toBe('deep');
  });

  it('returns undefined for a missing key', () => {
    expect(getFrontmatterValue(fm, 'a.b.x')).toBeUndefined();
  });

  it('returns undefined when descending into a non-object', () => {
    expect(getFrontmatterValue(fm, 'a.b.c.d')).toBeUndefined();
  });

  it('returns undefined when descending into an array', () => {
    expect(getFrontmatterValue(fm, 'list.0')).toBeUndefined();
  });
});

describe('toFieldValueString', () => {
  it('trims a string', () => {
    expect(toFieldValueString('  hello  ')).toBe('hello');
  });

  it('returns null for an empty or whitespace-only string', () => {
    expect(toFieldValueString('   ')).toBeNull();
  });

  it('returns null for null and undefined', () => {
    expect(toFieldValueString(null)).toBeNull();
    expect(toFieldValueString(undefined)).toBeNull();
  });

  it('stringifies numbers and booleans', () => {
    expect(toFieldValueString(42)).toBe('42');
    expect(toFieldValueString(true)).toBe('true');
  });

  it('joins array values with a separator, dropping empties', () => {
    expect(toFieldValueString(['a', '', 'b'])).toBe('a; b');
  });

  it('returns null for an empty array', () => {
    expect(toFieldValueString([])).toBeNull();
  });

  it('returns null for a plain object', () => {
    expect(toFieldValueString({ a: 1 })).toBeNull();
  });
});

describe('extractEin', () => {
  it('returns a valid EIN when the scheme is IRS-EIN', () => {
    expect(extractEin({ 'x-civic': { registration: { scheme: 'IRS-EIN', id: '00-1000008' } } })).toBe('00-1000008');
  });

  it('returns the EIN when no scheme is declared but the id is a valid EIN', () => {
    expect(extractEin({ 'x-civic': { registration: { id: '12-3456789' } } })).toBe('12-3456789');
  });

  it('returns null for a non-IRS scheme (e.g. Polish KRS)', () => {
    expect(extractEin({ 'x-civic': { registration: { scheme: 'KRS', id: '0000000000' } } })).toBeNull();
  });

  it('returns null when the id is not a valid EIN', () => {
    expect(extractEin({ 'x-civic': { registration: { scheme: 'IRS-EIN', id: 'not-an-ein' } } })).toBeNull();
  });

  it('returns null when there is no registration id', () => {
    expect(extractEin({ 'x-civic': { registration: {} } })).toBeNull();
  });
});

describe('extractGoodAsOf', () => {
  it('extracts the date from a generated.at timestamp', () => {
    expect(extractGoodAsOf({ generated: { at: '2026-07-29T00:00:00Z' } })).toBe('2026-07-29');
  });

  it('returns null when generated.at is missing', () => {
    expect(extractGoodAsOf({ generated: {} })).toBeNull();
  });

  it('returns null when generated.at is not a parseable date', () => {
    expect(extractGoodAsOf({ generated: { at: 'sometime' } })).toBeNull();
  });
});

describe('getChangemakerByEin', () => {
  const bundle: ChangemakerBundle = {
    entries: [makeChangemaker(1, '00-1000008'), makeChangemaker(2, '223456789')],
    total: 2,
  };

  it('matches ignoring a hyphen', () => {
    expect(getChangemakerByEin('001000008', bundle)?.id).toBe(1);
    expect(getChangemakerByEin('22-3456789', bundle)?.id).toBe(2);
  });

  it('returns null when there is no match', () => {
    expect(getChangemakerByEin('99-9999999', bundle)).toBeNull();
  });

  it('returns null when more than one changemaker matches', () => {
    const ambiguous: ChangemakerBundle = {
      entries: [makeChangemaker(1, '00-1000008'), makeChangemaker(2, '001000008')],
      total: 2,
    };
    expect(getChangemakerByEin('00-1000008', ambiguous)).toBeNull();
  });
});

describe('selectChangemakers', () => {
  const bundle: ChangemakerBundle = {
    entries: [makeChangemaker(1, '11-1111111'), makeChangemaker(2, '22-2222222')],
    total: 2,
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
});
