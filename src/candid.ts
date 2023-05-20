import { writeFile } from 'fs/promises';
import { client } from './client';
import { logger } from './logger';
import type { CommandModule } from 'yargs';

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

const isValidEin = (s: string): boolean => (
  /^\d{2}-?\d{7}$/.test(s)
);

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

const candid: CommandModule = {
  command: 'candid',
  describe: 'Interact with the Candid Premier API',
  builder: (y) => (y
    .command(lookupCommand)
    .demandCommand()
  ),
  handler: () => {},
};

export { candid };
