import { writeFile } from 'node:fs/promises';
import { getChangemakerByEin, runUpdateAllDryRun, runUpdateAllWrite, selectChangemakers } from './changemakers.js';
import { logger } from './logger.js';
import {
  type BundleSummary,
  describeBundleCount,
  extractEin,
  findOrgBundles,
  prepareSourceRoot,
  summarizeBundles,
} from './okf.js';
import { oidcOptions } from './oidc.js';
import { getChangemakers } from './pdc-api.js';
import type { CommandModule } from 'yargs';

const JSON_SPACES = 2;

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
  'add-changemakers': boolean;
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
    'add-changemakers': {
      describe:
        'Create a new changemaker when a package EIN has no match in the PDC (default: skip unmatched packages). Ignored when --changemaker-id is set.',
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
      // --changemaker-id targets one existing changemaker, which is incompatible
      // with creating missing ones; when both are given, honor the scope and
      // disable creation (decision 3).
      const addChangemakers = args.addChangemakers && args.changemakerId === undefined;
      if (args.addChangemakers && args.changemakerId !== undefined) {
        logger.warn('--add-changemakers is ignored because --changemaker-id targets a single existing changemaker.');
      }
      // With --add-changemakers we can proceed even against an empty scope (we
      // create as we go); otherwise there is nothing to match and we stop.
      if (changemakers.entries.length === 0 && !addChangemakers) {
        logger.warn({ changemakerId: args.changemakerId }, 'No matching changemakers found in PDC; nothing to load.');
        return;
      }

      if (args.dryRun) {
        await runUpdateAllDryRun(bundles, changemakers, addChangemakers);
        return;
      }

      await runUpdateAllWrite(bundles, changemakers, addChangemakers, args);
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

export { techsoup };
