import { writeFile } from 'fs/promises';
import { ApolloClient, InMemoryCache, gql } from '@apollo/client';
import { SetContextLink } from '@apollo/client/link/context';
import { HttpLink } from '@apollo/client/link/http';
import { isValidEin } from './ein';
import { logger } from './logger';
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
  const authLink = new SetContextLink(({ headers }) => ({
    headers: {
      ...headers,
      Authorization: apiKey,
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
  logger.debug(`Looking up EINs ${JSON.stringify(eins)} in Charity Navigator GraphQL API`);
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
  logger.debug(`Fetching charity navigator data for ${JSON.stringify(eins)} using vars ${JSON.stringify(variables)}`);
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

const charityNavigator: CommandModule = {
  command: 'charityNavigator',
  describe: 'Interact with the CharityNavigator Premier API',
  builder: (y) => (y
    .command(lookupCommand)
    .demandCommand(2)
  ),
  handler: () => {},
};
export { charityNavigator };
