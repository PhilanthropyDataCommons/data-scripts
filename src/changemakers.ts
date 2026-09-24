import { AxiosError } from 'axios';
import { logger } from './logger.js';
import {
  type MappedField,
  type OkfBundle,
  collectFieldsFromMap,
  collectProposalFields,
  extractEin,
  extractGoodAsOf,
  extractOrganizationName,
  organizationFieldMap,
} from './okf.js';
import { type AccessTokenSet, getToken } from './oidc.js';
import {
  getSources,
  postChangemaker,
  postChangemakerFieldValue,
  postChangemakerFieldValueBatch,
  postSource,
  type WritableChangemakerFieldValue,
} from './pdc-api.js';
import type { Changemaker, ChangemakerBundle, Source } from '@pdc/sdk';

const TS_SHORT_CODE = 'techsoup';
// When `@pdc/http-status-codes` is ready (issues 18-20 solved), use it instead.
const HTTP_STATUS_FORBIDDEN = 403;

// ---------------------------------------------------------------------------
// EIN → changemaker matching
// ---------------------------------------------------------------------------

/** All changemakers whose (hyphen-insensitive) taxId equals the given EIN. */
const findChangemakersByEin = (ein: string, changemakers: ChangemakerBundle): Changemaker[] => {
  const normalized = ein.replace('-', '');
  return changemakers.entries.filter((c) => c.taxId.replace('-', '') === normalized);
};

/**
 * The outcome of resolving an EIN against the PDC changemakers: a unique match
 * (`matched`), several matches (`ambiguous` — never auto-created), or none
 * (`missing` — a create candidate when `--add-changemakers` is set).
 */
type ChangemakerResolution =
  { kind: 'matched'; changemaker: Changemaker } | { kind: 'ambiguous' } | { kind: 'missing' };

const resolveChangemaker = (ein: string, changemakers: ChangemakerBundle): ChangemakerResolution => {
  const matches = findChangemakersByEin(ein, changemakers);
  if (matches.length > 1) {
    return { kind: 'ambiguous' };
  }
  const [match] = matches;
  if (match !== undefined) {
    return { kind: 'matched', changemaker: match };
  }
  return { kind: 'missing' };
};

const getChangemakerByEin = (ein: string, changemakers: ChangemakerBundle): Changemaker | null => {
  const resolution = resolveChangemaker(ein, changemakers);
  if (resolution.kind === 'ambiguous') {
    logger.warn(`Found multiple changemakers with EIN ${ein}, not returning any.`);
    return null;
  }
  if (resolution.kind === 'missing') {
    logger.info(`Found no changemaker with EIN ${ein}`);
    return null;
  }
  return resolution.changemaker;
};

/**
 * Return the changemaker bundle scoped to a single ID when `changemakerId` is
 * supplied, or the full bundle otherwise.
 */
const selectChangemakers = (changemakers: ChangemakerBundle, changemakerId: number | undefined): ChangemakerBundle => {
  if (changemakerId === undefined) {
    return changemakers;
  }
  const entries = changemakers.entries.filter((c) => c.id === changemakerId);
  return { ...changemakers, entries, total: entries.length };
};

// ---------------------------------------------------------------------------
// PDC writes (source, changemaker creation, field values)
// ---------------------------------------------------------------------------

/** Light wrapper around `postChangemakerFieldValue` that logs a warning on HTTP 403. */
const postChangemakerFieldValueWarnOnForbidden = async (
  baseUrl: string,
  token: AccessTokenSet,
  data: WritableChangemakerFieldValue,
  warnedChangemakers: Set<number>, // Mutated! This is for observation/logs, not control!
): Promise<void> => {
  try {
    const fieldValue = await postChangemakerFieldValue(baseUrl, token, data);
    logger.info(`Added changemaker field value: ${JSON.stringify(fieldValue)}`);
  } catch (e: unknown) {
    if (e instanceof AxiosError && e.status === HTTP_STATUS_FORBIDDEN) {
      logger.warn(`No permission (403) to create ${JSON.stringify(data)}`);
      warnedChangemakers.add(data.changemakerId);
    } else {
      throw e;
    }
  }
};

const getOrCreateSource = async (baseUrl: string, token: AccessTokenSet): Promise<Source> => {
  const sources = await getSources(baseUrl, token);
  const filteredSources = sources.entries.filter((s) => s.dataProviderShortCode === TS_SHORT_CODE);
  if (filteredSources.length === 1 && filteredSources[0] !== undefined) {
    return filteredSources[0];
  }
  logger.warn('Have a `pdc-admin` create a source because only administrators may be able.');
  return await postSource(baseUrl, token, {
    dataProviderShortCode: TS_SHORT_CODE,
    label: 'TechSoup',
  });
};

