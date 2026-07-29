import { writeFile } from 'node:fs/promises';
import { ApolloClient, InMemoryCache, type TypedDocumentNode, gql } from '@apollo/client';
import { SetContextLink } from '@apollo/client/link/context';
import { HttpLink } from '@apollo/client/link/http';
import { AxiosError } from 'axios';
import { isValidEin } from './ein.js';
import { logger } from './logger.js';
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

const CN_SHORT_CODE = 'charitynav';
const JSON_SPACES = 2;
// Fixed page size for Charity Navigator GraphQL requests; a positive
// constant keeps perPage valid when the EIN list is empty (GLM-5.2).
const PER_PAGE = 100;
// When `@pdc/http-status-codes` is ready (issues 18-20 solved), use it instead.
const HTTP_STATUS_FORBIDDEN = 403;

interface NonprofitPublic {
  ein: string;
  name: string;
  updatedAt: string;
  website?: string;
  phone?: string;
  mission?: string;
  encompassRatingId?: number;
  encompassScore?: number;
  encompassStarRating?: number;
  encompassPublicationDate?: string;
  size?: string;
  cause?: string;
}

/** Map from Charity Navigator NonprofitPublic attribute name to PDC base field name */
const baseFieldMap: Array<[keyof NonprofitPublic, string]> = [
  ['name', 'organization_name'],
  ['website', 'organization_website'],
  ['phone', 'organization_phone'],
  ['mission', 'organization_mission_statement'],
];

interface PageInfo {
  totalPages: number;
  totalItems: number;
  currentPage: number;
}

interface NonprofitsPublicResponse {
  nonprofitsPublic: {
    edges: NonprofitPublic[];
    pageInfo: PageInfo;
  };
}

interface NonprofitsPublicVariables {
  page: number;
  perPage: number;
  filter: {
    ein: {
      in: string[];
    };
  };
}

const QueryNonprofitsPublic: TypedDocumentNode<NonprofitsPublicResponse, NonprofitsPublicVariables> = gql`
  query NonprofitsPublic($page: Int!, $perPage: Int!, $filter: NonprofitFilters) {
    nonprofitsPublic(filter: $filter, page: $page, perPage: $perPage) {
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
        size
        cause
      }
      pageInfo {
        totalPages
        totalItems
        currentPage
      }
    }
  }
`;

const isNonprofitPublic = (edge: object): edge is NonprofitPublic => {
  /* eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion --
  Defensive runtime validation of untyped GraphQL response data requires
  asserting a generic object to a record to inspect its properties. */
  const obj = edge as Record<string, unknown>;
  return typeof obj.ein === 'string' && typeof obj.name === 'string' && typeof obj.updatedAt === 'string';
};

function apolloInit(apiUrl: string, apiKey: string): ApolloClient {
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
    uri: apiUrl,
  });
  const apolloClient = new ApolloClient({
    link: authLink.concat(httpLinkPrimary),
    cache,
  });

  return apolloClient;
}
const API_URL = 'https://api.charitynavigator.org/graphql';

const fetchAllPages = async (
  fetchPage: (page: number) => Promise<{ edges: NonprofitPublic[]; pageInfo: PageInfo }>,
): Promise<{ edges: NonprofitPublic[]; pageInfo: PageInfo }> => {
  const allEdges: NonprofitPublic[] = [];
  /* eslint-disable no-await-in-loop -- page-based pagination without cursors
  requires sequential awaited requests (GLM-5.2). */
  for (let page = 1; ; page += 1) {
    const { edges, pageInfo } = await fetchPage(page);
    // The PageInfo.totalPages type is `number`, but the GraphQL response is
    // untyped at runtime: a null/undefined/non-integer totalPages would either
    // loop forever (undefined compares as NaN) or stop after page 1 (null
    // coerces to 0), silently importing a partial result. Reject it loudly
    // instead (GLM-5.2).
    if (!Number.isInteger(pageInfo.totalPages) || pageInfo.totalPages < 1) {
      throw new Error(
        `Charity Navigator returned an invalid totalPages value (${JSON.stringify(pageInfo.totalPages)}) on page ${page}; expected a positive integer`,
      );
    }
    allEdges.push(...edges);
    if (page >= pageInfo.totalPages) {
      return { edges: allEdges, pageInfo };
    }
  }
  /* eslint-enable no-await-in-loop */
};

