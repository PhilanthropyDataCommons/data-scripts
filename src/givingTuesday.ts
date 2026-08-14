import { writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { AxiosError } from 'axios';
import { client } from './client.js';
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

const GT_SHORT_CODE = 'givingtuesday';
const JSON_SPACES = 2;
// When `@pdc/http-status-codes` is ready (issues 18-20 solved), use it instead.
const HTTP_STATUS_FORBIDDEN = 403;
// GivingTuesday's open-access API allows 300 requests per 5 minutes (1/sec).
// Sleep between per-EIN requests rather than implementing 429 backoff, matching
// the approach used for Candid.
const RATE_LIMIT_DELAY_MS = 1100;
// GivingTuesday requires zero-padded, 9-digit EINs with no hyphens.
const EIN_LENGTH = 9;
// Month and day components are padded to two characters for ISO dates.
const DATE_PART_LENGTH = 2;

const API_BASE_URL = 'https://990-infrastructure.gtdata.org';
// The published endpoint table renders `/irs_data/`, but the working sample
// requests (and the live API) use the hyphenated `/irs-data/` path.
const BMF_PATH = '/irs-data/bmf';

/**
 * A single record from the IRS Business Master File (BMF) endpoint. All fields
 * beyond `ein` are optional and, at runtime, may be null: the IRS data is
 * sparse and the API is untyped. Numeric IRS codes (ruling_date, tax_period,
 * classification_codes, ...) arrive as either numbers or strings depending on
 * the field, so they are typed as `number | string` and stringified on the way
 * into the PDC.
 */
interface BmfRecord {
  ein: string;
  primary_name_of_organization?: string | null;
  street_address?: string | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
  subsection_descrip?: string | null;
  classification_codes?: number | string | null;
  foundation_code?: string | null;
  foundation_descrip?: string | null;
  national_taxonomy_of_exempt_entities_ntee_code?: string | null;
  deductibility_code?: number | string | null;
  deductability_descrip?: string | null;
  ruling_date?: number | string | null;
  tax_period?: number | string | null;
  // `YYYY_MM_DD`, e.g. `2024_02_13`; used to derive each field value's goodAsOf.
  Date_Released?: string | null;
  Date_Processed?: string | null;
}

/** Map from GivingTuesday BMF attribute name to PDC base field short code */
const baseFieldMap: Array<[keyof BmfRecord, string]> = [
  ['primary_name_of_organization', 'organization_irs_name'],
  ['street_address', 'organization_irs_address'],
  ['city', 'organization_irs_city'],
  ['state', 'organization_irs_state'],
  ['zip_code', 'organization_irs_zip'],
  ['subsection_descrip', 'organization_irs_subsection'],
  ['classification_codes', 'organization_irs_classification'],
  ['foundation_descrip', 'organization_irs_foundation_information'],
  ['foundation_code', 'organization_foundation_code'],
  ['national_taxonomy_of_exempt_entities_ntee_code', 'organization_ntee_code'],
  ['deductibility_code', 'organization_deductibility_code'],
  ['deductability_descrip', 'organization_deductibility_status'],
  ['ruling_date', 'organization_ruling_date'],
  ['tax_period', 'organization_tax_period'],
];

interface GivingTuesdayResponseBody<T> {
  query: string;
  no_results: number;
  results: T[];
}

interface GivingTuesdayResponse<T> {
  statusCode: number;
  body: GivingTuesdayResponseBody<T>;
}

const isBmfRecord = (result: object): result is BmfRecord => {
  /* eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion --
  Defensive runtime validation of untyped REST response data requires asserting
  a generic object to a record to inspect its properties. */
  const obj = result as Record<string, unknown>;
  return typeof obj.ein === 'string' && typeof obj.primary_name_of_organization === 'string';
};

/**
 * Convert GivingTuesday's `Date_Released`/`Date_Processed` format (`YYYY_MM_DD`,
 * with month/day not necessarily zero-padded) to an ISO `YYYY-MM-DD` date for
 * use as a field value's goodAsOf. Returns null when the input is missing or
 * cannot be parsed, since goodAsOf is nullable in the PDC.
 */
const parseGivingTuesdayDate = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const match = /^(?<year>\d{4})_(?<month>\d{1,2})_(?<day>\d{1,2})$/v.exec(value);
  const { groups } = match ?? {};
  if (groups === undefined) {
    return null;
  }
  const { year, month, day } = groups;
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  return `${year}-${month.padStart(DATE_PART_LENGTH, '0')}-${day.padStart(DATE_PART_LENGTH, '0')}`;
};

/** Normalize an EIN to the zero-padded, hyphen-free 9-digit form GivingTuesday expects. */
const toGivingTuesdayEin = (ein: string): string => ein.replace('-', '').padStart(EIN_LENGTH, '0');

/**
 * Validate an untyped GivingTuesday response and return its `results` array.
 * Apollo-style, the transport types the payload as parsed, but a partial or
 * errored response can carry a missing body/results; throw a clear error so a
 * malformed lookup is never mistaken for "no records found".
 */