/**
 * Create a new PDC changemaker for a package whose EIN is not yet in the PDC.
 * Requires an organization name (README `title`); the EIN is stored verbatim
 * (hyphenated) as the taxId. Returns null (with a warning) when the name is
 * missing or the create is forbidden (403 — creating changemakers is privileged).
 */
const createChangemakerForBundle = async (
  baseUrl: string,
  token: AccessTokenSet,
  ein: string,
  bundle: OkfBundle,
): Promise<Changemaker | null> => {
  const name = extractOrganizationName(bundle.readme);
  if (name === null) {
    logger.warn(`Cannot create a changemaker for ${bundle.slug}: no organization name (README title). Skipping.`);
    return null;
  }
  try {
    const changemaker = await postChangemaker(baseUrl, token, { taxId: ein, name });
    logger.info({ id: changemaker.id, taxId: ein, name }, `Created changemaker for ${bundle.slug}`);
    return changemaker;
  } catch (e: unknown) {
    if (e instanceof AxiosError && e.status === HTTP_STATUS_FORBIDDEN) {
      logger.warn(`No permission (403) to create a changemaker for ${bundle.slug} (taxId ${ein}). Skipping.`);
      return null;
    }
    throw e;
  }
};

/**
 * Proposal fields are collected but not yet written. PDC proposal data requires
 * an Opportunity + ApplicationForm + ProposalVersion scaffold that is out of
 * scope for this pass; surface what would be written so it is visible.
 */
const warnProposalsStubbed = (slug: string, proposalFields: MappedField[]): void => {
  if (proposalFields.length === 0) {
    return;
  }
  // TODO(techsoup-proposals): write these as PDC proposal data (Opportunity +
  // ApplicationForm + ProposalVersion, cf. postProposalVersions.ts). Until the
  // proposal model is decided, proposal fields are reported but NOT written.
  logger.warn(
    { slug, proposalFields: proposalFields.map((f) => f.baseFieldShortCode) },
    `Collected ${proposalFields.length} proposal field(s) — NOT written (stubbed, pending proposal model)`,
  );
};

// ---------------------------------------------------------------------------
// updateAll write path
// ---------------------------------------------------------------------------

/** Everything one package's writes need, gathered once so per-package helpers stay small. */
interface WriteRun {
  baseUrl: string;
  token: AccessTokenSet;
  batchId: number;
  changemakers: ChangemakerBundle;
  addChangemakers: boolean;
  warnedChangemakers: Set<number>;
}

/** Base URL + OIDC credentials needed to start a write run (before authentication). */
interface UpdateAllWriteContext {
  pdcApiBaseUrl: string;
  oidcBaseUrl: string;
  oidcClientId: string;
  oidcClientSecret: string;
}

/**
 * Resolve the changemaker to load a package into, creating one when the EIN is
 * missing and `--add-changemakers` is set. Returns null when the package should
 * be skipped (ambiguous match, missing without the flag, or a missing-name /
 * forbidden create) — the reason is logged. Mutates `run.changemakers.entries`
 * when a new record is created so later packages with the same EIN reuse it.
 */
const resolveOrCreateChangemaker = async (
  run: WriteRun,
  ein: string,
  bundle: OkfBundle,
): Promise<Changemaker | null> => {
  const resolution = resolveChangemaker(ein, run.changemakers);
  if (resolution.kind === 'matched') {
    return resolution.changemaker;
  }
  if (resolution.kind === 'ambiguous') {
    logger.warn(`Skipping ${bundle.slug}: EIN ${ein} matches multiple changemakers`);
    return null;
  }
  if (!run.addChangemakers) {
    logger.info(`Skipping ${bundle.slug}: EIN ${ein} not found in PDC`);
    return null;
  }
  const created = await createChangemakerForBundle(run.baseUrl, run.token, ein, bundle);
  if (created !== null) {
    run.changemakers.entries.push(created);
  }
  return created;
};

/** POST every mapped organization field for one package's changemaker (proposals stay stubbed). */
const postOrganizationFields = async (run: WriteRun, changemaker: Changemaker, bundle: OkfBundle): Promise<void> => {
  const goodAsOf = extractGoodAsOf(bundle.readme);
  const organizationFields = await collectFieldsFromMap(bundle.path, organizationFieldMap);
  warnProposalsStubbed(bundle.slug, await collectProposalFields(bundle.path));
  /* eslint-disable no-await-in-loop -- sequential POSTs avoid PDC API connection saturation. */
  for (const field of organizationFields) {
    await postChangemakerFieldValueWarnOnForbidden(
      run.baseUrl,
      run.token,
      {
        changemakerId: changemaker.id,
        batchId: run.batchId,
        baseFieldShortCode: field.baseFieldShortCode,
        value: field.value,
        goodAsOf,
      },
      run.warnedChangemakers,
    );
  }
  /* eslint-enable no-await-in-loop */
};