const extractPageFromResponse = (
  response: { data?: NonprofitsPublicResponse | null },
  page: number,
): { edges: NonprofitPublic[]; pageInfo: PageInfo } => {
  const { data } = response;
  // Apollo types `data` as the parsed payload, but at runtime a partial or
  // errored response can carry null/undefined data. Destructuring either would
  // throw a cryptic TypeError; throw a clear error instead so a malformed page
  // is never mistaken for a complete lookup (GLM-5.2).
  if (data === undefined || data === null) {
    throw new Error(`Charity Navigator GraphQL query returned no data on page ${page}`);
  }
  return data.nonprofitsPublic;
};

const getCharityNavigatorProfiles = async (
  apiKey: string,
  eins: string[],
): Promise<{ data: NonprofitsPublicResponse }> => {
  logger.info(`Looking up EINs ${JSON.stringify(eins)} in Charity Navigator GraphQL API`);
  const apollo = apolloInit(API_URL, apiKey);
  const { edges, pageInfo } = await fetchAllPages(async (page) => {
    const variables: NonprofitsPublicVariables = {
      filter: {
        ein: {
          in: eins,
        },
      },
      page,
      perPage: PER_PAGE,
    };
    logger.info(`Fetching charity navigator data for ${JSON.stringify(eins)} using vars ${JSON.stringify(variables)}`);
    const response = await apollo.query({
      query: QueryNonprofitsPublic,
      variables,
    });
    return extractPageFromResponse(response, page);
  });
  return {
    data: {
      nonprofitsPublic: {
        edges,
        pageInfo,
      },
    },
  };
};

interface LookupCommandArgs {
  'charity-navigator-api-key'?: string;
  eins: string[];
  outputFile?: string;
}

interface LookupFromPdcCommandArgs {
  'charity-navigator-api-key'?: string;
  'pdc-api-base-url': string;
  outputFile?: string;
}

interface UpdateAllCommandArgs {
  'charity-navigator-api-key'?: string;
  'oidc-base-url': string;
  'oidc-client-id': string;
  'oidc-client-secret': string;
  'pdc-api-base-url': string;
}

