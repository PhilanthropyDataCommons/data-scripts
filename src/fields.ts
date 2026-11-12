// An array-valued field in a `_pdc.json` is flattened into a single PDC string
// with this separator, since a ChangemakerFieldValue.value is a scalar string.
const ARRAY_VALUE_SEPARATOR = '; ';

/** A resolved value ready to be posted as a PDC field, with a provenance note. */
interface MappedField {
  baseFieldShortCode: string;
  value: string;
  sourceNote: string;
}

/**
 * One organization as read from a `_pdc.json` file, before its fields are
 * sorted by PDC base-field category. `ein`/`name` may be null; `goodAsOf` is
 * currently always null because the JSON carries no generation date.
 */
interface TechSoupDocument {
  slug: string;
  ein: string | null;
  name: string | null;
  goodAsOf: string | null;
  fields: MappedField[];
}

/**
 * A document whose fields have been sorted by the PDC's base-field categories
 * (see `applyBaseFieldCategories`): what the importer loads into the PDC.
 * Only `organizationFields` are written; `proposalFields` are reported.
 */
interface TechSoupPackage extends Omit<TechSoupDocument, 'fields'> {
  organizationFields: MappedField[];
  proposalFields: MappedField[];
}

/** Coerce an arbitrary source value to a single trimmed PDC field string (arrays joined), or null. */
const toFieldValueString = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => toFieldValueString(item)).filter((item): item is string => item !== null);
    return parts.length === 0 ? null : parts.join(ARRAY_VALUE_SEPARATOR);
  }
  return null;
};

export { type MappedField, type TechSoupDocument, type TechSoupPackage, toFieldValueString };
