import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { AxiosError, AxiosHeaders } from 'axios';
import {
  applyBaseFieldCategories,
  formatImportPreview,
  planImport,
  resolveChangemaker,
  selectTechSoupSource,
  toChangemakerTarget,
} from './changemakers.js';
import { toFieldValueString } from './fields.js';
import { toLoggableError } from './logger.js';
import { parsePdcJsonDocument, pdcJsonToDocument, readPdcJsonFile } from './pdc-json.js';
import type { TechSoupDocument, TechSoupPackage } from './fields.js';
import type { Changemaker, ChangemakerBundle, Source } from '@pdc/sdk';

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

// Minimal Source fixture; `selectTechSoupSource` only reads `id` and
// `dataProviderShortCode`, the rest are inert defaults the SDK type requires.
const makeSource = (id: number, dataProviderShortCode: string): Source => ({
  id,
  label: `Source ${id}`,
  createdAt: '2024-01-01T00:00:00Z',
  createdBy: 'test',
  dataProviderShortCode,
  dataProvider: {
    shortCode: dataProviderShortCode,
    name: dataProviderShortCode,
    keycloakOrganizationId: '',
    createdAt: '2024-01-01T00:00:00Z',
    createdBy: 'test',
  },
  funderShortCode: '',
  funder: { shortCode: '', name: '', createdAt: '2024-01-01T00:00:00Z', createdBy: 'test', isCollaborative: false },
  changemakerId: 0,
  changemaker: makeChangemaker(0, ''),
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

describe('resolveChangemaker', () => {
  const bundle: ChangemakerBundle = {
    entries: [makeChangemaker(1, '00-1000008'), makeChangemaker(2, '22-3456789')],
    total: 2,
  };

  it('resolves a unique match (hyphen-insensitive)', () => {
    const resolution = resolveChangemaker('001000008', bundle);
    expect(resolution.kind).toBe('matched');
    expect(resolution.kind === 'matched' ? resolution.changemaker.id : null).toBe(1);
  });

  it('resolves to missing when there is no match', () => {
    expect(resolveChangemaker('99-9999999', bundle).kind).toBe('missing');
  });

  it('resolves to ambiguous when more than one changemaker matches', () => {
    const ambiguous: ChangemakerBundle = {
      entries: [makeChangemaker(1, '00-1000008'), makeChangemaker(2, '001000008')],
      total: 2,
    };
    expect(resolveChangemaker('00-1000008', ambiguous).kind).toBe('ambiguous');
  });
});

describe('toChangemakerTarget', () => {
  it('targets a new changemaker when --create-changemaker is set', () => {
    expect(toChangemakerTarget(true, undefined)).toStrictEqual({ kind: 'create' });
  });

  it('targets the explicit ID when --changemaker-id is given', () => {
    expect(toChangemakerTarget(false, 7)).toStrictEqual({ kind: 'id', changemakerId: 7 });
  });

  it('falls back to EIN matching when neither flag is given', () => {
    expect(toChangemakerTarget(false, undefined)).toStrictEqual({ kind: 'ein' });
  });
});

// A normalized package as read from a single PDC JSON file.
const makePackage = (overrides: Partial<TechSoupPackage> = {}): TechSoupPackage => ({
  slug: 'synthetic-org',
  ein: '00-1000008',
  name: 'Synthetic Org',
  goodAsOf: null,
  organizationFields: [
    { baseFieldShortCode: 'organization_name', value: 'Synthetic Org', sourceNote: 'README.md#title' },
    { baseFieldShortCode: 'organization_tax_id', value: '00-1000008', sourceNote: 'organization_tax_id' },
  ],
  proposalFields: [],
  ...overrides,
});

describe('planImport', () => {
  const bundle: ChangemakerBundle = {
    entries: [makeChangemaker(1, '001000008'), makeChangemaker(2, '22-3456789')],
    total: 2,
  };
  const ambiguous: ChangemakerBundle = {
    entries: [makeChangemaker(1, '00-1000008'), makeChangemaker(2, '001000008')],
    total: 2,
  };
  const empty: ChangemakerBundle = { entries: [], total: 0 };

  describe('matching by EIN (default)', () => {
    it('updates the changemaker whose taxId matches the file EIN', () => {
      const plan = planImport(makePackage(), bundle, { kind: 'ein' });
      expect(plan.action).toBe('update');
      expect(plan.action === 'update' ? plan.changemaker.id : null).toBe(1);
    });

    it('skips when the EIN is not in the PDC, pointing at --create-changemaker', () => {
      const plan = planImport(makePackage({ ein: '99-9999999' }), bundle, { kind: 'ein' });
      expect(plan.action).toBe('skip');
      expect(plan.action === 'skip' ? plan.reason : '').toContain('--create-changemaker');
    });

    it('skips when the EIN matches more than one changemaker', () => {
      const plan = planImport(makePackage(), ambiguous, { kind: 'ein' });
      expect(plan.action).toBe('skip');
      expect(plan.action === 'skip' ? plan.reason : '').toContain('multiple');
    });

    it('skips when the file has no valid EIN', () => {
      const plan = planImport(makePackage({ ein: null }), bundle, { kind: 'ein' });
      expect(plan.action).toBe('skip');
      expect(plan.action === 'skip' ? plan.reason : '').toContain('--changemaker-id');
    });
  });

  describe('explicit --changemaker-id', () => {
    it('updates the changemaker with that ID, regardless of EIN', () => {
      const plan = planImport(makePackage(), bundle, { kind: 'id', changemakerId: 2 });
      expect(plan.action === 'update' ? plan.changemaker.id : null).toBe(2);
    });

    it('works when the file has no EIN', () => {
      const plan = planImport(makePackage({ ein: null }), bundle, { kind: 'id', changemakerId: 1 });
      expect(plan.action === 'update' ? plan.changemaker.id : null).toBe(1);
    });

    it('skips when no changemaker has that ID', () => {
      const plan = planImport(makePackage(), bundle, { kind: 'id', changemakerId: 999 });
      expect(plan.action).toBe('skip');
      expect(plan.action === 'skip' ? plan.reason : '').toContain('999');
    });
  });

  describe('--create-changemaker', () => {
    it('plans a create with the file EIN (verbatim) and name when the EIN is new', () => {
      expect(planImport(makePackage(), empty, { kind: 'create' })).toStrictEqual({
        action: 'create',
        taxId: '00-1000008',
        name: 'Synthetic Org',
      });
    });

    it('refuses to create a duplicate when the EIN already exists', () => {
      const plan = planImport(makePackage(), bundle, { kind: 'create' });
      expect(plan.action).toBe('skip');
      expect(plan.action === 'skip' ? plan.reason : '').toContain('changemaker 1');
    });

    it('refuses to create when the EIN already matches several changemakers', () => {
      expect(planImport(makePackage(), ambiguous, { kind: 'create' }).action).toBe('skip');
    });

    it('skips when the file has no name', () => {
      const plan = planImport(makePackage({ name: null }), empty, { kind: 'create' });
      expect(plan.action).toBe('skip');
      expect(plan.action === 'skip' ? plan.reason : '').toContain('name');
    });

    it('skips when the file has no valid EIN', () => {
      expect(planImport(makePackage({ ein: null }), empty, { kind: 'create' }).action).toBe('skip');
    });
  });
});

describe('applyBaseFieldCategories', () => {
  // Only `shortCode` and `category` are read.
  const makeBaseField = (shortCode: string, category: string): { shortCode: string; category: string } => ({
    shortCode,
    category,
  });
  const field = (baseFieldShortCode: string): { baseFieldShortCode: string; value: string; sourceNote: string } => ({
    baseFieldShortCode,
    value: 'v',
    sourceNote: baseFieldShortCode,
  });
  const baseFields = {
    entries: [
      makeBaseField('organization_name', 'organization'),
      makeBaseField('community_definition_overview', 'project'),
      makeBaseField('proposal_name', 'project'),
    ],
    total: 3,
  };
  const doc: TechSoupDocument = {
    slug: 'example',
    ein: null,
    name: null,
    goodAsOf: null,
    fields: [
      field('organization_name'),
      field('proposal_name'),
      field('community_definition_overview'),
      field('not_a_base_field'),
    ],
  };

  it('keeps only organization-category fields for the changemaker', () => {
    expect(applyBaseFieldCategories(doc, baseFields).organizationFields.map((f) => f.baseFieldShortCode)).toStrictEqual(
      ['organization_name'],
    );
  });

  it('sends fields of other categories to the proposal fields, whatever their prefix', () => {
    expect(applyBaseFieldCategories(doc, baseFields).proposalFields.map((f) => f.baseFieldShortCode)).toStrictEqual([
      'proposal_name',
      'community_definition_overview',
    ]);
  });

  it('drops fields that are not base fields in the PDC', () => {
    const result = applyBaseFieldCategories(doc, baseFields);
    const codes = [...result.organizationFields, ...result.proposalFields].map((f) => f.baseFieldShortCode);
    expect(codes).not.toContain('not_a_base_field');
  });
});

describe('formatImportPreview', () => {
  const pkg = makePackage({
    proposalFields: [{ baseFieldShortCode: 'proposal_name', value: 'A funding ask', sourceNote: 'proposal_name' }],
  });

  it('names the existing target changemaker and lists every field to import', () => {
    const lines = formatImportPreview(pkg, { action: 'update', changemaker: makeChangemaker(1, '00-1000008') });
    expect(lines[0]).toBe('synthetic-org → changemaker 1 ("Org 1", taxId 00-1000008)');
    expect(lines).toContain('Fields that would be imported (2, goodAsOf=null):');
    expect(lines).toContain('  organization_name = "Synthetic Org"  [README.md#title]');
    expect(lines).toContain('  organization_tax_id = "00-1000008"  [organization_tax_id]');
  });

  it('names a new changemaker when the plan creates one', () => {
    const lines = formatImportPreview(pkg, { action: 'create', taxId: '00-1000008', name: 'Synthetic Org' });
    expect(lines[0]).toBe('synthetic-org → NEW changemaker ("Synthetic Org", taxId 00-1000008)');
  });

  it('lists proposal fields separately as not imported', () => {
    const lines = formatImportPreview(pkg, { action: 'update', changemaker: makeChangemaker(1, '00-1000008') });
    expect(lines).toContain('Proposal (non-organization) fields NOT imported (1):');
    expect(lines).toContain('  proposal_name = "A funding ask"  [proposal_name]');
  });

  it('prints only the skip reason when nothing would be imported', () => {
    expect(formatImportPreview(pkg, { action: 'skip', reason: 'no match' })).toStrictEqual([
      'synthetic-org → nothing — no match',
    ]);
  });
});

describe('pdcJsonToDocument', () => {
  const raw = {
    changemaker: { name: 'synthetic-Black Mountain Workforce Partnership' },
    fields: [
      {
        baseFieldShortCode: 'organization_name',
        value: 'synthetic-Black Mountain Workforce Partnership',
        batch: { notes: 'slug/README.md#title' },
      },
      { baseFieldShortCode: 'organization_tax_id', value: '00-1000008' },
      { baseFieldShortCode: 'organization_dba_name', value: ['Alias One', 'Alias Two'] },
      { baseFieldShortCode: 'proposal_name', value: 'A funding ask' },
      { baseFieldShortCode: 'organization_overview', value: '   ' },
    ],
  };
  const doc = pdcJsonToDocument(raw, 'synthetic-black-mountain-workforce-partnership');

  it('takes the EIN from organization_tax_id (hyphenated, verbatim)', () => {
    expect(doc.ein).toBe('00-1000008');
  });

  it('takes the name from changemaker.name and leaves goodAsOf null', () => {
    expect(doc.name).toBe('synthetic-Black Mountain Workforce Partnership');
    expect(doc.goodAsOf).toBeNull();
  });

  it('keeps every usable field in file order, without sorting them by prefix', () => {
    expect(doc.fields.map((f) => f.baseFieldShortCode)).toStrictEqual([
      'organization_name',
      'organization_tax_id',
      'organization_dba_name',
      'proposal_name',
    ]);
  });

  it('flattens array values and uses batch.notes as the provenance note', () => {
    const dba = doc.fields.find((f) => f.baseFieldShortCode === 'organization_dba_name');
    expect(dba?.value).toBe('Alias One; Alias Two');
    const name = doc.fields.find((f) => f.baseFieldShortCode === 'organization_name');
    expect(name?.sourceNote).toBe('slug/README.md#title');
  });

  it('drops blank-valued fields', () => {
    expect(doc.fields.some((f) => f.baseFieldShortCode === 'organization_overview')).toBe(false);
  });

  it('yields a null EIN for a non-US tax id', () => {
    const polish = pdcJsonToDocument(
      {
        changemaker: { name: 'Fundacja' },
        fields: [{ baseFieldShortCode: 'organization_tax_id', value: '0000000000' }],
      },
      'synthetic-fundacja',
    );
    expect(polish.ein).toBeNull();
  });
});

describe('parsePdcJsonDocument', () => {
  it('normalizes a PDC JSON document', () => {
    const doc = parsePdcJsonDocument(
      { changemaker: { name: 'Org' }, fields: [{ baseFieldShortCode: 'organization_tax_id', value: '12-3456789' }] },
      'org',
    );
    expect(doc.ein).toBe('12-3456789');
    expect(doc.name).toBe('Org');
  });

  it('throws when the document has no fields array', () => {
    expect(() => parsePdcJsonDocument({ changemaker: { name: 'Org' } }, 'org')).toThrow('"fields" array');
  });

  it('throws when the document is not an object', () => {
    expect(() => parsePdcJsonDocument([], 'org')).toThrow('not a TechSoup PDC JSON document');
  });
});

describe('readPdcJsonFile', () => {
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'techsoup-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads one file and derives the slug from its name', async () => {
    const filePath = join(dir, 'synthetic-org_pdc.json');
    await writeFile(
      filePath,
      JSON.stringify({
        changemaker: { name: 'Synthetic Org' },
        fields: [
          { baseFieldShortCode: 'organization_name', value: 'Synthetic Org' },
          { baseFieldShortCode: 'organization_tax_id', value: '00-1000008' },
          { baseFieldShortCode: 'proposal_name', value: 'A funding ask' },
        ],
      }),
    );
    const doc = await readPdcJsonFile(filePath);
    expect(doc.slug).toBe('synthetic-org');
    expect(doc.ein).toBe('00-1000008');
    expect(doc.fields).toHaveLength(3);
  });

  it('rejects a JSON file that is not PDC-export shaped', async () => {
    const filePath = join(dir, 'package.json');
    await writeFile(filePath, JSON.stringify({ name: 'not-a-pdc-file' }));
    await expect(readPdcJsonFile(filePath)).rejects.toThrow('"fields" array');
  });

  it('rejects a file that is not valid JSON', async () => {
    const filePath = join(dir, 'broken.json');
    await writeFile(filePath, '{ not json');
    await expect(readPdcJsonFile(filePath)).rejects.toThrow(SyntaxError);
  });
});

describe('selectTechSoupSource', () => {
  it('returns the single TechSoup source', () => {
    const sources = { entries: [makeSource(1, 'charitynavigator'), makeSource(2, 'techsoup')], total: 2 };
    expect(selectTechSoupSource(sources)?.id).toBe(2);
  });

  it('returns null when there is no TechSoup source', () => {
    expect(selectTechSoupSource({ entries: [makeSource(1, 'charitynavigator')], total: 1 })).toBeNull();
  });

  it('uses the oldest (lowest ID) when several TechSoup sources exist', () => {
    const sources = { entries: [makeSource(9, 'techsoup'), makeSource(4, 'techsoup')], total: 2 };
    expect(selectTechSoupSource(sources)?.id).toBe(4);
  });
});

describe('toLoggableError', () => {
  const NOT_FOUND = 404;
  const config = {
    method: 'post',
    url: 'https://api.example.org/sources',
    headers: new AxiosHeaders({ Authorization: 'Bearer secret-token' }),
  };
  const axiosError = new AxiosError('Request failed with status code 404', 'ERR_BAD_REQUEST', config, null, {
    data: { name: 'NotFoundError', message: 'Entity not found' },
    status: NOT_FOUND,
    statusText: 'Not Found',
    headers: {},
    config,
  });

  it('keeps the status, method, URL, and response body of an AxiosError', () => {
    expect(toLoggableError(axiosError)).toStrictEqual({
      name: 'AxiosError',
      message: 'Request failed with status code 404',
      code: 'ERR_BAD_REQUEST',
      status: NOT_FOUND,
      method: 'post',
      url: 'https://api.example.org/sources',
      responseData: { name: 'NotFoundError', message: 'Entity not found' },
    });
  });

  it('drops the request headers, so the bearer token is never logged', () => {
    expect(JSON.stringify(toLoggableError(axiosError))).not.toContain('secret-token');
  });

  it('reduces an AxiosError found in an Error cause', () => {
    const wrapped = new Error('Cannot create the TechSoup source', { cause: axiosError });
    const loggable = toLoggableError(wrapped);
    expect(JSON.stringify(loggable)).not.toContain('secret-token');
    expect(loggable).toMatchObject({ message: 'Cannot create the TechSoup source', cause: { status: NOT_FOUND } });
  });

  it('passes non-Error values through unchanged', () => {
    expect(toLoggableError('plain string')).toBe('plain string');
    expect(toLoggableError(undefined)).toBeUndefined();
  });
});
