import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import AdmZip from 'adm-zip';
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml';
import { isValidEin } from './ein.js';
import { logger } from './logger.js';

// Multi-valued frontmatter (e.g. `aliases`, `ntee`) is flattened into a single
// PDC string value with this separator, since a ChangemakerFieldValue.value is a
// scalar string. (The upstream OKF export emits a raw array; see docs/techsoup.md.)
const ARRAY_VALUE_SEPARATOR = '; ';
// A leading UTF-8 byte-order mark is not stripped by `readFile(..., 'utf8')`;
// remove it before matching frontmatter.
const BYTE_ORDER_MARK = 0xfeff;
// Isolate the YAML frontmatter block (between the leading and next `---`) so the
// markdown body that follows is never handed to the YAML parser.
const FRONTMATTER_PATTERN = /^---\r?\n(?<body>[\s\S]*?)\r?\n---\s*(?:\r?\n|$)/v;

/**
 * A discovered OKF organization bundle ("package"): a directory whose
 * `README.md` frontmatter declares `type: org`. `readme` holds that parsed
 * frontmatter.
 */
interface OkfBundle {
  slug: string;
  path: string;
  readme: Record<string, unknown>;
}

/** One base-field mapping: read `frontmatterPath` from `sourceFile`, write to `baseFieldShortCode`. */
interface FieldMapEntry {
  sourceFile: string;
  frontmatterPath: string;
  baseFieldShortCode: string;
}

/** A resolved value ready to be posted as a PDC field, with a provenance note. */
interface MappedField {
  baseFieldShortCode: string;
  value: string;
  sourceNote: string;
}

/** Inventory summary for a single bundle (produced by the `inventory` subcommand). */
interface BundleSummary {
  slug: string;
  path: string;
  ein: string | null;
  goodAsOf: string | null;
  organizationFields: MappedField[];
  proposalFields: MappedField[];
}

/**
 * Organization-scoped OKF frontmatter → PDC base field short code. These are
 * written as ChangemakerFieldValues, exactly like the Charity Navigator and
 * GivingTuesday integrations. The mapping mirrors the original TechSoup OKF
 * exporter (see docs/mappings/techsoup-okf-field-gap-analysis.verbose.md §2).
 */
const organizationFieldMap: FieldMapEntry[] = [
  { sourceFile: 'README.md', frontmatterPath: 'title', baseFieldShortCode: 'organization_name' },
  { sourceFile: 'README.md', frontmatterPath: 'description', baseFieldShortCode: 'organization_overview' },
  { sourceFile: 'README.md', frontmatterPath: 'aliases', baseFieldShortCode: 'organization_dba_name' },
  // NOTE: the OKF `status` is a *document* lifecycle value (stable/draft), not an
  // organizational status; the gap analysis (§5.1) flags mapping it to
  // `organization_status` as a data-quality bug. It is retained here to match the
  // existing exporter output — revisit once the org status source is settled.
  { sourceFile: 'README.md', frontmatterPath: 'status', baseFieldShortCode: 'organization_status' },
  {
    sourceFile: 'README.md',
    frontmatterPath: 'x-civic.registration_country',
    baseFieldShortCode: 'organization_country',
  },
  { sourceFile: 'README.md', frontmatterPath: 'x-civic.registration.id', baseFieldShortCode: 'organization_tax_id' },
  { sourceFile: 'README.md', frontmatterPath: 'x-civic.ntee', baseFieldShortCode: 'organization_ntee_code' },
  { sourceFile: 'README.md', frontmatterPath: 'x-civic.situation', baseFieldShortCode: 'organization_geographic_area' },
  { sourceFile: 'population.md', frontmatterPath: 'description', baseFieldShortCode: 'community_definition_overview' },
];

/**
 * Proposal-scoped OKF frontmatter → PDC base field short code. These are
 * COLLECTED and reported but NOT written yet: PDC proposal data requires an
 * Opportunity + ApplicationForm + ProposalVersion scaffold that is out of scope
 * for this pass (see docs/techsoup.md, "Proposals"). The variable-named
 * volunteer-request file contributes `proposal_learning_and_evalution` and is
 * resolved dynamically in `collectProposalFields`.
 */
