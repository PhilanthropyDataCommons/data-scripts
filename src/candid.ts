import { writeFile } from 'fs/promises';
import { client } from './client';
import { isValidEin } from './ein';
import { logger } from './logger';
import { getToken, oidcOptions } from './oidc';
import { getBaseFields, getProposals, postPlatformProviderData } from './pdc-api';
import type { CommandModule } from 'yargs';
import type { AccessTokenSet } from './oidc';

interface CandidPremierResult {
  code: number;
  message: string;
  data: object;
}

const getCandidProfile = async (
  apiKey: string,
  ein: string,
): Promise<CandidPremierResult> => {
  logger.debug(`Looking up EIN ${ein} in Candid Premier API`);
  const { data } = await client.get<CandidPremierResult>(
    `https://api.candid.org/premier/v3/${ein}`,
    {
      headers: {
        'Subscription-Key': apiKey,
      },
    },
  );
  logger.debug(`Fetched Candid data for ${ein}: ${data.message}`);
  return data;
};

interface LookupCommandArgs {
  'candid-api-key': string;
  ein: string;
  outputFile?: string;
}

const lookupCommand: CommandModule<unknown, LookupCommandArgs> = {
  command: 'lookup <ein>',
  describe: 'Fetch and display information about an organization by its EIN',
  builder: (y) => (y
    .option('candid-api-key', {
      describe: 'Candid Premier API key; get from account management at https://dashboard.candid.org/',
      demandOption: true,
      type: 'string',
    })
    .option('output-file', {
      alias: 'write',
      describe: 'Write organization information to the specified JSON file',
      normalize: true,
      type: 'string',
    })
    .positional('ein', {
      describe: 'US tax ID of organization to look up',
      demandOption: true,
      type: 'string',
    })
    .check(({ ein }) => isValidEin(ein))
  ),
  handler: async (args) => {
    const result = await getCandidProfile(args['candid-api-key'], args.ein);

    if (args.outputFile) {
      await writeFile(
        args.outputFile,
        JSON.stringify(result, null, 2),
      );
      logger.info(`Wrote Candid data for ${args.ein} to ${args.outputFile}`);
    } else {
      logger.info({ result }, 'Candid result');
    }
  },
};

const updateCommand: CommandModule = {
  command: 'update <ein>',
  describe: 'Fetch information about an organization by its EIN, and upload to the PDC',
  builder: (y) => (y
    .option('candid-api-key', {
      describe: 'Candid Premier API key; get from account management at https://dashboard.candid.org/',
      demandOption: true,
      type: 'string',
    })
    .options(oidcOptions)
    .option('pdc-api-base-url', {
      describe: 'Location of PDC API',
      demandOption: true,
      type: 'string',
    })
    .positional('ein', {
      describe: 'US tax ID of organization to look up',
      demandOption: true,
      type: 'string',
    })
    .check(({ ein }) => isValidEin(ein))
  ),
  handler: async (args) => {
    const token = await getToken(
      args.oidcBaseUrl as string,
      args.oidcClientId as string,
      args.oidcClientSecret as string,
    );
    const data = await getCandidProfile(
      args.candidApiKey as string,
      args.ein as string,
    );
    await postPlatformProviderData(
      args.pdcApiBaseUrl as string,
      token,
      args.ein as string,
      'candid',
      data,
    );
    logger.info(`Wrote data for ${args.ein as string} to PDC`);
  },
};

const getEinBaseFieldId = async (
  baseUrl: string,
  token: AccessTokenSet,
) => {
  const baseFields = await getBaseFields(baseUrl, token);
  const einBaseField = baseFields.find(({ shortCode }) => (
    shortCode === 'organization_tax_id'
  ));
  if (einBaseField === undefined) {
    throw new Error('Could not find base field with short code `organization_tax_id`');
  }
  return einBaseField.id;
};

const getEinsFromPdc = async (baseUrl: string, token: AccessTokenSet) => {
  const einBaseFieldId = await getEinBaseFieldId(baseUrl, token);
  const proposals = await getProposals(baseUrl, token);

  const eins = new Set(proposals.entries
    .flatMap((proposal) => proposal.versions[0]?.fieldValues)
    .filter(<T>(x: T | undefined): x is T => typeof x !== 'undefined')
    .filter(({ applicationFormField }) => applicationFormField.baseFieldId === einBaseFieldId)
    .map(({ value }) => value)
    .filter(isValidEin));
  return [...eins];
};

interface UpdateAllCommandArgs {
  'candid-api-key': string;
  'oidc-base-url': string,
  'oidc-client-id': string,
  'oidc-client-secret': string,
  'pdc-api-base-url': string;
}

const updateAllCommand: CommandModule<unknown, UpdateAllCommandArgs> = {
  command: 'update-all',
  describe: 'Update Candid profiles for all PDC proposals',
  builder: {
    ...oidcOptions,
    'candid-api-key': {
      describe: 'Candid Premier API key; get from account management at https://dashboard.candid.org/',
      demandOption: true,
      type: 'string',
    },
    'pdc-api-base-url': {
      describe: 'Location of PDC API',
      demandOption: true,
      type: 'string',
    },
  },
  handler: async (args) => {
    const token = await getToken(
      args.oidcBaseUrl,
      args.oidcClientId,
      args.oidcClientSecret,
    );
    const eins = await getEinsFromPdc(args.pdcApiBaseUrl, token);
    logger.info(`Found ${eins.length} valid EINs to look up in Candid`);

    for (let i = 0; i < eins.length; i += 1) {
      /* eslint-disable no-await-in-loop -- Respect Candid's rate limit
       *
       * Note that this use case is specifically called out in the ESLint rule
       * documentation:
       *
       *     loops may be used to prevent your code from sending an excessive
       *     amount of requests in parallel. In such cases it makes sense to
       *     use await within a loop and it is recommended to disable the rule
       *     via a standard ESLint disable comment.
       *
       * https://eslint.org/docs/latest/rules/no-await-in-loop
       */
      const ein = eins[i];
      if (typeof ein !== 'string') {
        break;
      }
      try {
        const { data } = await getCandidProfile(args.candidApiKey, ein);
        await postPlatformProviderData(
          args.pdcApiBaseUrl,
          token,
          ein,
          'candid',
          data,
        );
        logger.debug(`[${i + 1}/${eins.length}] Wrote data for ${ein} to PDC`);
      } catch (error: unknown) {
        logger.error({ error }, `Error loading data for ${ein}`);
      }

      // Our Candid API subscription has a rate limit of 10 calls per
      // minute. Rather than implement 429 request failure handling and
      // exponential backoff, just sleep 6 seconds after each call.
      await new Promise((r) => { setTimeout(r, 6000); });
    }
  },
};

const candid: CommandModule = {
  command: 'candid',
  describe: 'Interact with the Candid Premier API',
  builder: (y) => (y
    .command(lookupCommand)
    .command(updateCommand)
    .command(updateAllCommand)
    .demandCommand()
  ),
  handler: () => {},
};

export { candid };
