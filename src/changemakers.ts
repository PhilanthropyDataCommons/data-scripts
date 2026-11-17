import { AxiosError } from 'axios';
import { logger } from './logger.js';
import { type AccessTokenSet, getToken } from './oidc.js';
import {
  getSources,
  postChangemaker,
  postChangemakerFieldValue,
  postChangemakerFieldValueBatch,
  postSource,
  type WritableChangemakerFieldValue,
} from './pdc-api.js';
import type { MappedField, TechSoupDocument, TechSoupPackage } from './fields.js';
import type { Changemaker, ChangemakerBundle, Source, SourceBundle } from '@pdc/sdk';

const TS_SHORT_CODE = 'techsoup';
// When `@pdc/http-status-codes` is ready (issues 18-20 solved), use it instead.
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;

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
 * (`missing` — a create candidate when `--create-changemaker` is set).
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

/**
 * Pick the TechSoup source (`dataProviderShortCode === 'techsoup'`) from the PDC
 * sources, or null when there is none. When several exist, the oldest (lowest
 * ID) is used, with a warning, rather than creating yet another.
 */
const selectTechSoupSource = (sources: SourceBundle): Source | null => {
  const techSoupSources = sources.entries
    .filter((s) => s.dataProviderShortCode === TS_SHORT_CODE)
    .sort((a, b) => a.id - b.id);
  const [oldest] = techSoupSources;
  if (oldest === undefined) {
    return null;
  }
  if (techSoupSources.length > 1) {
    logger.warn(
      `Found ${techSoupSources.length} TechSoup sources (${techSoupSources.map((s) => s.id).join(', ')}); using source ${oldest.id}`,
    );
  }
  return oldest;
};

/**
 * Find the TechSoup source, creating it only when none exists. Creating needs
 * the `techsoup` data provider to exist and permission to add sources to it
 * (typically a `pdc-admin`); a 403/404 from the PDC is reported as that setup
 * problem instead of a raw HTTP error.
 */
const getOrCreateSource = async (baseUrl: string, token: AccessTokenSet): Promise<Source> => {
  const sources = await getSources(baseUrl, token);
  logger.debug(
    { sources: sources.entries.map((s) => ({ id: s.id, dataProviderShortCode: s.dataProviderShortCode })) },
    `GET /sources returned ${sources.entries.length} source(s)`,
  );
  const existing = selectTechSoupSource(sources);
  if (existing !== null) {
    return existing;
  }
  logger.warn('No TechSoup source found in the PDC; trying to create one (usually requires a `pdc-admin`).');
  try {
    return await postSource(baseUrl, token, {
      dataProviderShortCode: TS_SHORT_CODE,
      label: 'TechSoup',
    });
  } catch (e: unknown) {
    if (e instanceof AxiosError && (e.status === HTTP_STATUS_NOT_FOUND || e.status === HTTP_STATUS_FORBIDDEN)) {
      const problem =
        e.status === HTTP_STATUS_NOT_FOUND
          ? `the "${TS_SHORT_CODE}" data provider does not exist in this PDC`
          : `this account may not create sources for the "${TS_SHORT_CODE}" data provider`;
      throw new Error(
        `Cannot create the TechSoup source (HTTP ${e.status}): ${problem}. Ask a pdc-admin to create the "${TS_SHORT_CODE}" data provider and its source, then re-run.`,
        { cause: e },
      );
    }
    throw e;
  }
};

/**
 * Create a new PDC changemaker for a package whose EIN is not yet in the PDC.
 * Requires the package name; the EIN is stored verbatim (hyphenated) as the
 * taxId. Returns null (with a warning) when the name is missing or the create is
 * forbidden (403 — creating changemakers is privileged).
 */
