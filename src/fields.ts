// Multi-valued source data (e.g. OKF `aliases`/`ntee`, or an array-valued field
// in a `_pdc.json`) is flattened into a single PDC string with this separator,
// since a ChangemakerFieldValue.value is a scalar string.
const ARRAY_VALUE_SEPARATOR = '; ';

/** A resolved value ready to be posted as a PDC field, with a provenance note. */
interface MappedField {
  baseFieldShortCode: string;
  value: string;
  sourceNote: string;
}

/**
 * The source-agnostic unit of work: the normalized package that both the OKF
 * bundle reader and the `_pdc.json` reader produce, and what the importer loads
 * into the PDC. `ein`/`name`/`goodAsOf` may be null (e.g. `goodAsOf` is always
 * null for `_pdc.json` sources, which carry no generation date).
 */
interface TechSoupPackage {
  slug: string;
  ein: string | null;
  name: string | null;
  goodAsOf: string | null;
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

/** Proposal-scoped base fields are those whose short code starts with `proposal_`. */
const isProposalField = (baseFieldShortCode: string): boolean => baseFieldShortCode.startsWith('proposal_');

export { type MappedField, type TechSoupPackage, isProposalField, toFieldValueString };