const proposalFieldMap: FieldMapEntry[] = [
  { sourceFile: 'impact.md', frontmatterPath: 'description', baseFieldShortCode: 'proposal_project_outcomes' },
  { sourceFile: 'programs.md', frontmatterPath: 'description', baseFieldShortCode: 'proposal_related_programs' },
  { sourceFile: 'what_i_need_funding_for.md', frontmatterPath: 'title', baseFieldShortCode: 'proposal_name' },
  {
    sourceFile: 'what_i_need_funding_for.md',
    frontmatterPath: 'description',
    baseFieldShortCode: 'proposal_funding_summary',
  },
];

// ---------------------------------------------------------------------------
// OKF (YAML) frontmatter reading
// ---------------------------------------------------------------------------

const stripBom = (text: string): string => (text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text);

/**
 * Parse a markdown document's YAML frontmatter into an object (empty object if
 * none, malformed, or not a mapping). Uses `JSON_SCHEMA` so that timestamp-like
 * scalars (e.g. `generated.at`) stay strings rather than being coerced to Date.
 */
const parseFrontmatter = (content: string): Record<string, unknown> => {
  const body = FRONTMATTER_PATTERN.exec(stripBom(content))?.groups?.body;
  if (body === undefined) {
    return {};
  }
  const parsed = ((): unknown => {
    try {
      return loadYaml(body, { schema: JSON_SCHEMA });
    } catch (error: unknown) {
      logger.debug({ error }, 'Failed to parse OKF frontmatter YAML');
      return null;
    }
  })();
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  /* eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- js-yaml load returns unknown; a top-level YAML mapping is a string-keyed record */
  return parsed as Record<string, unknown>;
};

/** Read a markdown file and return its parsed frontmatter, or null if unreadable/missing. */
const parseFrontmatterFile = async (filePath: string): Promise<Record<string, unknown> | null> => {
  try {
    const content = await readFile(filePath, 'utf8');
    return parseFrontmatter(content);
  } catch (error: unknown) {
    logger.debug({ error, filePath }, 'Could not read frontmatter file');
    return null;
  }
};

/** Follow a dotted path (e.g. `x-civic.registration.id`) into a parsed frontmatter object. */
const getFrontmatterValue = (frontmatter: Record<string, unknown>, dottedPath: string): unknown => {
  let current: unknown = frontmatter;
  for (const key of dottedPath.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    /* eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing a parsed-YAML node to a record to index it by key */
    const record = current as Record<string, unknown>;
    if (!(key in record)) {
      return undefined;
    }
    const { [key]: next } = record;
    current = next;
  }
  return current;
};

/** Coerce a parsed frontmatter value to a single trimmed PDC field string (arrays joined), or null. */
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

/**
 * Extract the organization's EIN from README frontmatter. Only returns a value
 * when the registration scheme is IRS-EIN (or absent) and the id is a valid EIN;
 * non-US bundles (KRS, PBO, ...) therefore yield null and are skipped downstream.
 */
const extractEin = (readmeFrontmatter: Record<string, unknown>): string | null => {
  const id = toFieldValueString(getFrontmatterValue(readmeFrontmatter, 'x-civic.registration.id'));
  if (id === null) {
    return null;
  }
  const scheme = toFieldValueString(getFrontmatterValue(readmeFrontmatter, 'x-civic.registration.scheme'));
  if (scheme !== null && scheme.toUpperCase() !== 'IRS-EIN') {
    return null;
  }
  return isValidEin(id) ? id : null;
};

/** The organization's display name (README `title`), used when creating a changemaker; null if absent. */
const extractOrganizationName = (readmeFrontmatter: Record<string, unknown>): string | null =>
  toFieldValueString(getFrontmatterValue(readmeFrontmatter, 'title'));

/** Derive a `goodAsOf` ISO date (YYYY-MM-DD) from the bundle's `generated.at`, or null. */
const extractGoodAsOf = (readmeFrontmatter: Record<string, unknown>): string | null => {
  const at = toFieldValueString(getFrontmatterValue(readmeFrontmatter, 'generated.at'));
  if (at === null) {
    return null;
  }
  const match = /^(?<date>\d{4}-\d{2}-\d{2})/v.exec(at);
  return match?.groups?.date ?? null;
};