const extractResultsFromResponse = <T>(response: GivingTuesdayResponse<T> | null | undefined, ein: string): T[] => {
  if (response === undefined || response === null) {
    throw new Error(`GivingTuesday query returned no data for EIN ${ein}`);
  }
  const { body } = response;
  /* eslint-disable-next-line @typescript-eslint/no-unnecessary-condition --
  body is typed as present but the untyped runtime response can omit it. */
  if (body === undefined || body === null || !Array.isArray(body.results)) {
    throw new Error(`GivingTuesday returned a malformed response for EIN ${ein}: ${JSON.stringify(response)}`);
  }
  return body.results;
};

/** Fetch the BMF record(s) for a single EIN from the GivingTuesday API. */
const getGivingTuesdayBmfRecords = async (ein: string): Promise<BmfRecord[]> => {
  const gtEin = toGivingTuesdayEin(ein);
  logger.info(`Looking up EIN ${gtEin} in GivingTuesday BMF API`);
  const { data } = await client.get<GivingTuesdayResponse<BmfRecord>>(`${API_BASE_URL}${BMF_PATH}`, {
    params: { ein: gtEin },
  });
  return extractResultsFromResponse(data, gtEin);
};

/**
 * Fetch BMF records for many EINs, one request per EIN, sleeping between
 * requests to stay under GivingTuesday's rate limit. A failure for one EIN is
 * logged and skipped so a single bad lookup doesn't abort the whole run.
 */
const getGivingTuesdayProfiles = async (eins: string[]): Promise<{ data: { results: BmfRecord[] } }> => {
  const results: BmfRecord[] = [];
  /* eslint-disable no-await-in-loop -- sequential, rate-limited requests: the
  GivingTuesday API is one EIN per request and capped at 300 requests / 5 min. */
  for (const [i, ein] of eins.entries()) {
    try {
      const records = await getGivingTuesdayBmfRecords(ein);
      results.push(...records);
      logger.debug(`[${i + 1}/${eins.length}] Fetched ${records.length} BMF record(s) for ${ein}`);
    } catch (error: unknown) {
      logger.error({ error }, `Error loading GivingTuesday data for ${ein}`);
    }
    await setTimeout(RATE_LIMIT_DELAY_MS);
  }
  /* eslint-enable no-await-in-loop */
  return { data: { results } };
};

interface LookupCommandArgs {
  eins: string[];
  outputFile?: string;
}

interface LookupFromPdcCommandArgs {
  'pdc-api-base-url': string;
  outputFile?: string;
}

interface UpdateAllCommandArgs {
  'oidc-base-url': string;
  'oidc-client-id': string;
  'oidc-client-secret': string;
  'pdc-api-base-url': string;
}

const lookupCommand: CommandModule<unknown, LookupCommandArgs> = {
  command: 'lookup',
  describe: 'Fetch and display GivingTuesday BMF information about organizations by EIN',
  builder: (y) =>
    y
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
    const result = await getGivingTuesdayProfiles(args.eins).catch((err: unknown) => {
      logger.error(err, 'error calling GivingTuesday api');
      throw err;
    });

    if (args.outputFile === undefined || args.outputFile === '') {
      logger.info({ result }, 'GivingTuesday result');
    } else {
      await writeFile(args.outputFile, JSON.stringify(result, null, JSON_SPACES));
      logger.info(`Wrote GivingTuesday data for ${JSON.stringify(args.eins)} to ${JSON.stringify(args.outputFile)}`);
    }
  },
};

const getChangemakerByEin = (ein: string, changemakers: ChangemakerBundle): Changemaker | null => {
  // Make the comparison with hyphens stripped and zero-padded to match the
  // normalized EIN GivingTuesday echoes back in its records.
  const normalized = toGivingTuesdayEin(ein);
  const matches = changemakers.entries.filter((c) => toGivingTuesdayEin(c.taxId) === normalized);
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
  describe: 'Fetch and display GivingTuesday information about organizations present in PDC',
  builder: (y) =>
    y
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
    const { pdcApiBaseUrl } = args;
    if (pdcApiBaseUrl === '') {
      throw new Error('Missing required argument: pdc-api-base-url');
    }
    const changemakers = await getChangemakers(pdcApiBaseUrl);
    const eins = changemakers.entries.flatMap((c) => c.taxId);
    const validEins = eins.filter(isValidEin);
    const invalidEins = eins.filter((e) => !isValidEin(e));
    if (invalidEins.length > 0) {
      logger.warn(invalidEins, 'These EINs in PDC are invalid and will not be queried');
    }
    logger.info(validEins, 'Found these valid EINs which will be requested from GivingTuesday');
    const givingTuesdayResponse = await getGivingTuesdayProfiles(validEins);
    if (args.outputFile === undefined || args.outputFile === '') {
      logger.info({ givingTuesdayResponse }, 'GivingTuesday result');
      const {
        data: { results },
      } = givingTuesdayResponse;
      const nonprofits = results.filter((r): r is BmfRecord => isBmfRecord(r));
      const changemakerIds = nonprofits
        .map((r) => getChangemakerByEin(r.ein, changemakers))
        .filter((c) => c !== null)
        .map((c) => c.id);
      logger.info({ changemakerIds }, 'Changemaker IDs present in GivingTuesday');
    } else {
      await writeFile(args.outputFile, JSON.stringify(givingTuesdayResponse, null, JSON_SPACES));
      logger.info(`Wrote GivingTuesday data for ${JSON.stringify(validEins)} to ${JSON.stringify(args.outputFile)}`);
    }
  },
};