const lookupCommand: CommandModule<unknown, LookupCommandArgs> = {
  command: 'lookup',
  describe: 'Fetch and display information about organizations by EIN',
  builder: (y) =>
    y
      .option('charity-navigator-api-key', {
        describe:
          'CharityNavigator API key; get from account management at https://developer.charitynavigator.org/ (can also be set via DS_CHARITY_NAVIGATOR_API_KEY env var)',
        demandOption: false,
        type: 'string',
      })
      .check((argv) => {
        if (argv.charityNavigatorApiKey === undefined || argv.charityNavigatorApiKey === '') {
          throw new Error(
            'Missing required argument: charity-navigator-api-key (set via CLI or DS_CHARITY_NAVIGATOR_API_KEY env var)',
          );
        }
        return true;
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
      .check(({ eins }) => !new Set(eins.map(isValidEin)).has(false)),
  handler: async (args) => {
    const { charityNavigatorApiKey: apiKey } = args;
    if (apiKey === undefined || apiKey === '') {
      throw new Error('Missing required argument: charity-navigator-api-key');
    }
    const result = await getCharityNavigatorProfiles(apiKey, args.eins).catch((err: unknown) => {
      logger.error(err, 'error calling primary graphql api');
      throw err;
    });

    if (args.outputFile === undefined || args.outputFile === '') {
      logger.info({ result }, 'CharityNavigator result');
    } else {
      await writeFile(args.outputFile, JSON.stringify(result, null, JSON_SPACES));
      logger.info(`Wrote CharityNavigator data for ${JSON.stringify(args.eins)} to ${JSON.stringify(args.outputFile)}`);
    }
  },
};

const getChangemakerByEin = (ein: string, changemakers: ChangemakerBundle): Changemaker | null => {
  // Make the comparison with hyphens stripped.
  const matches = changemakers.entries.filter((c) => c.taxId.replace('-', '') === ein);
  if (matches.length > 1) {
    logger.warn(`Found multiple changemakers with EIN ${ein}, not returning any.`);
    return null;
  }
  if (matches.length < 1) {
    logger.info(`Found no changemaker with EIN ${ein}`);
    return null;
  }
  if (matches.length === 1 && matches[0] !== undefined) {
    return matches[0];
  }
  throw new Error('How could this have happened?');
};

/** Light wrapper around `postChangemakerFieldValue` that logs warning on HTTP 403 */
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

const lookupFromPdcCommand: CommandModule<unknown, LookupFromPdcCommandArgs> = {
  command: 'lookupFromPdc',
  describe: 'Fetch and display information about organizations present in PDC',
  builder: (y) =>
    y
      .option('charity-navigator-api-key', {
        describe:
          'CharityNavigator API key; get from account management at https://developer.charitynavigator.org/ (can also be set via DS_CHARITY_NAVIGATOR_API_KEY env var)',
        demandOption: false,
        type: 'string',
      })
      .check((argv) => {
        if (argv.charityNavigatorApiKey === undefined || argv.charityNavigatorApiKey === '') {
          throw new Error(
            'Missing required argument: charity-navigator-api-key (set via CLI or DS_CHARITY_NAVIGATOR_API_KEY env var)',
          );
        }
        return true;
      })
      .option('output-file', {
        alias: 'write',
        describe: 'Write organization information to the specified JSON file',
        normalize: true,
        type: 'string',
      })
      .option('pdc-api-base-url', {
        describe: 'Location of PDC API',
        demandOption: true,
        type: 'string',
      }),
  handler: async (args) => {
    const { charityNavigatorApiKey: apiKey, pdcApiBaseUrl } = args;
    if (apiKey === undefined || apiKey === '') {
      throw new Error('Missing required argument: charity-navigator-api-key');
    }
    if (pdcApiBaseUrl === '') {
      throw new Error('Missing required argument: pdc-api-base-url');
    }
    const changemakers = await getChangemakers(args.pdcApiBaseUrl);
    const eins = changemakers.entries.flatMap((c) => c.taxId);
    // Charity Navigator expects no hyphens, strip them from EINs after validation.
    const validEins = eins.filter(isValidEin).flatMap((e) => e.replace('-', ''));
    const invalidEins = eins.filter((e) => !isValidEin(e));
    if (invalidEins.length > 0) {
      logger.warn(invalidEins, 'These EINs in PDC are invalid and will not be queried');
    }
    logger.info(validEins, 'Found these valid EINs which will be requested from Charity Navigator');
    const charityNavResponse = await getCharityNavigatorProfiles(apiKey, validEins);
    if (args.outputFile === undefined || args.outputFile === '') {
      logger.info({ charityNavResponse }, 'CharityNavigator result');
      const {
        data: {
          nonprofitsPublic: { edges },
        },
      } = charityNavResponse;
      const nonprofits = edges.filter((e): e is NonprofitPublic => isNonprofitPublic(e));
      const changemakerIds = nonprofits
        .map((e) => getChangemakerByEin(e.ein, changemakers))
        .filter((c) => c !== null)
        .map((c) => c.id);
      logger.info({ changemakerIds }, 'Changemaker IDs present in CharityNavigator');
    } else {
      await writeFile(args.outputFile, JSON.stringify(charityNavResponse, null, JSON_SPACES));
      logger.info(`Wrote CharityNavigator data for ${JSON.stringify(validEins)} to ${JSON.stringify(args.outputFile)}`);
    }
  },
};

const getOrCreateSource = async (baseUrl: string, token: AccessTokenSet): Promise<Source> => {
  const sources = await getSources(baseUrl, token);
  const filteredSources = sources.entries.filter((s) => s.dataProviderShortCode === CN_SHORT_CODE);
  if (filteredSources.length === 1 && filteredSources[0] !== undefined) {
    // Hurray, an existing Charity Navigator Source was found, return it!
    return filteredSources[0];
  }
  // Create the Charity Navigator Source, we expect/require the Data Provider to exist.
  logger.warn('Have a `pdc-admin` create a source because only administrators may be able.');
  // The following may not succeed, doesn't succeed as of this writing.
  return await postSource(baseUrl, token, {
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
      describe:
        'CharityNavigator API key; get from account management at https://developer.charitynavigator.org/ (can also be set via DS_CHARITY_NAVIGATOR_API_KEY env var)',
      demandOption: false,
      type: 'string',
    },
    'pdc-api-base-url': {
      describe: 'Location of PDC API',
      demandOption: true,
      type: 'string',
    },
  },
  handler: async (args) => {
    const { charityNavigatorApiKey: apiKey } = args;
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        'Missing required argument: charity-navigator-api-key (set via CLI or DS_CHARITY_NAVIGATOR_API_KEY env var)',
      );
    }
    const changemakers = await getChangemakers(args.pdcApiBaseUrl);
    const eins = changemakers.entries.flatMap((c) => c.taxId);
    // Charity Navigator expects no hyphens, strip them from EINs after validation.
    const validEins = eins.filter(isValidEin).flatMap((e) => e.replace('-', ''));
    const invalidEins = eins.filter((e) => !isValidEin(e));
    if (invalidEins.length > 0) {
      logger.warn(invalidEins, 'These EINs in PDC are invalid and will not be queried');
    }
    logger.info(validEins, 'Found these valid EINs which will be requested from Charity Navigator');
    const charityNavResponse = await getCharityNavigatorProfiles(apiKey, validEins);
    logger.info({ charityNavResponse }, 'CharityNavigator result');
    // Up to this point we didn't need PDC authentication. Now we do.
    const token = await getToken(args.oidcBaseUrl, args.oidcClientId, args.oidcClientSecret);
    // First, find the existing source. As of this writing, it cannot be created by non-admins.
    const source = await getOrCreateSource(args.pdcApiBaseUrl, token);
    logger.info(source, 'The PDC Source for Charity Navigator was found');
    // Second, post the fields to PDC
    const {
      data: {
        nonprofitsPublic: { edges },
      },
    } = charityNavResponse;
    const nonprofits = edges.filter((e): e is NonprofitPublic => isNonprofitPublic(e));
    logger.info(nonprofits, 'Found these nonprofits');
    // Third, register a batch of changemaker fields to be posted
    const fieldBatch = await postChangemakerFieldValueBatch(args.pdcApiBaseUrl, token, {
      sourceId: source.id,
      notes: `data-scripts charityNavigator.ts execution ${Date.now()}`,
    });
    const missingPermissionChangemakerIds: Set<number> = new Set<number>();
    // Last, for each nonprofit, for each field, post the field. These are
    // issued sequentially rather than via Promise.all because the PDC API
    // times out under concurrent POSTs to /changemakerFieldValues.
    /* eslint-disable no-await-in-loop -- sequential POSTs avoid PDC API
    connection saturation (GLM-5.2). */
    for (const e of nonprofits) {
      const changemaker = getChangemakerByEin(e.ein, changemakers);
      if (changemaker !== null) {
        for (const [cnAttributeName, baseFieldShortCode] of baseFieldMap) {
          const { [cnAttributeName]: cnAttribute } = e;
          /* eslint-disable-next-line @typescript-eslint/no-unnecessary-condition --
          The cnAttribute can really be null even though types say otherwise. */
          if (cnAttribute !== undefined && cnAttribute !== null) {
            const fieldValue = {
              changemakerId: changemaker.id,
              batchId: fieldBatch.id,
              baseFieldShortCode,
              value: cnAttribute.toString(),
              goodAsOf: e.updatedAt,
            };
            await postChangemakerFieldValueWarnOnForbidden(
              args.pdcApiBaseUrl,
              token,
              fieldValue,
              missingPermissionChangemakerIds,
            );
          }
        }
      }
    }
    /* eslint-enable no-await-in-loop */
    if (missingPermissionChangemakerIds.size > 0) {
      logger.warn(
        `No permission for at least one field in each of these changemakers (so not updated): ${JSON.stringify([...missingPermissionChangemakerIds])}`,
      );
    }
  },
};

const charityNavigator: CommandModule = {
  command: 'charityNavigator',
  describe: 'Interact with the CharityNavigator Premier API',
  builder: (y) => y.command(lookupCommand).command(lookupFromPdcCommand).command(updateAllCommand).demandCommand(1),
  /* eslint-disable-next-line @typescript-eslint/no-empty-function -- yargs demandCommand handles routing to subcommands */
  handler: () => {},
};
export { charityNavigator, extractPageFromResponse, fetchAllPages };
