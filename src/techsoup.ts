import { writeFile } from 'node:fs/promises';
import { AxiosError } from 'axios';
import { logger } from './logger.js';
import {
  type BundleSummary,
  type MappedField,
  type OkfBundle,
  collectFieldsFromMap,
  collectProposalFields,
  describeBundleCount,
  extractEin,
  extractGoodAsOf,
  findOrgBundles,
  organizationFieldMap,
  prepareSourceRoot,
  summarizeBundles,
} from './okf.js';
import { type AccessTokenSet, getToken, oidcOptions } from './oidc.js';
import {
  getChangemakers,
  getSources,
  postChangemakerFieldValue,
  postChangemakerFieldValueBatch,
  postSource,
  type WritableChangemakerFieldValue,
} from './pdc-api.js';
import type { CommandModule } from 'yargs';
import type { Changemaker, ChangemakerBundle, Source } from '@pdc/sdk';

const TS_SHORT_CODE = 'techsoup';
const JSON_SPACES = 2;
// When `@pdc/http-status-codes` is ready (issues 18-20 solved), use it instead.
const HTTP_STATUS_FORBIDDEN = 403;

const getChangemakerByEin = (ein: string, changemakers: ChangemakerBundle): Changemaker | null => {
  const normalized = ein.replace('-', '');
  const matches = changemakers.entries.filter((c) => c.taxId.replace('-', '') === normalized);
  if (matches.length > 1) {
    logger.warn(`Found multiple changemakers with EIN ${ein}, not returning any.`);
    return null;
  }
  if (matches.length < 1) {
    logger.info(`Found no changemaker with EIN ${ein}`);
    return null;
  }
  const [match] = matches;
  if (match !== undefined) {
    return match;
  }
  throw new Error('How could this have happened?');
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
 * Print the full field-by-field mapping for one package to the console, showing
 * exactly which changemaker field values WOULD be written and which proposal
 * fields are collected-but-not-written. Reads only local files — nothing is sent
 * to (or read from) the PDC.
 */
const logMappedFields = (summary: BundleSummary): void => {
  logger.info(
    { ein: summary.ein, goodAsOf: summary.goodAsOf },
    `${summary.slug} — mapping preview (nothing sent to PDC; changemaker match happens only at run time)`,
  );
  for (const field of summary.organizationFields) {
    logger.info(
      `  WOULD POST changemakerFieldValue: ${field.baseFieldShortCode} = ${JSON.stringify(field.value)} (goodAsOf=${summary.goodAsOf ?? 'null'})  [${field.sourceNote}]`,
    );
  }
  for (const field of summary.proposalFields) {
    logger.info(
      `  proposal field (collected, NOT written): ${field.baseFieldShortCode} = ${JSON.stringify(field.value)}  [${field.sourceNote}]`,
    );
  }
};

// ---------------------------------------------------------------------------
// CLI command modules
// ---------------------------------------------------------------------------

interface InventoryCommandArgs {
  source: string;
  outputFile?: string;
  'show-fields': boolean;
}

interface LookupFromPdcCommandArgs {
  source: string;
  'pdc-api-base-url': string;
  outputFile?: string;
}

interface UpdateAllCommandArgs {
  source: string;
  'pdc-api-base-url': string;
  'changemaker-id'?: number;
  'dry-run': boolean;
  'oidc-base-url': string;
  'oidc-client-id': string;
  'oidc-client-secret': string;
}

const SOURCE_DESCRIBE =
  'Path to a TechSoup OKF .zip file, a folder of extracted OKF packages, or a folder of .zip files';

const inventoryCommand: CommandModule<unknown, InventoryCommandArgs> = {
  command: 'inventory',
  describe: 'Examine a TechSoup OKF zip/folder and inventory the available packages and mapped fields',
  builder: (y) =>
    y
      .option('source', { describe: SOURCE_DESCRIBE, demandOption: true, normalize: true, type: 'string' })
      .option('output-file', {
        alias: 'write',
        describe: 'Write the inventory to the specified JSON file',
        normalize: true,
        type: 'string',
      })
      .option('show-fields', {
        alias: 'fields',
        describe: 'Print the full field-by-field mapping that would be sent to PDC (offline; nothing is sent)',
        demandOption: false,
        default: false,
        type: 'boolean',
      }),
  handler: async (args): Promise<void> => {
    const prepared = await prepareSourceRoot(args.source);
    try {
      const bundles = await findOrgBundles(prepared.root);
      describeBundleCount(bundles, args.source);
      const summaries = await summarizeBundles(bundles);
      if (args.outputFile === undefined || args.outputFile === '') {
        for (const summary of summaries) {
          if (args.showFields) {
            logMappedFields(summary);
          } else {
            logger.info(
              {
                ein: summary.ein,
                goodAsOf: summary.goodAsOf,
                organizationFields: summary.organizationFields.length,
                proposalFields: summary.proposalFields.length,
              },
              summary.slug,
            );
          }
        }
      } else {
        await writeFile(args.outputFile, JSON.stringify(summaries, null, JSON_SPACES));
        logger.info(`Wrote TechSoup inventory (${summaries.length} package(s)) to ${JSON.stringify(args.outputFile)}`);
      }
    } finally {
      await prepared.cleanup();
    }
  },
};

const lookupFromPdcCommand: CommandModule<unknown, LookupFromPdcCommandArgs> = {
  command: 'lookupFromPdc',
  describe: 'Match TechSoup package EINs against PDC changemakers and report which are present (read-only)',
  builder: (y) =>
    y
      .option('source', { describe: SOURCE_DESCRIBE, demandOption: true, normalize: true, type: 'string' })
      .option('pdc-api-base-url', { describe: 'Location of PDC API', demandOption: true, type: 'string' })
      .option('output-file', {
        alias: 'write',
        describe: 'Write the match report to the specified JSON file',
        normalize: true,
        type: 'string',
      }),
  handler: async (args): Promise<void> => {
    const prepared = await prepareSourceRoot(args.source);
    try {
      const bundles = await findOrgBundles(prepared.root);
      describeBundleCount(bundles, args.source);
      const changemakers = await getChangemakers(args.pdcApiBaseUrl);
      const rows = bundles.map((bundle) => {
        const ein = extractEin(bundle.readme);
        const changemaker = ein === null ? null : getChangemakerByEin(ein, changemakers);
        return { slug: bundle.slug, ein, changemakerId: changemaker?.id ?? null, presentInPdc: changemaker !== null };
      });
      const { length: presentCount } = rows.filter((row) => row.presentInPdc);
      if (args.outputFile === undefined || args.outputFile === '') {
        logger.info({ total: rows.length, present: presentCount }, 'TechSoup packages matched against PDC');
        for (const row of rows) {
          logger.info(row, row.slug);
        }
      } else {
        await writeFile(args.outputFile, JSON.stringify(rows, null, JSON_SPACES));
        logger.info(
          `Wrote TechSoup PDC match report (${rows.length} package(s)) to ${JSON.stringify(args.outputFile)}`,
        );
      }
    } finally {
      await prepared.cleanup();
    }
  },
};

/** Dry-run of `updateAll`: log every intended write without contacting the PDC for auth or POSTs. */
const runUpdateAllDryRun = async (bundles: OkfBundle[], changemakers: ChangemakerBundle): Promise<void> => {
  logger.info('[dry-run] No data will be written to the PDC.');
  /* eslint-disable no-await-in-loop -- packages are processed sequentially, mirroring the real write path */
  for (const bundle of bundles) {
    const ein = extractEin(bundle.readme);
    if (ein === null) {
      logger.info(`[dry-run] Skipping ${bundle.slug}: no IRS-EIN in package`);
      continue;
    }
    const changemaker = getChangemakerByEin(ein, changemakers);
    if (changemaker === null) {
      continue;
    }
    const goodAsOf = extractGoodAsOf(bundle.readme);
    const organizationFields = await collectFieldsFromMap(bundle.path, organizationFieldMap);
    for (const field of organizationFields) {
      logger.info(
        `[dry-run] would POST changemakerFieldValue changemakerId=${changemaker.id} baseFieldShortCode=${field.baseFieldShortCode} goodAsOf=${goodAsOf ?? 'null'} value=${JSON.stringify(field.value)}`,
      );
    }
    warnProposalsStubbed(bundle.slug, await collectProposalFields(bundle.path));
  }
  /* eslint-enable no-await-in-loop */
};

const updateAllCommand: CommandModule<unknown, UpdateAllCommandArgs> = {
  command: 'updateAll',
  describe: 'Load organization fields from a TechSoup OKF zip/folder into PDC for each matching changemaker',
  builder: {
    ...oidcOptions,
    source: { describe: SOURCE_DESCRIBE, demandOption: true, normalize: true, type: 'string' },
    'pdc-api-base-url': { describe: 'Location of PDC API', demandOption: true, type: 'string' },
    'changemaker-id': {
      describe: 'Only load the single PDC changemaker with this ID (default: all changemakers in the PDC)',
      demandOption: false,
      type: 'number',
    },
    'dry-run': {
      describe: 'Report what would be written without contacting the PDC for authentication or writes',
      demandOption: false,
      default: false,
      type: 'boolean',
    },
  },
  handler: async (args): Promise<void> => {
    const prepared = await prepareSourceRoot(args.source);
    try {
      const bundles = await findOrgBundles(prepared.root);
      describeBundleCount(bundles, args.source);
      if (bundles.length === 0) {
        return;
      }
      const allChangemakers = await getChangemakers(args.pdcApiBaseUrl);
      const changemakers = selectChangemakers(allChangemakers, args.changemakerId);
      if (changemakers.entries.length === 0) {
        logger.warn({ changemakerId: args.changemakerId }, 'No matching changemakers found in PDC; nothing to load.');
        return;
      }

      if (args.dryRun) {
        await runUpdateAllDryRun(bundles, changemakers);
        return;
      }

      // Up to this point we didn't need PDC authentication. Now we do.
      const token = await getToken(args.oidcBaseUrl, args.oidcClientId, args.oidcClientSecret);
      const source = await getOrCreateSource(args.pdcApiBaseUrl, token);
      logger.info(source, 'The PDC Source for TechSoup was found');
      const fieldBatch = await postChangemakerFieldValueBatch(args.pdcApiBaseUrl, token, {
        sourceId: source.id,
        notes: `data-scripts techsoup.ts execution ${Date.now()}`,
      });
      const missingPermissionChangemakerIds = new Set<number>();
      // Each OKF package is processed one at a time, and field values are POSTed
      // one at a time (not Promise.all) because the PDC API times out under
      // concurrent POSTs to /changemakerFieldValues.
      /* eslint-disable no-await-in-loop -- sequential POSTs avoid PDC API connection saturation. */
      for (const bundle of bundles) {
        const ein = extractEin(bundle.readme);
        if (ein === null) {
          logger.info(`Skipping ${bundle.slug}: no IRS-EIN in package`);
          continue;
        }
        const changemaker = getChangemakerByEin(ein, changemakers);
        if (changemaker === null) {
          continue;
        }
        const goodAsOf = extractGoodAsOf(bundle.readme);
        const organizationFields = await collectFieldsFromMap(bundle.path, organizationFieldMap);
        warnProposalsStubbed(bundle.slug, await collectProposalFields(bundle.path));
        for (const field of organizationFields) {
          await postChangemakerFieldValueWarnOnForbidden(
            args.pdcApiBaseUrl,
            token,
            {
              changemakerId: changemaker.id,
              batchId: fieldBatch.id,
              baseFieldShortCode: field.baseFieldShortCode,
              value: field.value,
              goodAsOf,
            },
            missingPermissionChangemakerIds,
          );
        }
      }
      /* eslint-enable no-await-in-loop */
      if (missingPermissionChangemakerIds.size > 0) {
        logger.warn(
          `No permission for at least one field in each of these changemakers (so not updated): ${JSON.stringify([...missingPermissionChangemakerIds])}`,
        );
      }
    } finally {
      await prepared.cleanup();
    }
  },
};

const techsoup: CommandModule = {
  command: 'techsoup',
  describe: 'Load TechSoup OKF package data (from a zip or folder) into the PDC',
  builder: (y) => y.command(inventoryCommand).command(lookupFromPdcCommand).command(updateAllCommand).demandCommand(1),
  /* eslint-disable-next-line @typescript-eslint/no-empty-function -- yargs demandCommand handles routing to subcommands */
  handler: () => {},
};

export { getChangemakerByEin, selectChangemakers, techsoup };
