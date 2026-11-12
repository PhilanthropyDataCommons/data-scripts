import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isValidEin } from './ein.js';
import { type MappedField, type TechSoupPackage, isProposalField, toFieldValueString } from './fields.js';
import { logger } from './logger.js';

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

interface ParsedFields {
  organizationFields: MappedField[];
  proposalFields: MappedField[];
  taxIdValue: string | null;
}

/** Split a `_pdc.json` `fields[]` array into organization/proposal `MappedField`s and capture the tax id. */
const parsePdcJsonFields = (raw: unknown): ParsedFields => {
  const organizationFields: MappedField[] = [];
  const proposalFields: MappedField[] = [];
  if (isRecord(raw) && Array.isArray(raw.fields)) {
    for (const field of raw.fields) {
      const mapped = toMappedField(field);
      if (mapped === null) {
        continue;
      }
      if (isProposalField(mapped.baseFieldShortCode)) {
        proposalFields.push(mapped);
      } else {
        organizationFields.push(mapped);
      }
    }
  }
  const taxIdValue = organizationFields.find((f) => f.baseFieldShortCode === 'organization_tax_id')?.value ?? null;
  return { organizationFields, proposalFields, taxIdValue };
};

/**
 * Convert one parsed `_pdc.json` document into a normalized package. The EIN is
 * taken from the `organization_tax_id` field and only kept when it is a valid
 * US EIN (so non-US ids like Poland's `0000000000` yield null, as with OKF).
 * `goodAsOf` is always null — the exporter output carries no generation date.
 */
const pdcJsonToPackage = (raw: unknown, slug: string): TechSoupPackage => {
  const { organizationFields, proposalFields, taxIdValue } = parsePdcJsonFields(raw);
  return {
    slug,
    ein: taxIdValue !== null && isValidEin(taxIdValue) ? taxIdValue : null,
    name: isRecord(raw) ? extractChangemakerName(raw) : null,
    goodAsOf: null,
    organizationFields,
    proposalFields,
  };
};

/** The slug for a `_pdc.json` file: its basename with the `_pdc.json`/`.json` suffix removed. */
const slugForJsonFile = (filePath: string): string =>
  basename(filePath)
    .replace(/_pdc\.json$/iv, '')
    .replace(/\.json$/iv, '');

/** Recursively collect every `.json` file under `root`. */
const findJsonFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries === null) {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop -- sequential recursion bounds open file handles
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        files.push(full);
      }
    }
  };
  await walk(root);
  return files;
};

/** Read one JSON file, returning its parsed content or null when unreadable/not JSON. */
const readJsonFile = async (filePath: string): Promise<unknown> => {
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error: unknown) {
    logger.debug({ error, filePath }, 'Could not read/parse JSON file');
    return null;
  }
};

/**
 * Read every TechSoup exporter `_pdc.json` document under `root` and return the
 * normalized packages. `.json` files that are not PDC-export shaped (no `fields`
 * array) are skipped, so unrelated JSON (package.json, config, …) is ignored.
 * Results are sorted by slug for stable output.
 */
const readPdcJsonPackages = async (root: string): Promise<TechSoupPackage[]> => {
  const files = await findJsonFiles(root);
  const packages: TechSoupPackage[] = [];
  /* eslint-disable no-await-in-loop -- sequential reads bound concurrent file handles */
  for (const file of files) {
    const raw = await readJsonFile(file);
    if (!isRecord(raw) || !Array.isArray(raw.fields)) {
      continue;
    }
    packages.push(pdcJsonToPackage(raw, slugForJsonFile(file)));
  }
  /* eslint-enable no-await-in-loop */
  return packages.sort((a, b) => a.slug.localeCompare(b.slug));
};

/**
 * Validate one parsed JSON document as a single PDC-export package and normalize
 * it. Throws when the document is not `{ changemaker?, fields: [...] }` shaped,
 * so a wrong file fails loudly instead of importing nothing.
 */
const parsePdcJsonPackage = (raw: unknown, slug: string): TechSoupPackage => {
  if (!isRecord(raw) || !Array.isArray(raw.fields)) {
    throw new Error(`${slug} is not a TechSoup PDC JSON document (expected an object with a "fields" array)`);
  }
  return pdcJsonToPackage(raw, slug);
};

/** Read and normalize the single TechSoup PDC JSON file at `filePath` (the import's only input). */
const readPdcJsonFile = async (filePath: string): Promise<TechSoupPackage> => {
  const content = await readFile(filePath, 'utf8');
  return parsePdcJsonPackage(JSON.parse(content), slugForJsonFile(filePath));
};

export { parsePdcJsonPackage, pdcJsonToPackage, readPdcJsonFile, readPdcJsonPackages };
