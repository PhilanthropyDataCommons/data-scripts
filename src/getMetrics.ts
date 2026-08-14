import { writeFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AxiosError } from 'axios';
import { Issuer, generators } from 'openid-client';
import { client } from './client.js';
import { logger } from './logger.js';
import { getToken } from './oidc.js';
import type { CommandModule } from 'yargs';

// ---------------------------------------------------------------------------
// Defaults & constants
// ---------------------------------------------------------------------------

const DEFAULT_PDC_API_BASE_URL = 'https://api.philanthropydatacommons.org/';
const DEFAULT_OIDC_BASE_URL = 'https://auth.philanthropydatacommons.org/realms/pdc';
// The PDC web application ("bulk uploader") is a public OIDC client. It is used
// here as the default for the interactive authorization-code flow. NOTE: for
// the browser flow to succeed, this client (or whichever `--oidc-client-id` you
// pass) MUST have the loopback redirect URI `http://localhost:<port>/callback`
// registered in Keycloak. If it does not, either register one (a one-time admin
// task) or skip the browser flow entirely by passing `--access-token` / setting
// DS_ACCESS_TOKEN. See src/getMetrics-report.md for details.
const DEFAULT_OIDC_CLIENT_ID = 'pdc-bulk-uploader';
const DEFAULT_CALLBACK_PORT = 9736;
const CALLBACK_PATH = '/callback';
// How long to wait for the caller to complete the browser login before giving up.
const AUTH_TIMEOUT_MS = 300_000;
const JSON_SPACES = 2;
// First probe requests a single item: well-behaved endpoints report the full
// `total` even at `_count=1`, so a page size of 1 keeps that common case cheap.
const PROBE_PAGE = '1';
const PROBE_COUNT = '1';
// A `total` of 0 or 1 is indistinguishable from a page-scoped value at
// `_count=1`, so it is treated as ambiguous and triggers a full fetch.
const AMBIGUOUS_TOTAL_MAX = 1;
// Fallback page size for the full fetch — large enough to pull every item in any
// current PDC collection in one request (mirrors the other data-scripts, which
// read entire collections with counts in the millions).
const FETCH_COUNT = '1000000';
const FETCH_COUNT_CEILING = 1_000_000;

// When `@pdc/http-status-codes` is ready (issues 18-20 solved), use it instead.
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_OK = 200;

// ---------------------------------------------------------------------------
// Endpoint catalogue
// ---------------------------------------------------------------------------

interface PdcEndpoint {
  /** Collection path, relative to the API base URL (no leading slash needed). */
  path: string;
  /** Human-friendly label for the report. */
  label: string;
  /**
   * Whether the endpoint is readable anonymously. `baseFields` and
   * `changemakers` are public; everything else requires a bearer token. This is
   * informational only — the script reports the actual outcome regardless.
   */
  public: boolean;
}

/**
 * Top-level PDC collection endpoints. Each returns a "bundle"
 * (`{ entries: [...], total: <number> }`), so the item count is read straight
 * from `total`. This list mirrors the bundle types exposed by `@pdc/sdk` that
 * resolve to a real top-level route on the live API; add or remove entries here
 * as the API surface changes.
 */
const PDC_ENDPOINTS: PdcEndpoint[] = [
  { path: 'baseFields', label: 'Base Fields', public: true },
  { path: 'changemakers', label: 'Changemakers', public: true },
  { path: 'proposals', label: 'Proposals', public: false },
  { path: 'sources', label: 'Sources', public: false },
  { path: 'dataProviders', label: 'Data Providers', public: false },
  { path: 'funders', label: 'Funders', public: false },
  { path: 'opportunities', label: 'Opportunities', public: false },
  { path: 'users', label: 'Users', public: false },
  { path: 'changemakerFieldValues', label: 'Changemaker Field Values', public: false },
  { path: 'changemakerFieldValueBatches', label: 'Changemaker Field Value Batches', public: false },
  { path: 'changemakerProposals', label: 'Changemaker–Proposal Links', public: false },
  { path: 'applicationForms', label: 'Application Forms', public: false },
  { path: 'terminologySets', label: 'Terminology Sets', public: false },
  { path: 'permissionGrants', label: 'Permission Grants', public: false },
  { path: 'files', label: 'Files', public: false },
];

// ---------------------------------------------------------------------------
// Metric collection
// ---------------------------------------------------------------------------