// ---------------------------------------------------------------------------
// Source (zip / folder) inventory
// ---------------------------------------------------------------------------

/** Extract a .zip into `destDir` using adm-zip (cross-platform, no shell dependency). */
const extractZip = async (zipPath: string, destDir: string): Promise<void> => {
  const zip = new AdmZip(zipPath);
  await zip.extractAllToAsync(destDir, true, false);
};

/**
 * Resolve a `--source` argument to a directory tree to walk. Accepts a single
 * .zip file, a folder of extracted OKF bundles, or a folder containing .zip
 * files (each is extracted). Returns the root plus a cleanup for any temp dir.
 * Whether the source holds one OKF package or several is determined afterwards
 * by `findOrgBundles`.
 */
const prepareSourceRoot = async (source: string): Promise<{ root: string; cleanup: () => Promise<void> }> => {
  const stats = await stat(source);
  const noop = async (): Promise<void> => {
    /* nothing to clean up when the source directory is walked in place */
  };
  if (stats.isFile()) {
    if (!source.toLowerCase().endsWith('.zip')) {
      throw new Error(`Source file is not a .zip: ${source}`);
    }
    const temp = await mkdtemp(join(tmpdir(), 'techsoup-'));
    logger.info(`Extracting ${source} to ${temp}`);
    await extractZip(source, temp);
    return {
      root: temp,
      cleanup: async () => {
        await rm(temp, { recursive: true, force: true });
      },
    };
  }
  if (!stats.isDirectory()) {
    throw new Error(`Source is neither a .zip file nor a directory: ${source}`);
  }
  const entries = await readdir(source, { withFileTypes: true });
  const zips = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'));
  if (zips.length === 0) {
    return { root: source, cleanup: noop };
  }
  const temp = await mkdtemp(join(tmpdir(), 'techsoup-'));
  logger.info(`Found ${zips.length} zip file(s) in ${source}; extracting to ${temp}`);
  for (const zip of zips) {
    // eslint-disable-next-line no-await-in-loop -- extract archives sequentially to bound disk/CPU pressure
    await extractZip(join(source, zip.name), join(temp, zip.name.replace(/\.zip$/iv, '')));
  }
  return {
    root: temp,
    cleanup: async () => {
      await rm(temp, { recursive: true, force: true });
    },
  };
};

/**
 * Walk `root` and return every OKF organization package (a directory whose
 * README.md frontmatter declares `type: org`). This is what determines whether
 * the source held a single package or many: a `root` that is itself a bundle
 * yields one; otherwise every nested bundle is collected. Bundle subdirectories
 * are not descended into. Results are sorted by slug for stable output.
 */
const findOrgBundles = async (root: string): Promise<OkfBundle[]> => {
  const bundles: OkfBundle[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const readmeEntry = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === 'readme.md');
    if (readmeEntry !== undefined) {
      const frontmatter = await parseFrontmatterFile(join(dir, readmeEntry.name));
      if (frontmatter !== null && toFieldValueString(frontmatter.type) === 'org') {
        bundles.push({ slug: basename(dir), path: dir, readme: frontmatter });
        return;
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop -- sequential recursion bounds open file handles
        await walk(join(dir, entry.name));
      }
    }
  };
  await walk(root);
  return bundles.sort((a, b) => a.slug.localeCompare(b.slug));
};

/** Report whether the source resolved to a single OKF package or several (all processed one at a time). */
const describeBundleCount = (bundles: OkfBundle[], source: string): void => {
  if (bundles.length === 0) {
    logger.warn(`No OKF organization packages found under ${source}`);
  } else if (bundles.length === 1) {
    logger.info(`Detected a single OKF package under ${source}: ${bundles[0]?.slug ?? '(unknown)'}`);
  } else {
    logger.info(`Detected ${bundles.length} OKF packages under ${source}; processing one at a time`);
  }
};

