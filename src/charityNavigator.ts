import { writeFile } from 'fs/promises';
import { ApolloClient, InMemoryCache, gql } from '@apollo/client';
import { SetContextLink } from '@apollo/client/link/context';
import { HttpLink } from '@apollo/client/link/http';
import { isValidEin } from './ein';
import { logger } from './logger';
import { oidcOptions } from './oidc';
import { getChangemakers } from './pdc-api';
import type { CommandModule } from 'yargs';

const queryNonprofitsPublic = gql`
  query NonprofitsPublic(
    $perPage: Int!
    $filter: NonprofitFilters
  ) {
    nonprofitsPublic(
      filter: $filter
    ) {
        edges {
          ein
          name
          updatedAt
          website
          phone
          mission
          encompassRatingId
          encompassScore
          encompassStarRating
          encompassPublicationDate
        }
        pageInfo {
          totalPages
          totalItems
          currentPage
        }
    }
  }
`;

function apolloInit(apiUrl: string, apiKey: string) {
  const cache = new InMemoryCache();
  const authLink = new SetContextLink((prevContext) => ({
    /* eslint-disable-next-line @typescript-eslint/no-unsafe-assignment --
    Here is the transitive upstream type definition for prevContext:
    export interface DefaultContext extends Record<string, any> {...}
    Therefore apollo defines an `any` type on `headers` through no fault of our own. */
    headers: {
      ...prevContext.headers,
      Authorization: `Bearer ${apiKey}`,
    },
  }));

  const httpLinkPrimary = new HttpLink({
    uri: `${apiUrl}`,
  });
  const apolloClient = new ApolloClient({
    link: authLink.concat(httpLinkPrimary),
    cache,
  });

  return apolloClient;
}
const API_URL = 'https://api.charitynavigator.org/graphql';

const getCharityNavigatorProfiles = async (
  apiKey: string,
  eins: string[],
): Promise<ApolloClient.QueryResult> => {
  logger.info(`Looking up EINs ${JSON.stringify(eins)} in Charity Navigator GraphQL API`);
  const apollo = apolloInit(API_URL, apiKey);
  const variables = {
    filter: {
      ein: {
        in: eins,
      },
    },
    page: 1,
    resultSize: eins.length,
  };
  logger.info(`Fetching charity navigator data for ${JSON.stringify(eins)} using vars ${JSON.stringify(variables)}`);
  return apollo
    .query({
      query: queryNonprofitsPublic,
      variables,
    });
};

interface LookupCommandArgs {
  'charity-navigator-api-key': string;
  eins: string[];
  outputFile?: string;
}

interface UpdateAllCommandArgs {
  'charity-navigator-api-key': string;
  'oidc-base-url': string,
  'oidc-client-id': string,
  'oidc-client-secret': string,
  'pdc-api-base-url': string;
}

const lookupCommand: CommandModule<unknown, LookupCommandArgs> = {
  command: 'lookup',
  describe: 'Fetch and display information about organizations by EIN',
  builder: (y) => (y
    .option('charity-navigator-api-key', {
      describe: 'CharityNavigator API key; get from account management at https://developer.charitynavigator.org/',
      demandOption: true,
      type: 'string',
    })
    .option('output-file', {
      alias: 'write',
      describe: 'Write organization information to the specified JSON file',
      normalize: true,
      type: 'string',
    })
    .option('eins', {
      string: true,
      describe: 'US tax IDs of organizations to look up',
      type: 'array',
      default: [],
    })
    .check(({ eins }) => !(new Set(eins.map(isValidEin)).has(false)))
  ),
  handler: async (args) => {
    const result = await getCharityNavigatorProfiles(args.charityNavigatorApiKey, args.eins)
      .catch((err) => {
        logger.error(err, 'error calling primary graphql api');
        throw err;
      });

    if (args.outputFile) {
      await writeFile(
        args.outputFile,
        JSON.stringify(result, null, 2),
      );
      logger.info(`Wrote CharityNavigator data for ${JSON.stringify(args.ein)} to ${JSON.stringify(args.outputFile)}`);
    } else {
      logger.info({ result }, 'CharityNavigator result');
    }
  },
};

const updateAllCommand: CommandModule<unknown, UpdateAllCommandArgs> = {
  command: 'updateAll',
  describe: 'For each changemaker present in the PDC, get Charity Navigator data and upload it to PDC.',
  builder: {
    ...oidcOptions,
    'charity-navigator-api-key': {
      describe: 'CharityNavigator API key; get from account management at https://developer.charitynavigator.org/',
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
    const changemakers = await getChangemakers(args.pdcApiBaseUrl);
    const eins = changemakers.entries.flatMap((c) => c.taxId);
    // Charity Navigator expects no hyphens, strip them from EINs during validation.
    const validEins = eins.map((e) => (isValidEin(e) ? e.replace('-', '') : null)).filter((e) => e !== null);
    const invalidEins = eins.map((e) => (isValidEin(e) ? null : e)).filter((e) => e !== null);
    if (invalidEins.length > 0) {
      logger.warn(invalidEins, 'These EINs in PDC are invalid and will not be queried');
    }
    logger.info(validEins, 'Found these valid EINs which will be requested from Charity Navigator');
    const result = await getCharityNavigatorProfiles(args.charityNavigatorApiKey, validEins)
      .catch((err) => {
        logger.error(err, 'error calling primary graphql api');
        throw err;
      });
    logger.info({ result }, 'CharityNavigator result');
    // TODO: the posts to PDC
  },
};

const charityNavigator: CommandModule = {
  command: 'charityNavigator',
  describe: 'Interact with the CharityNavigator Premier API',
  builder: (y) => (y
    .command(lookupCommand)
    .command(updateAllCommand)
    .demandCommand(1)
  ),
  handler: () => {},
};
export { charityNavigator };