type MetricStatus = 'ok' | 'unauthorized' | 'forbidden' | 'not_found' | 'error';

interface EndpointMetric {
  path: string;
  label: string;
  /** Item count from the endpoint's `total`, or null when it could not be read. */
  count: number | null;
  status: MetricStatus;
  note: string;
}

/** The shape we care about in a bundle response; runtime data is untyped. */
interface CountableBundle {
  total?: number;
  entries?: unknown[];
}

/** Extract the numeric `total` and the entry-array length from a bundle, or null when absent. */
const readBundle = (data: CountableBundle): { total: number | null; entriesLength: number | null } => ({
  total: typeof data.total === 'number' ? data.total : null,
  entriesLength: Array.isArray(data.entries) ? data.entries.length : null,
});

/** Map an HTTP status from a failed request to a metric status + note. */
const classifyHttpError = (status: number | undefined): { status: MetricStatus; note: string } => {
  if (status === HTTP_STATUS_UNAUTHORIZED) {
    return { status: 'unauthorized', note: 'Authentication required (no valid token supplied)' };
  }
  if (status === HTTP_STATUS_FORBIDDEN) {
    return { status: 'forbidden', note: 'Token lacks permission to read this collection' };
  }
  if (status === HTTP_STATUS_NOT_FOUND) {
    return { status: 'not_found', note: 'Endpoint not found (route may have moved or been removed)' };
  }
  return { status: 'error', note: `Unexpected HTTP status ${String(status)}` };
};

/**
 * Turn a fully-fetched bundle's `total` / entry count into a count + status +
 * note. The reported count is the larger of `total` and the number of entries
 * returned, so neither a missing/short `total` nor a truncated page undercounts.
 */
const resolveFullCount = (
  total: number | null,
  entriesLength: number | null,
): { count: number | null; status: MetricStatus; note: string } => {
  if (total === null && entriesLength === null) {
    return { count: null, status: 'error', note: 'Response had neither a `total` nor an `entries` array' };
  }
  const count = Math.max(total ?? 0, entriesLength ?? 0);
  if (entriesLength !== null && entriesLength >= FETCH_COUNT_CEILING) {
    return {
      count,
      status: 'ok',
      note: `Count is a floor; collection has at least ${FETCH_COUNT_CEILING.toLocaleString('en-US')} items`,
    };
  }
  const note = total === null ? 'No numeric `total` in response; counted the entries returned' : '';
  return { count, status: 'ok', note };
};

/**
 * Read the item count for a single endpoint.
 *
 * A cheap `_count=1` probe is enough for well-behaved endpoints: they report the
 * full `total` even on a one-item page, so any `total > 1` is taken as-is. When
 * the probe's `total` is missing, 0, or 1 — indistinguishable from a page-scoped
 * value — the whole collection is fetched (`_count=1000000`) and interpreted by
 * `resolveFullCount`.
 *
 * Returns a fully-populated metric, never throws: transport and HTTP errors are
 * folded into the metric's status.
 */
