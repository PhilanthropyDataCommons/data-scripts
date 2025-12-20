import { writeFile } from 'fs/promises';
import { ApolloClient, InMemoryCache, TypedDocumentNode, gql } from '@apollo/client';
import { SetContextLink } from '@apollo/client/link/context';
import { HttpLink } from '@apollo/client/link/http';
import { isValidEin } from './ein';
import { logger } from './logger';
import { AccessTokenSet, getToken, oidcOptions } from './oidc';
import { getChangemakers, getSources, postSource } from './pdc-api';
import type { CommandModule } from 'yargs';
import type { Source } from '@pdc/sdk';

const CN_SHORT_CODE = 'charitynav';

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

interface NonprofitPublic {
  ein: string,
  name: string,
  updatedAt: string,
  website?: string,
  phone?: string,
  mission?: string,
  encompassRatingId?: number,
  encompassScore?: number,
  encompassStarRating?: number
  encompassPublicationDate?: string,
}

const isNonprofitPublic = (edge: object): edge is NonprofitPublic => {
  if (typeof edge !== "object" || edge === null) {
    return false;
  }
  const obj = edge as Record<string, unknown>;
  return (
    typeof obj.ein === "string" &&
    typeof obj.name === "string" &&
    typeof obj.updated === "string"
  );
}

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

const getOrCreateSource = async (baseUrl: string, token: AccessTokenSet): Promise<Source> => {
  const sources = await getSources(baseUrl, token);
  const filteredSources = sources.entries.filter((s) => s.dataProviderShortCode === CN_SHORT_CODE);
  if (filteredSources.length === 1 && filteredSources[0] !== undefined) {
    // Hurray, an existing Charity Navigator Source was found, return it!
    return Promise.resolve(filteredSources[0]);
  }
  // Create the Charity Navigator Source, we expect/require the Data Provider to exist.
  logger.warn('Have a `pdc-admin` create a source because only administrators may be able.');
  // The following may not succeed, doesn't succeed as of this writing.
  return postSource(baseUrl, token, {
    dataProviderShortCode: CN_SHORT_CODE,
    label: 'Charity Navigator',
  });
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
    // Charity Navigator expects no hyphens, strip them from EINs after validation.
    const validEins = eins.filter(isValidEin).flatMap((e) => e.replace('-', ''));
    const invalidEins = eins.filter((e) => !isValidEin(e));
    if (invalidEins.length > 0) {
      logger.warn(invalidEins, 'These EINs in PDC are invalid and will not be queried');
    }
    logger.info(validEins, 'Found these valid EINs which will be requested from Charity Navigator');
    const charityNavResponse = await getCharityNavigatorProfiles(
      args.charityNavigatorApiKey,
      validEins,
    );
    logger.info({ charityNavResponse }, 'CharityNavigator result');
    // Up to this point we didn't need PDC authentication. Now we do.
    const token = await getToken(
      args.oidcBaseUrl,
      args.oidcClientId,
      args.oidcClientSecret,
    );
    // First, find the existing source. As of this writing, it cannot be created by non-admins.
    const source = await getOrCreateSource(args.pdcApiBaseUrl, token);
    logger.info(source, 'The PDC Source for Charity Navigator was found');
    // Second, post the fields to PDC
    const fieldValues = charityNavResponse.data['nonprofitsPublic']['edges'].flatMap(

    )
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