const createChangemakerForPackage = async (
  baseUrl: string,
  token: AccessTokenSet,
  ein: string,
  pkg: TechSoupPackage,
): Promise<Changemaker | null> => {
  if (pkg.name === null) {
    logger.warn(`Cannot create a changemaker for ${pkg.slug}: no organization name. Skipping.`);
    return null;
  }
  try {
    const changemaker = await postChangemaker(baseUrl, token, { taxId: ein, name: pkg.name });
    logger.info({ id: changemaker.id, taxId: ein, name: pkg.name }, `Created changemaker for ${pkg.slug}`);
    return changemaker;
  } catch (e: unknown) {
    if (e instanceof AxiosError && e.status === HTTP_STATUS_FORBIDDEN) {
      logger.warn(`No permission (403) to create a changemaker for ${pkg.slug} (taxId ${ein}). Skipping.`);
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

/**
 * Sort the document's fields by the PDC's own base-field categories. Only
 * `organization` fields may be posted to `/changemakerFieldValues`; fields of
 * any other category (`project`, `budget`, …) belong to a proposal and go to
 * `proposalFields`. Fields with no matching base field in this PDC are dropped
 * with a warning, since the PDC would reject them.
 */
const applyBaseFieldCategories = (
  doc: TechSoupDocument,
  baseFields: { entries: ReadonlyArray<{ shortCode: string; category: string }> },
): TechSoupPackage => {
  const { fields, ...pkg } = doc;
  const categoryByShortCode = new Map<string, string>(baseFields.entries.map((b) => [b.shortCode, b.category]));
  const organizationFields: MappedField[] = [];
  const proposalFields: MappedField[] = [];
  const unknown: string[] = [];
  for (const field of fields) {
    const category = categoryByShortCode.get(field.baseFieldShortCode);
    if (category === undefined) {
      unknown.push(field.baseFieldShortCode);
    } else if (category === 'organization') {
      organizationFields.push(field);
    } else {
      proposalFields.push(field);
    }
  }
  if (unknown.length > 0) {
    logger.warn(
      `${pkg.slug}: ${unknown.length} field(s) are not base fields in this PDC; skipping ${unknown.join(', ')}`,
    );
  }
  return { ...pkg, organizationFields, proposalFields };
};

// ---------------------------------------------------------------------------
// Import plan: which changemaker the package is loaded into
// ---------------------------------------------------------------------------

/**
 * How the target changemaker is chosen: create a new one (`create`), use an
 * explicit PDC changemaker ID (`id`), or match the package EIN against the
 * existing changemakers (`ein`).
 */
type ChangemakerTarget = { kind: 'create' } | { kind: 'id'; changemakerId: number } | { kind: 'ein' };

/** Map the CLI flags to a `ChangemakerTarget` (the CLI rejects combining the two flags). */
const toChangemakerTarget = (createChangemaker: boolean, changemakerId: number | undefined): ChangemakerTarget => {
  if (createChangemaker) {
    return { kind: 'create' };
  }
  if (changemakerId !== undefined) {
    return { kind: 'id', changemakerId };
  }
  return { kind: 'ein' };
};

/**
 * What an import will do: load fields into an existing changemaker (`update`),
 * create a changemaker and then load fields into it (`create`), or do nothing
 * (`skip`, with the reason).
 */
type ImportPlan =
  | { action: 'update'; changemaker: Changemaker }
  | { action: 'create'; taxId: string; name: string }
  | { action: 'skip'; reason: string };

const planForExplicitId = (
  pkg: TechSoupPackage,
  changemakers: ChangemakerBundle,
  changemakerId: number,
): ImportPlan => {
  const changemaker = changemakers.entries.find((c) => c.id === changemakerId);
  if (changemaker === undefined) {
    return { action: 'skip', reason: `No changemaker with ID ${changemakerId} exists in the PDC` };
  }
  if (pkg.ein !== null && pkg.ein.replace('-', '') !== changemaker.taxId.replace('-', '')) {
    logger.warn(
      `${pkg.slug}: file EIN ${pkg.ein} differs from changemaker ${changemakerId} taxId ${changemaker.taxId}; using --changemaker-id as given`,
    );
  }
  return { action: 'update', changemaker };
};

const planForCreate = (pkg: TechSoupPackage, ein: string, resolution: ChangemakerResolution): ImportPlan => {
  if (resolution.kind === 'matched') {
    return {
      action: 'skip',
      reason: `EIN ${ein} already belongs to changemaker ${resolution.changemaker.id}; rerun without --create-changemaker to load into it`,
    };
  }
  if (resolution.kind === 'ambiguous') {
    return { action: 'skip', reason: `EIN ${ein} already matches multiple changemakers; not creating another` };
  }
  if (pkg.name === null) {
    return { action: 'skip', reason: `${pkg.slug} has no organization name, which a new changemaker requires` };
  }
  return { action: 'create', taxId: ein, name: pkg.name };
};

const planForEin = (ein: string, resolution: ChangemakerResolution): ImportPlan => {
  if (resolution.kind === 'matched') {
    return { action: 'update', changemaker: resolution.changemaker };
  }
  if (resolution.kind === 'ambiguous') {
    return { action: 'skip', reason: `EIN ${ein} matches multiple changemakers; pass --changemaker-id to choose one` };
  }
  return {
    action: 'skip',
    reason: `EIN ${ein} not found in the PDC; pass --create-changemaker to create it or --changemaker-id to choose one`,
  };
};

/**
 * Decide which changemaker the package goes to, without writing anything.
 * `--create-changemaker` refuses to create a duplicate of an EIN already in the
 * PDC; `--changemaker-id` must name an existing changemaker; otherwise the
 * package EIN must match exactly one changemaker.
 */
const planImport = (pkg: TechSoupPackage, changemakers: ChangemakerBundle, target: ChangemakerTarget): ImportPlan => {
  if (target.kind === 'id') {
    return planForExplicitId(pkg, changemakers, target.changemakerId);
  }
  if (pkg.ein === null) {
    return {
      action: 'skip',
      reason: `${pkg.slug} has no valid IRS EIN (organization_tax_id); pass --changemaker-id to choose a changemaker`,
    };
  }
  const resolution = resolveChangemaker(pkg.ein, changemakers);
  return target.kind === 'create' ? planForCreate(pkg, pkg.ein, resolution) : planForEin(pkg.ein, resolution);
};

/** One line naming the changemaker the plan targets (or why nothing will be imported). */
const describeTarget = (plan: ImportPlan): string => {
  if (plan.action === 'update') {
    return `changemaker ${plan.changemaker.id} (${JSON.stringify(plan.changemaker.name)}, taxId ${plan.changemaker.taxId})`;
  }
  if (plan.action === 'create') {
    return `NEW changemaker (${JSON.stringify(plan.name)}, taxId ${plan.taxId})`;
  }
  return `nothing — ${plan.reason}`;
};

/**
 * The `--dry-run` report: the target changemaker, every organization field that
 * would be imported into it, and the proposal fields that are present but not
 * imported. Pure, so it can be unit-tested and logged line by line.
 */
const formatImportPreview = (pkg: TechSoupPackage, plan: ImportPlan): string[] => {
  const lines = [`${pkg.slug} → ${describeTarget(plan)}`];
  if (plan.action === 'skip') {
    return lines;
  }
  lines.push(`Fields that would be imported (${pkg.organizationFields.length}, goodAsOf=${pkg.goodAsOf ?? 'null'}):`);
  for (const field of pkg.organizationFields) {
    lines.push(`  ${field.baseFieldShortCode} = ${JSON.stringify(field.value)}  [${field.sourceNote}]`);
  }
  if (pkg.proposalFields.length > 0) {
    lines.push(`Proposal (non-organization) fields NOT imported (${pkg.proposalFields.length}):`);
    for (const field of pkg.proposalFields) {
      lines.push(`  ${field.baseFieldShortCode} = ${JSON.stringify(field.value)}  [${field.sourceNote}]`);
    }
  }
  return lines;
};

// ---------------------------------------------------------------------------
// Import write path
// ---------------------------------------------------------------------------

/** Base URL + OIDC credentials needed to start a write run (before authentication). */
interface ImportWriteContext {
  pdcApiBaseUrl: string;
  oidcBaseUrl: string;
  oidcClientId: string;
  oidcClientSecret: string;
}

/** An authenticated write session: where to POST, with what token, into which field-value batch. */
interface WriteSession {
  baseUrl: string;
  token: AccessTokenSet;
  batchId: number;
}

/** POST every organization field of the package to one changemaker, sequentially (proposals stay stubbed). */
const postOrganizationFields = async (
  session: WriteSession,
  changemaker: Changemaker,
  pkg: TechSoupPackage,
): Promise<void> => {
  warnProposalsStubbed(pkg.slug, pkg.proposalFields);
  const warnedChangemakers = new Set<number>();
  /* eslint-disable no-await-in-loop -- sequential POSTs avoid PDC API connection saturation. */
  for (const field of pkg.organizationFields) {
    await postChangemakerFieldValueWarnOnForbidden(
      session.baseUrl,
      session.token,
      {
        changemakerId: changemaker.id,
        batchId: session.batchId,
        baseFieldShortCode: field.baseFieldShortCode,
        value: field.value,
        goodAsOf: pkg.goodAsOf,
      },
      warnedChangemakers,
    );
  }
  /* eslint-enable no-await-in-loop */
  if (warnedChangemakers.size > 0) {
    logger.warn(`No permission for at least one field of changemaker ${changemaker.id} (so not fully updated)`);
  }
};

/**
 * Carry out an `update`/`create` plan: authenticate, resolve the TechSoup
 * source, create the changemaker if planned, open a field-value batch, then
 * POST the organization fields. The source is resolved first so a missing
 * source fails the run before anything (such as a new changemaker) is written.
 */
const runImportWrite = async (
  pkg: TechSoupPackage,
  plan: Exclude<ImportPlan, { action: 'skip' }>,
  ctx: ImportWriteContext,
): Promise<void> => {
  // Up to this point we didn't need PDC authentication. Now we do.
  const token = await getToken(ctx.oidcBaseUrl, ctx.oidcClientId, ctx.oidcClientSecret);
  const source = await getOrCreateSource(ctx.pdcApiBaseUrl, token);
  logger.info(source, 'The PDC Source for TechSoup was found');
  const changemaker =
    plan.action === 'create'
      ? await createChangemakerForPackage(ctx.pdcApiBaseUrl, token, plan.taxId, pkg)
      : plan.changemaker;
  if (changemaker === null) {
    return;
  }
  const fieldBatch = await postChangemakerFieldValueBatch(ctx.pdcApiBaseUrl, token, {
    sourceId: source.id,
    notes: `data-scripts techsoup.ts import of ${pkg.slug} ${Date.now()}`,
  });
  await postOrganizationFields({ baseUrl: ctx.pdcApiBaseUrl, token, batchId: fieldBatch.id }, changemaker, pkg);
  logger.info(`Imported ${pkg.organizationFields.length} field(s) into changemaker ${changemaker.id}`);
};

export {
  type ChangemakerTarget,
  type ImportPlan,
  applyBaseFieldCategories,
  formatImportPreview,
  planImport,
  resolveChangemaker,
  runImportWrite,
  selectTechSoupSource,
  toChangemakerTarget,
};