const getEndpointCount = async (
  baseUrl: string,
  endpoint: PdcEndpoint,
  accessToken: string | undefined,
): Promise<EndpointMetric> => {
  const url = new URL(endpoint.path, baseUrl).toString();
  const headers = accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` };
  const metric = (count: number | null, status: MetricStatus, note: string): EndpointMetric => ({
    path: endpoint.path,
    label: endpoint.label,
    count,
    status,
    note,
  });
  try {
    const probe = await client.get<CountableBundle>(url, {
      headers,
      params: { _page: PROBE_PAGE, _count: PROBE_COUNT },
    });
    const probeRead = readBundle(probe.data);
    logger.debug(
      { endpoint: endpoint.path, total: probeRead.total, entries: probeRead.entriesLength },
      'probe response (_count=1)',
    );
    if (probeRead.total !== null && probeRead.total > AMBIGUOUS_TOTAL_MAX) {
      // Unambiguous grand total (a one-item page could never report >1), trust it.
      return metric(probeRead.total, 'ok', '');
    }

    // Ambiguous or missing total: fetch the whole collection and count directly.
    const full = await client.get<CountableBundle>(url, {
      headers,
      params: { _page: PROBE_PAGE, _count: FETCH_COUNT },
    });
    const { total, entriesLength } = readBundle(full.data);
    logger.debug({ endpoint: endpoint.path, total, entries: entriesLength }, `full response (_count=${FETCH_COUNT})`);
    const resolved = resolveFullCount(total, entriesLength);
    return metric(resolved.count, resolved.status, resolved.note);
  } catch (error: unknown) {
    if (error instanceof AxiosError) {
      const { status, note } = classifyHttpError(error.response?.status);
      return metric(null, status, note);
    }
    const message = error instanceof Error ? error.message : String(error);
    return metric(null, 'error', message);
  }
};

/**
 * Collect counts for every endpoint. Requests are issued sequentially rather
 * than via `Promise.all`, matching the other data-scripts' gentleness toward
 * the PDC API.
 */
const collectMetrics = async (
  baseUrl: string,
  endpoints: PdcEndpoint[],
  accessToken: string | undefined,
): Promise<EndpointMetric[]> => {
  const metrics: EndpointMetric[] = [];
  /* eslint-disable no-await-in-loop -- sequential reads to avoid hammering the
  PDC API with concurrent requests. */
  for (const endpoint of endpoints) {
    const metric = await getEndpointCount(baseUrl, endpoint, accessToken);
    logger.info(`${endpoint.label}: ${metric.count ?? metric.status}`);
    metrics.push(metric);
  }
  /* eslint-enable no-await-in-loop */
  return metrics;
};

/**
 * Return a copy of the metrics sorted alphabetically (case-insensitively) by
 * endpoint path — the primary column shown in every output format.
 */
const sortMetrics = (metrics: EndpointMetric[]): EndpointMetric[] =>
  [...metrics].sort((a, b) => a.path.localeCompare(b.path, 'en-US', { sensitivity: 'base' }));

// ---------------------------------------------------------------------------
// Interactive (browser) authentication — OAuth 2.0 authorization code + PKCE
// ---------------------------------------------------------------------------

/** Best-effort cross-platform "open this URL in the default browser". */
const openBrowser = (url: string): void => {
  const command =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, (error) => {
    if (error !== null) {
      logger.warn(`Could not open a browser automatically. Please open this URL manually:\n${url}`);
    }
  });
};

/** HTML shown in the browser tab once the callback has been received. */
const CALLBACK_SUCCESS_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>PDC authentication</title></head>' +
  '<body style="font-family:sans-serif;padding:2rem"><h1>Authentication complete</h1>' +
  '<p>You may close this tab and return to the terminal.</p></body></html>';

/**
 * Run the OAuth 2.0 authorization-code flow (with PKCE) against the PDC
 * Keycloak realm, using the caller's browser. Spins up a throwaway localhost
 * HTTP server to catch the redirect, exchanges the code for a token, and
 * resolves with the access token. Rejects on timeout or auth error.
 */
const authenticateInteractively = async (oidcBaseUrl: string, clientId: string, port: number): Promise<string> => {
  const issuer = await Issuer.discover(oidcBaseUrl);
  logger.debug(`Discovered OIDC issuer at ${issuer.metadata.issuer}`);
  const redirectUri = `http://localhost:${String(port)}${CALLBACK_PATH}`;

  const oidcClient = new issuer.Client({
    client_id: clientId,
    redirect_uris: [redirectUri],
    response_types: ['code'],
    // Public client: no secret, PKCE protects the exchange.
    token_endpoint_auth_method: 'none',
  });

  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);
  const state = generators.state();
  const authorizationUrl = oidcClient.authorizationUrl({
    scope: 'openid',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  // A deferred lets the request handler (an event callback) settle the outcome.
  let resolveToken: (token: string) => void = () => undefined;
  let rejectToken: (error: Error) => void = () => undefined;
  /* eslint-disable-next-line promise/avoid-new -- bridging Node's event-driven
  HTTP server, a timeout, and the token exchange into a single awaitable. */
  const tokenPromise = new Promise<string>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? '', redirectUri);
    if (requestUrl.pathname !== CALLBACK_PATH) {
      res.writeHead(HTTP_STATUS_NOT_FOUND);
      res.end();
      return;
    }
    const params = oidcClient.callbackParams(req);
    oidcClient
      .callback(redirectUri, params, { code_verifier: codeVerifier, state })
      .then((tokenSet) => {
        res.writeHead(HTTP_STATUS_OK, { 'content-type': 'text/html' });
        res.end(CALLBACK_SUCCESS_HTML);
        const { access_token: accessToken } = tokenSet;
        if (accessToken === undefined) {
          rejectToken(new Error('Authorization succeeded but no access token was returned'));
        } else {
          resolveToken(accessToken);
        }
      })
      .catch((err: unknown) => {
        res.writeHead(HTTP_STATUS_OK, { 'content-type': 'text/html' });
        res.end('<p>Authentication failed. Check the terminal for details.</p>');
        rejectToken(err instanceof Error ? err : new Error(String(err)));
      });
  });

  const timer = setTimeout(() => {
    rejectToken(new Error(`Timed out after ${String(AUTH_TIMEOUT_MS)}ms waiting for the browser login to complete`));
  }, AUTH_TIMEOUT_MS);
  server.on('error', (err) => {
    rejectToken(err);
  });
  server.listen(port, () => {
    logger.info(`Waiting for you to sign in. Opening your browser to:\n${authorizationUrl}`);
    openBrowser(authorizationUrl);
  });

  try {
    return await tokenPromise;
  } finally {
    clearTimeout(timer);
    server.close();
  }
};

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

