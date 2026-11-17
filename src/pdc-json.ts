import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { isValidEin } from './ein.js';
import { type MappedField, type TechSoupDocument, toFieldValueString } from './fields.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The provenance note for a `_pdc.json` field: its `batch.notes`, or null. */
const extractFieldNote = (field: Record<string, unknown>): string | null => {
  const { batch } = field;
  if (isRecord(batch) && typeof batch.notes === 'string' && batch.notes.trim() !== '') {
    return batch.notes;
  }
  return null;
};

/** The changemaker name carried by a `_pdc.json` document (`changemaker.name`), or null. */
const extractChangemakerName = (raw: Record<string, unknown>): string | null => {
  const { changemaker } = raw;
  if (isRecord(changemaker)) {
    return toFieldValueString(changemaker.name);
  }
  return null;
};

/** Convert one `_pdc.json` field entry to a `MappedField`, or null when malformed/empty. */
const toMappedField = (field: unknown): MappedField | null => {
  if (!isRecord(field) || typeof field.baseFieldShortCode !== 'string') {
    return null;
  }
  const value = toFieldValueString(field.value);
  if (value === null) {
    return null;
  }
  return {
    baseFieldShortCode: field.baseFieldShortCode,
    value,
    sourceNote: extractFieldNote(field) ?? field.baseFieldShortCode,
  };
};

/** The usable entries of a `_pdc.json` `fields[]` array (malformed or empty ones are dropped). */
const parsePdcJsonFields = (raw: unknown): MappedField[] => {
  if (!isRecord(raw) || !Array.isArray(raw.fields)) {
    return [];
  }
  return raw.fields.map(toMappedField).filter((field): field is MappedField => field !== null);
};

/**
 * Convert one parsed `_pdc.json` document into a `TechSoupDocument`. The EIN is
 * taken from the `organization_tax_id` field and only kept when it is a valid
 * US EIN (so non-US ids like Poland's `0000000000` yield null).
 * `goodAsOf` is always null — the exporter output carries no generation date.
 */
const pdcJsonToDocument = (raw: unknown, slug: string): TechSoupDocument => {
  const fields = parsePdcJsonFields(raw);
  const taxIdValue = fields.find((f) => f.baseFieldShortCode === 'organization_tax_id')?.value ?? null;
  return {
    slug,
    ein: taxIdValue !== null && isValidEin(taxIdValue) ? taxIdValue : null,
    name: isRecord(raw) ? extractChangemakerName(raw) : null,
    goodAsOf: null,
    fields,
  };
};

/** The slug for a `_pdc.json` file: its basename with the `_pdc.json`/`.json` suffix removed. */
const slugForJsonFile = (filePath: string): string =>
  basename(filePath)
    .replace(/_pdc\.json$/iv, '')
    .replace(/\.json$/iv, '');

/**
 * Validate one parsed JSON value as a TechSoup PDC JSON document and normalize
 * it. Throws when it is not `{ changemaker?, fields: [...] }` shaped, so a wrong
 * file fails loudly instead of importing nothing.
 */
const parsePdcJsonDocument = (raw: unknown, slug: string): TechSoupDocument => {
  if (!isRecord(raw) || !Array.isArray(raw.fields)) {
    throw new Error(`${slug} is not a TechSoup PDC JSON document (expected an object with a "fields" array)`);
  }
  return pdcJsonToDocument(raw, slug);
};

/** Read and normalize the single TechSoup PDC JSON file at `filePath` (the import's only input). */
const readPdcJsonFile = async (filePath: string): Promise<TechSoupDocument> => {
  const content = await readFile(filePath, 'utf8');
  return parsePdcJsonDocument(JSON.parse(content), slugForJsonFile(filePath));
};

export { parsePdcJsonDocument, pdcJsonToDocument, readPdcJsonFile };