/** The live (non-dry-run) `updateAll` path: authenticate, open a batch, and load each package. */
const runUpdateAllWrite = async (
  bundles: OkfBundle[],
  changemakers: ChangemakerBundle,
  addChangemakers: boolean,
  ctx: UpdateAllWriteContext,
): Promise<void> => {
  // Up to this point we didn't need PDC authentication. Now we do.
  const token = await getToken(ctx.oidcBaseUrl, ctx.oidcClientId, ctx.oidcClientSecret);
  const source = await getOrCreateSource(ctx.pdcApiBaseUrl, token);
  logger.info(source, 'The PDC Source for TechSoup was found');
  const fieldBatch = await postChangemakerFieldValueBatch(ctx.pdcApiBaseUrl, token, {
    sourceId: source.id,
    notes: `data-scripts techsoup.ts execution ${Date.now()}`,
  });
  const run: WriteRun = {
    baseUrl: ctx.pdcApiBaseUrl,
    token,
    batchId: fieldBatch.id,
    changemakers,
    addChangemakers,
    warnedChangemakers: new Set<number>(),
  };
  /* eslint-disable no-await-in-loop -- sequential per-package processing avoids PDC API saturation. */
  for (const bundle of bundles) {
    const ein = extractEin(bundle.readme);
    if (ein === null) {
      logger.info(`Skipping ${bundle.slug}: no IRS-EIN in package`);
      continue;
    }
    const changemaker = await resolveOrCreateChangemaker(run, ein, bundle);
    if (changemaker === null) {
      continue;
    }
    await postOrganizationFields(run, changemaker, bundle);
  }
  /* eslint-enable no-await-in-loop */
  if (run.warnedChangemakers.size > 0) {
    logger.warn(
      `No permission for at least one field in each of these changemakers (so not updated): ${JSON.stringify([...run.warnedChangemakers])}`,
    );
  }
};

// ---------------------------------------------------------------------------
// updateAll dry-run path
// ---------------------------------------------------------------------------

/**
 * Resolve the label a dry-run should print for a package's changemaker, or null
 * when the package would be skipped (logging the reason). `(new)` is returned
 * when `--add-changemakers` would create one.
 */
const dryRunChangemakerLabel = (
  bundle: OkfBundle,
  ein: string,
  changemakers: ChangemakerBundle,
  addChangemakers: boolean,
): string | null => {
  const resolution = resolveChangemaker(ein, changemakers);
  if (resolution.kind === 'ambiguous') {
    logger.warn(`[dry-run] Skipping ${bundle.slug}: EIN ${ein} matches multiple changemakers`);
    return null;
  }
  if (resolution.kind === 'matched') {
    return String(resolution.changemaker.id);
  }
  if (!addChangemakers) {
    logger.info(`[dry-run] Skipping ${bundle.slug}: EIN ${ein} not found in PDC`);
    return null;
  }
  const name = extractOrganizationName(bundle.readme);
  if (name === null) {
    logger.warn(`[dry-run] Skipping ${bundle.slug}: would create a changemaker but README has no title (name)`);
    return null;
  }
  logger.info(`[dry-run] would CREATE changemaker taxId=${ein} name=${JSON.stringify(name)}`);
  return '(new)';
};

/** Dry-run of `updateAll`: log every intended write without contacting the PDC for auth or POSTs. */
const runUpdateAllDryRun = async (
  bundles: OkfBundle[],
  changemakers: ChangemakerBundle,
  addChangemakers: boolean,
): Promise<void> => {
  logger.info('[dry-run] No data will be written to the PDC.');
  /* eslint-disable no-await-in-loop -- packages are processed sequentially, mirroring the real write path */
  for (const bundle of bundles) {
    const ein = extractEin(bundle.readme);
    if (ein === null) {
      logger.info(`[dry-run] Skipping ${bundle.slug}: no IRS-EIN in package`);
      continue;
    }
    const changemakerLabel = dryRunChangemakerLabel(bundle, ein, changemakers, addChangemakers);
    if (changemakerLabel === null) {
      continue;
    }
    const goodAsOf = extractGoodAsOf(bundle.readme);
    const organizationFields = await collectFieldsFromMap(bundle.path, organizationFieldMap);
    for (const field of organizationFields) {
      logger.info(
        `[dry-run] would POST changemakerFieldValue changemakerId=${changemakerLabel} baseFieldShortCode=${field.baseFieldShortCode} goodAsOf=${goodAsOf ?? 'null'} value=${JSON.stringify(field.value)}`,
      );
    }
    warnProposalsStubbed(bundle.slug, await collectProposalFields(bundle.path));
  }
  /* eslint-enable no-await-in-loop */
};

export { getChangemakerByEin, resolveChangemaker, runUpdateAllDryRun, runUpdateAllWrite, selectChangemakers };