const getOrCreateSource = async (baseUrl: string, token: AccessTokenSet): Promise<Source> => {
  const sources = await getSources(baseUrl, token);
  const filteredSources = sources.entries.filter((s) => s.dataProviderShortCode === GT_SHORT_CODE);
  if (filteredSources.length === 1 && filteredSources[0] !== undefined) {
    // Hurray, an existing GivingTuesday Source was found, return it!
    return filteredSources[0];
  }
  // Create the GivingTuesday Source, we expect/require the Data Provider to exist.
  logger.warn('Have a `pdc-admin` create a source because only administrators may be able.');
  // The following may not succeed, doesn't succeed as of this writing.
  return await postSource(baseUrl, token, {
    dataProviderShortCode: GT_SHORT_CODE,
    label: 'GivingTuesday',
  });
};

const updateAllCommand: CommandModule<unknown, UpdateAllCommandArgs> = {
  command: 'updateAll',
  describe: 'For each changemaker present in the PDC, get GivingTuesday data and upload it to PDC.',
  builder: {
    ...oidcOptions,
    'pdc-api-base-url': {
      describe: 'Location of PDC API',
      demandOption: true,
      type: 'string',
    },
  },
  handler: async (args) => {
    const changemakers = await getChangemakers(args.pdcApiBaseUrl);
    const eins = changemakers.entries.flatMap((c) => c.taxId);
    const validEins = eins.filter(isValidEin);
    const invalidEins = eins.filter((e) => !isValidEin(e));
    if (invalidEins.length > 0) {
      logger.warn(invalidEins, 'These EINs in PDC are invalid and will not be queried');
    }
    logger.info(validEins, 'Found these valid EINs which will be requested from GivingTuesday');
    const givingTuesdayResponse = await getGivingTuesdayProfiles(validEins);
    logger.info({ givingTuesdayResponse }, 'GivingTuesday result');
    // Up to this point we didn't need PDC authentication. Now we do.
    const token = await getToken(args.oidcBaseUrl, args.oidcClientId, args.oidcClientSecret);
    // First, find the existing source. As of this writing, it cannot be created by non-admins.
    const source = await getOrCreateSource(args.pdcApiBaseUrl, token);
    logger.info(source, 'The PDC Source for GivingTuesday was found');
    // Second, collect the well-formed nonprofit records.
    const {
      data: { results },
    } = givingTuesdayResponse;
    const nonprofits = results.filter((r): r is BmfRecord => isBmfRecord(r));
    logger.info(nonprofits, 'Found these nonprofits');
    // Third, register a batch of changemaker fields to be posted.
    const fieldBatch = await postChangemakerFieldValueBatch(args.pdcApiBaseUrl, token, {
      sourceId: source.id,
      notes: `data-scripts givingTuesday.ts execution ${Date.now()}`,
    });
    const missingPermissionChangemakerIds: Set<number> = new Set<number>();
    // Last, for each nonprofit, for each field, post the field. These are
    // issued sequentially rather than via Promise.all because the PDC API
    // times out under concurrent POSTs to /changemakerFieldValues.
    /* eslint-disable no-await-in-loop -- sequential POSTs avoid PDC API
    connection saturation. */
    for (const record of nonprofits) {
      const changemaker = getChangemakerByEin(record.ein, changemakers);
      if (changemaker !== null) {
        const goodAsOf = parseGivingTuesdayDate(record.Date_Released);
        for (const [gtAttributeName, baseFieldShortCode] of baseFieldMap) {
          const { [gtAttributeName]: gtAttribute } = record;
          if (gtAttribute !== undefined && gtAttribute !== null && gtAttribute !== '') {
            const fieldValue = {
              changemakerId: changemaker.id,
              batchId: fieldBatch.id,
              baseFieldShortCode,
              value: gtAttribute.toString(),
              goodAsOf,
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

const givingTuesday: CommandModule = {
  command: 'givingTuesday',
  describe: 'Interact with the GivingTuesday 990 Data API',
  builder: (y) => y.command(lookupCommand).command(lookupFromPdcCommand).command(updateAllCommand).demandCommand(1),
  /* eslint-disable-next-line @typescript-eslint/no-empty-function -- yargs demandCommand handles routing to subcommands */
  handler: () => {},
};

export { extractResultsFromResponse, givingTuesday, isBmfRecord, parseGivingTuesdayDate, toGivingTuesdayEin };