/** Read each mapping's source file frontmatter and resolve the mapped, non-empty values. */
const collectFieldsFromMap = async (bundlePath: string, fieldMap: FieldMapEntry[]): Promise<MappedField[]> => {
  const cache = new Map<string, Record<string, unknown> | null>();
  const result: MappedField[] = [];
  /* eslint-disable no-await-in-loop -- files are read on demand and memoized in `cache` */
  for (const entry of fieldMap) {
    let frontmatter = cache.get(entry.sourceFile);
    if (frontmatter === undefined) {
      frontmatter = await parseFrontmatterFile(join(bundlePath, entry.sourceFile));
      cache.set(entry.sourceFile, frontmatter);
    }
    if (frontmatter === null) {
      continue;
    }
    const value = toFieldValueString(getFrontmatterValue(frontmatter, entry.frontmatterPath));
    if (value === null) {
      continue;
    }
    result.push({
      baseFieldShortCode: entry.baseFieldShortCode,
      value,
      sourceNote: `${basename(bundlePath)}/${entry.sourceFile}#${entry.frontmatterPath}`,
    });
  }
  /* eslint-enable no-await-in-loop */
  return result;
};

/** Locate the (variably named) volunteer-request markdown file within a bundle, relative to it. */
const resolveVolunteerRequestFile = async (bundlePath: string): Promise<string | null> => {
  const dir = join(bundlePath, 'technical-volunteers');
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return null;
  }
  /* eslint-disable no-await-in-loop -- scan candidate files sequentially until the request file is found */
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.md') ||
      entry.name === 'index.md' ||
      entry.name === 'constraints.md'
    ) {
      continue;
    }
    const frontmatter = await parseFrontmatterFile(join(dir, entry.name));
    if (frontmatter !== null && toFieldValueString(frontmatter.type) === 'volunteer-request') {
      // Forward slash (not path.join) so the provenance note matches the OKF
      // `file#anchor` convention; join() below accepts it on all platforms.
      return `technical-volunteers/${entry.name}`;
    }
  }
  /* eslint-enable no-await-in-loop */
  return null;
};

/** Collect proposal-scoped fields (fixed files plus the dynamic volunteer-request file). */
const collectProposalFields = async (bundlePath: string): Promise<MappedField[]> => {
  const fields = await collectFieldsFromMap(bundlePath, proposalFieldMap);
  const volunteerFile = await resolveVolunteerRequestFile(bundlePath);
  if (volunteerFile !== null) {
    const frontmatter = await parseFrontmatterFile(join(bundlePath, volunteerFile));
    if (frontmatter !== null) {
      const value = toFieldValueString(getFrontmatterValue(frontmatter, 'description'));
      if (value !== null) {
        fields.push({
          baseFieldShortCode: 'proposal_learning_and_evalution',
          value,
          sourceNote: `${basename(bundlePath)}/${volunteerFile}#description`,
        });
      }
    }
  }
  return fields;
};

const summarizeBundles = async (bundles: OkfBundle[]): Promise<BundleSummary[]> => {
  const summaries: BundleSummary[] = [];
  /* eslint-disable no-await-in-loop -- bundles are summarized sequentially to bound concurrent file reads */
  for (const bundle of bundles) {
    const organizationFields = await collectFieldsFromMap(bundle.path, organizationFieldMap);
    const proposalFields = await collectProposalFields(bundle.path);
    summaries.push({
      slug: bundle.slug,
      path: bundle.path,
      ein: extractEin(bundle.readme),
      goodAsOf: extractGoodAsOf(bundle.readme),
      organizationFields,
      proposalFields,
    });
  }
  /* eslint-enable no-await-in-loop */
  return summaries;
};

export {
  type BundleSummary,
  type MappedField,
  type OkfBundle,
  collectFieldsFromMap,
  collectProposalFields,
  describeBundleCount,
  extractEin,
  extractGoodAsOf,
  extractOrganizationName,
  findOrgBundles,
  getFrontmatterValue,
  organizationFieldMap,
  parseFrontmatter,
  prepareSourceRoot,
  summarizeBundles,
  toFieldValueString,
};