/** Format an item count for display; failed reads render as an em dash. */
const formatCount = (count: number | null): string => (count === null ? '—' : count.toLocaleString('en-US'));

/** Quote a CSV field when it contains a comma, quote, or newline (RFC 4180). */
const csvField = (value: string): string => (/[",\n\r]/v.test(value) ? `"${value.replace(/"/gv, '""')}"` : value);

const CSV_HEADER = ['endpoint', 'label', 'count', 'status', 'note'];

/** Render metrics as RFC-4180 CSV. */
const renderCsv = (metrics: EndpointMetric[]): string => {
  const rows = metrics.map((m) =>
    [m.path, m.label, m.count === null ? '' : String(m.count), m.status, m.note].map(csvField).join(','),
  );
  return [CSV_HEADER.join(','), ...rows].join('\n');
};

/** Render metrics as a plain-text, column-aligned table. */
const renderTable = (metrics: EndpointMetric[]): string => {
  const header = { endpoint: 'ENDPOINT', count: 'COUNT', status: 'STATUS', note: 'NOTE' };
  const rows = metrics.map((m) => ({
    endpoint: `/${m.path}`,
    count: formatCount(m.count),
    status: m.status,
    note: m.note,
  }));
  const all = [header, ...rows];
  const width = (key: keyof typeof header): number => Math.max(...all.map((r) => r[key].length));
  const endpointWidth = width('endpoint');
  const countWidth = width('count');
  const statusWidth = width('status');
  const line = (r: (typeof all)[number]): string =>
    `${r.endpoint.padEnd(endpointWidth)}  ${r.count.padStart(countWidth)}  ${r.status.padEnd(statusWidth)}  ${r.note}`.trimEnd();
  return all.map(line).join('\n');
};

/** Summary counters describing a metrics run. */
interface MetricsSummary {
  endpointCount: number;
  okCount: number;
  failedCount: number;
  itemTotal: number;
}

const summarize = (metrics: EndpointMetric[]): MetricsSummary => {
  const ok = metrics.filter((m) => m.status === 'ok');
  return {
    endpointCount: metrics.length,
    okCount: ok.length,
    failedCount: metrics.length - ok.length,
    itemTotal: ok.reduce((sum, m) => sum + (m.count ?? 0), 0),
  };
};

/** Render metrics as JSON, including a summary block. */
const renderJson = (metrics: EndpointMetric[]): string =>
  JSON.stringify({ generatedAt: new Date().toISOString(), summary: summarize(metrics), metrics }, null, JSON_SPACES);

type OutputFormat = 'table' | 'csv' | 'json';

const renderReport = (metrics: EndpointMetric[], format: OutputFormat): string => {
  if (format === 'csv') {
    return renderCsv(metrics);
  }
  if (format === 'json') {
    return renderJson(metrics);
  }
  return renderTable(metrics);
};

// ---------------------------------------------------------------------------
// Command module
// ---------------------------------------------------------------------------

interface GetMetricsCommandArgs {
  'pdc-api-base-url': string;
  'oidc-base-url': string;
  'oidc-client-id': string;
  'oidc-client-secret'?: string;
  format: OutputFormat;
  'callback-port': number;
  'access-token'?: string;
  'skip-auth': boolean;
  outputFile?: string;
}

/**
 * Decide which access token (if any) to use, in priority order:
 * 1. `--skip-auth` → no token (public endpoints only).
 * 2. `--access-token`/DS_ACCESS_TOKEN → use it as-is.
 * 3. `--oidc-client-secret` present → non-interactive OIDC client-credentials
 *    grant (reuses `getToken` from oidc.ts) — a single-command, headless login.
 * 4. otherwise → the interactive browser (authorization-code + PKCE) login.
 */
const resolveAccessToken = async (args: {
  skipAuth: boolean;
  accessToken?: string;
  oidcBaseUrl: string;
  oidcClientId: string;
  oidcClientSecret?: string;
  callbackPort: number;
}): Promise<string | undefined> => {
  if (args.skipAuth) {
    logger.warn('Running with --skip-auth: only public endpoints will report a count');
    return undefined;
  }
  const { accessToken, oidcClientSecret } = args;
  if (accessToken !== undefined && accessToken !== '') {
    logger.info('Using the supplied access token (skipping interactive login)');
    return accessToken;
  }
  if (oidcClientSecret !== undefined && oidcClientSecret !== '') {
    logger.info('Authenticating with the OIDC client-credentials grant (no browser)');
    const token = await getToken(args.oidcBaseUrl, args.oidcClientId, oidcClientSecret);
    return token.access_token;
  }
  const token = await authenticateInteractively(args.oidcBaseUrl, args.oidcClientId, args.callbackPort);
  logger.info('Authentication successful');
  return token;
};

const getMetrics: CommandModule<unknown, GetMetricsCommandArgs> = {
  command: 'getMetrics',
  describe: 'Read the PDC API and report a count of items per endpoint',
  builder: (y) =>
    y
      .option('pdc-api-base-url', {
        describe: 'Location of the PDC API',
        default: DEFAULT_PDC_API_BASE_URL,
        type: 'string',
      })
      .option('oidc-base-url', {
        describe: 'OpenID Connect authority (realm) base URL',
        default: DEFAULT_OIDC_BASE_URL,
        type: 'string',
      })
      .option('oidc-client-id', {
        describe: 'OIDC client ID for the interactive browser login or the client-credentials grant',
        default: DEFAULT_OIDC_CLIENT_ID,
        type: 'string',
      })
      .option('oidc-client-secret', {
        describe:
          'OIDC client secret; when set, authenticate non-interactively via the client-credentials grant instead of the browser (can also be set via DS_OIDC_CLIENT_SECRET)',
        type: 'string',
      })
      .option('format', {
        describe: 'Output format for the report',
        choices: ['table', 'csv', 'json'] as const,
        default: 'table' as const,
      })
      .option('callback-port', {
        describe: 'Local port for the OAuth redirect (loopback) listener',
        default: DEFAULT_CALLBACK_PORT,
        type: 'number',
      })
      .option('access-token', {
        describe:
          'Use this bearer token instead of the interactive browser login (can also be set via DS_ACCESS_TOKEN)',
        type: 'string',
      })
      .option('skip-auth', {
        describe: 'Do not authenticate; only public endpoints will report a count',
        default: false,
        type: 'boolean',
      })
      .option('output-file', {
        alias: 'write',
        describe: 'Write the report to this file instead of logging it',
        normalize: true,
        type: 'string',
      }),
  handler: async (args) => {
    const accessToken = await resolveAccessToken(args);
    const metrics = sortMetrics(await collectMetrics(args.pdcApiBaseUrl, PDC_ENDPOINTS, accessToken));
    const summary = summarize(metrics);
    const report = renderReport(metrics, args.format);

    if (args.outputFile === undefined || args.outputFile === '') {
      logger.info(`PDC metrics report (${args.format}):\n${report}`);
    } else {
      await writeFile(args.outputFile, report);
      logger.info(`Wrote PDC metrics report to ${args.outputFile}`);
    }
    logger.info(
      `Counted ${String(summary.itemTotal)} items across ${String(summary.okCount)}/${String(summary.endpointCount)} endpoints (${String(summary.failedCount)} unavailable)`,
    );
  },
};

export {
  type EndpointMetric,
  type MetricStatus,
  collectMetrics,
  csvField,
  formatCount,
  getEndpointCount,
  getMetrics,
  renderCsv,
  renderJson,
  renderTable,
  resolveFullCount,
  sortMetrics,
  summarize,
};
