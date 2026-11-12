import {
  applyBaseFieldCategories,
  formatImportPreview,
  planImport,
  runImportWrite,
  toChangemakerTarget,
} from './changemakers.js';
import { logger } from './logger.js';
import { oidcOptions } from './oidc.js';
import { getBaseFields, getChangemakers } from './pdc-api.js';
import { readPdcJsonFile } from './pdc-json.js';
import type { CommandModule } from 'yargs';

// The importer reads exactly one TechSoup PDC JSON file per run.

interface ImportCommandArgs {
  file: string;
  'pdc-api-base-url': string;
  'create-changemaker'?: boolean;
  'changemaker-id'?: number;
  'dry-run': boolean;
  'oidc-base-url': string;
  'oidc-client-id': string;
  'oidc-client-secret': string;
}

const techsoup: CommandModule<unknown, ImportCommandArgs> = {
  command: 'techsoup <file>',
  describe: 'Import one TechSoup PDC JSON file into a PDC changemaker',
  builder: {
    ...oidcOptions,
    // Filled from the `<file>` positional in `command`.
    file: { describe: 'Path to the TechSoup PDC JSON file to import', normalize: true, type: 'string' },
    'pdc-api-base-url': { describe: 'Location of PDC API', demandOption: true, type: 'string' },
    'create-changemaker': {
      describe: 'Create a new changemaker from the file (EIN + name); fails if the EIN already exists in the PDC',
      // No `default`: yargs counts a defaulted flag as "set" and would trip `conflicts`.
      type: 'boolean',
      conflicts: 'changemaker-id',
    },
    'changemaker-id': {
      describe: 'Load into the existing changemaker with this ID (default: match the file EIN)',
      demandOption: false,
      type: 'number',
    },
    'dry-run': {
      describe: 'Print the target changemaker and the fields that would be imported; write nothing',
      default: false,
      type: 'boolean',
    },
  },
  handler: async (args): Promise<void> => {
    // Split fields by the PDC's base-field categories: only `organization`
    // fields can be posted to a changemaker.
    const pkg = applyBaseFieldCategories(await readPdcJsonFile(args.file), await getBaseFields(args.pdcApiBaseUrl));
    const changemakers = await getChangemakers(args.pdcApiBaseUrl);
    const plan = planImport(
      pkg,
      changemakers,
      toChangemakerTarget(args.createChangemaker === true, args.changemakerId),
    );

    if (args.dryRun) {
      logger.info('[dry-run] No data will be written to the PDC.');
      for (const line of formatImportPreview(pkg, plan)) {
        logger.info(line);
      }
      return;
    }

    if (plan.action === 'skip') {
      throw new Error(`Not importing ${args.file}: ${plan.reason}`);
    }
    await runImportWrite(pkg, plan, args);
  },
};

export { techsoup };
