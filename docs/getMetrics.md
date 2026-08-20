# PDC Metrics Report Generator — Technical Report

**Source file:** [`getMetrics.ts`](getMetrics.ts)
**Generated:** 2026-08-10
**Purpose:** Read the Philanthropy Data Commons (PDC) API and produce a high‑level metrics report: a count of items in each top‑level collection endpoint. This is a **read‑only** script — it never writes to PDC.

---

## 1. Overview

`getMetrics.ts` defines a [yargs](https://yargs.js.org/) command module (`getMetrics`) registered in [`index.ts`](index.ts) as part of the `data-scripts` CLI. Unlike the Charity Navigator and GivingTuesday integrations (which pull data from a third party and write it back into PDC), this script does exactly one thing: it queries a fixed list of PDC collection endpoints and reports how many items each one contains.

The item count for each endpoint comes from the `total` field of the PDC "bundle" response (see [§4](#4-how-counts-are-determined)).

Invocation examples:

```bash
# Interactive browser login, print a table (the default)
npm run getMetrics
```

```bash
# Use an existing bearer token, write CSV to a file
npm run getMetrics -- --access-token "$MY_TOKEN" --format csv --write metrics.csv
```

```bash
# Non-interactive: client-credentials grant (no browser), single command
npm run getMetrics -- --oidc-client-id YOUR_CLIENT_ID --oidc-client-secret YOUR_CLIENT_SECRET
```

```bash
# No authentication at all — only public endpoints report a count
npm run getMetrics -- --skip-auth
```

> `npm run getMetrics` is a convenience wrapper for `npm start -- getMetrics`; both accept the same options after `--`.

### Using `--access-token` (no browser / no Keycloak reconfiguration)

Because the default `pdc-metrics` client does not allow a loopback redirect (see [§3](#3-authentication-the-interactive-browser-flow)), the quickest way to count the authenticated endpoints today is to supply a bearer token you already have. Any of these work:

```bash
# 1. Token as a CLI flag
npm run getMetrics -- --access-token "eyJhbGciOi...your.jwt...here"
```

```bash
# 2. Token from an environment variable (the CLI reads any DS_-prefixed var)
export DS_ACCESS_TOKEN="eyJhbGciOi...your.jwt...here"
npm run getMetrics
```

```bash
# 3. Token in a file, expanded inline — CSV to stdout
npm run getMetrics -- --access-token "$(cat token.txt)" --format csv
```

```bash
# 4. Token in a file, JSON written to disk
npm run getMetrics -- --access-token "$(cat token.txt)" --format json --write metrics.json
```

**Where to get a token:**

- If you have OIDC **client credentials** (client id + secret), reuse the existing `auth` command in this same CLI to mint one and save it to a file, then feed it straight into `getMetrics`:

  ```bash
  npm start -- auth \
    --oidc-base-url https://auth.philanthropydatacommons.org/realms/pdc \
    --oidc-client-id "$MY_CLIENT_ID" \
    --oidc-client-secret "$MY_CLIENT_SECRET" \
    --write token.txt

  npm run getMetrics -- --access-token "$(cat token.txt)" --format csv --write metrics.csv
  ```

- Or copy the bearer token from an authenticated session in the PDC web app (browser dev tools → a request to `api.philanthropydatacommons.org` → `Authorization: Bearer …` header). Note these tokens are short‑lived, so re‑run promptly.

> The token counts endpoints exactly as far as its permissions allow: any collection the token cannot read is reported as `unauthorized` (401) or `forbidden` (403) rather than failing the run.

---

## 2. External Systems

### PDC API (data source — read only)

- **Base URL:** `https://api.philanthropydatacommons.org/` (default; override with `--pdc-api-base-url`)
- **Client:** the shared Axios `client` ([`client.ts`](client.ts)) — plain REST `GET` per endpoint
- **Auth:** Bearer access token in the `Authorization` header. Most endpoints require it; `baseFields` and `changemakers` are readable anonymously.
- **Query parameters:** a cheap `?_page=1&_count=1` probe is tried first; endpoints whose `total` is ambiguous at that size are re-fetched in full with `?_page=1&_count=1000000` (see [§4](#4-how-counts-are-determined)).

### PDC Keycloak realm (authentication)

- **Realm base URL:** `https://auth.philanthropydatacommons.org/realms/pdc` (default; override with `--oidc-base-url`)
- **Discovery:** OIDC metadata is fetched from the realm's `.well-known/openid-configuration` via `openid-client`'s `Issuer.discover`.
- **Flow:** OAuth 2.0 **Authorization Code with PKCE** (`S256`), driven through the caller's browser (see [§3](#3-authentication-the-interactive-browser-flow)).
- **Default client:** `pdc-metrics` — the public client used by the PDC web application (override with `--oidc-client-id`).

---

## 3. Authentication

`resolveAccessToken` picks a token source in priority order, so the same command works interactively or headlessly:

1. `--skip-auth` → no token (public endpoints only).
2. `--access-token` / `DS_ACCESS_TOKEN` → use the supplied bearer token as‑is.
3. `--oidc-client-secret` / `DS_OIDC_CLIENT_SECRET` present → non‑interactive **client‑credentials** grant (see [§3.2](#32-non-interactive-client-credentials-grant)).
4. otherwise → the **interactive browser** login (see [§3.1](#31-interactive-browser-flow)).

### 3.1 Interactive browser flow

This is the part that differs most from the other data-scripts, which use the OIDC **client‑credentials** grant ([`oidc.ts`](oidc.ts)). Here the caller authenticates as _themselves_ in a browser, so the report reflects exactly what that user is permitted to read.

The flow (`authenticateInteractively`) is a textbook RFC 8252 native‑app login:

```
1. Issuer.discover(oidc-base-url)                → realm metadata (auth + token endpoints)
2. Build a public client (token_endpoint_auth_method: 'none')
       redirect_uris = [ http://localhost:<callback-port>/callback ]
3. Generate PKCE code_verifier + code_challenge (S256) and a random state
4. Start a throwaway localhost HTTP server on <callback-port>
5. Open the caller's browser to the realm's authorization endpoint
       (scope=openid, code_challenge, state)
6. Caller signs in; Keycloak redirects to http://localhost:<callback-port>/callback?code=…&state=…
7. The local server catches the redirect, exchanges the code (+ code_verifier) at
       the token endpoint, and resolves with the access_token
8. The browser tab shows a "you may close this tab" page; the server shuts down
```

If the caller does not finish within `AUTH_TIMEOUT_MS` (5 minutes), the attempt is aborted with a clear timeout error. If the browser cannot be opened automatically, the authorization URL is also logged so it can be pasted manually.

### ⚠️ Loopback redirect URI must be registered

The authorization‑code flow redirects to `http://localhost:<callback-port>/callback`. **That exact redirect URI must be registered on the OIDC client in Keycloak**, or Keycloak refuses the request with _"Invalid parameter: redirect_uri"_ and the browser tab never returns to the CLI (the script then times out).

As of this writing the default `pdc-metrics` client only permits the web app's own origin (`https://app.philanthropydatacommons.org/`) as a redirect, **not** a loopback URL. So the interactive flow works only after one of these one‑time setups:

- **Preferred:** a PDC Keycloak admin adds `http://localhost/*` (or a specific `http://localhost:9736/callback`) to the valid redirect URIs of a public client, and you point `--oidc-client-id` at it; **or**
- **No config needed:** skip the browser entirely and pass a token you already have via `--access-token` (or the `DS_ACCESS_TOKEN` environment variable). This is the quickest way to count the auth‑required endpoints today.

The two public endpoints (`baseFields`, `changemakers`) always report a count regardless, so `--skip-auth` produces a partial report with no setup at all.

### 3.2 Non‑interactive client‑credentials grant

If you have OIDC **client credentials** (a client id + secret), pass the secret and the script skips the browser entirely — it reuses `getToken` from [`oidc.ts`](oidc.ts) to fetch a token via the `client_credentials` grant. This needs no loopback redirect and no separate `auth` step, so the whole report is a single command:

```bash
npm run getMetrics -- --oidc-client-id YOUR_CLIENT_ID --oidc-client-secret YOUR_CLIENT_SECRET
```

The secret can also come from the environment (`DS_OIDC_CLIENT_SECRET`), matching the other data‑scripts:

```bash
export DS_OIDC_CLIENT_ID=YOUR_CLIENT_ID
export DS_OIDC_CLIENT_SECRET=YOUR_CLIENT_SECRET
npm run getMetrics -- --format csv --write metrics.csv
```

The report then reflects exactly what that service client is permitted to read; collections it cannot read are reported as `unauthorized`/`forbidden` rather than failing the run.

---

## 4. How counts are determined

Every top‑level PDC collection endpoint returns a **bundle**:

```json
{ "entries": [ … ], "total": 282 }
```

`getEndpointCount` reads the count in up to two steps:

1. **Cheap probe** — `GET {baseUrl}/{path}?_page=1&_count=1`. Well-behaved endpoints report the full `total` even on a one-item page (verified: `baseFields` returns `total: 282` at any `_count`). Any **`total > 1`** is therefore an unambiguous grand total and is used as-is — one request, no payload.
2. **Full fetch** — when the probe's `total` is **missing, `0`, or `1`** (indistinguishable from a page-scoped value at `_count=1`), the whole collection is fetched with `?_page=1&_count=1000000`, and the count is:

   ```
   count = max(total ?? 0, number of entries returned)
   ```

   Taking the larger of the two means neither a **missing/short `total`** nor a **truncated page** can undercount. If the entries returned hit the `1000000` ceiling, the count is reported as a floor with a note (bump `_count` for an exact figure).

3. If a full response carries neither a `total` nor an `entries` array, the endpoint is marked `error`.

> **Why this matters:** an earlier version trusted `total` from the `_count=1` probe and, when it was absent, counted only the single fetched page — so an endpoint like `applicationForms` (which does not report a usable `total` at `_count=1`) was reported as **1** instead of its true size. The two-step `max(total, entries)` approach fixes that by actually evaluating the whole result.

---

## 5. Endpoints counted

The list lives in the `PDC_ENDPOINTS` constant and is trivial to edit. It covers the top‑level bundle collections exposed by `@pdc/sdk` that resolve to a real route on the live API:

| Path                            | Label                           | Public?      |
| ------------------------------- | ------------------------------- | ------------ |
| `/baseFields`                   | Base Fields                     | ✅ anonymous |
| `/changemakers`                 | Changemakers                    | ✅ anonymous |
| `/proposals`                    | Proposals                       | 🔒 token     |
| `/sources`                      | Sources                         | 🔒 token     |
| `/dataProviders`                | Data Providers                  | 🔒 token     |
| `/funders`                      | Funders                         | 🔒 token     |
| `/opportunities`                | Opportunities                   | 🔒 token     |
| `/users`                        | Users                           | 🔒 token     |
| `/changemakerFieldValues`       | Changemaker Field Values        | 🔒 token     |
| `/changemakerFieldValueBatches` | Changemaker Field Value Batches | 🔒 token     |
| `/changemakerProposals`         | Changemaker–Proposal Links      | 🔒 token     |
| `/applicationForms`             | Application Forms               | 🔒 token     |
| `/terminologySets`              | Terminology Sets                | 🔒 token     |
| `/permissionGrants`             | Permission Grants               | 🔒 token     |
| `/files`                        | Files                           | 🔒 token     |

The `public` flag is **informational only** — the script always reports the _actual_ outcome of each request, so an endpoint that changes its auth requirements is reflected truthfully rather than assumed.

> Some PDC resources (e.g. base field localizations, funder‑collaborative members, bulk‑upload tasks) are only reachable as _nested_ routes and return `404` at the top level; they are intentionally omitted. `POST`‑only routes such as `platformProviderResponses` are likewise excluded.

---

## 6. Data flow

```
resolveAccessToken(args)
   ├─ --skip-auth        → no token
   ├─ --access-token/env → use supplied token
   └─ otherwise          → interactive browser login (authenticateInteractively)
          │
          ▼
collectMetrics(baseUrl, PDC_ENDPOINTS, token)
   └─ for each endpoint (sequentially):
         getEndpointCount → GET /{path}?_page=1&_count=1 [+ Bearer token]
             ├─ 2xx with total     → { count: total, status: ok }
             ├─ 2xx, entries only  → { count: entries.length, status: ok, note }
             ├─ 401 → unauthorized     403 → forbidden
             ├─ 404 → not_found        other → error
          │
          ▼
renderReport(metrics, format)  →  table | csv | json
   └─ logged, or written to --output-file
   └─ summary line: items counted, endpoints ok/total, endpoints unavailable
```

Requests are issued **sequentially** (a `for … of` loop, not `Promise.all`), matching the other data‑scripts' deliberate gentleness toward the PDC API.

---

## 7. Command reference

`getMetrics` options (all optional; sensible defaults for the production PDC):

| Option                      | Default                                               | Purpose                                                                              |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `--pdc-api-base-url`        | `https://api.philanthropydatacommons.org/`            | Which PDC instance to query                                                          |
| `--oidc-base-url`           | `https://auth.philanthropydatacommons.org/realms/pdc` | Keycloak realm for the browser login                                                 |
| `--oidc-client-id`          | `pdc-metrics`                                   | Client used for the browser login or client-credentials grant                        |
| `--oidc-client-secret`      | —                                                     | Secret for a non-interactive client-credentials login (env: `DS_OIDC_CLIENT_SECRET`) |
| `--format`                  | `table`                                               | Output format: `table`, `csv`, or `json`                                             |
| `--callback-port`           | `9736`                                                | Local port for the OAuth loopback listener                                           |
| `--access-token`            | —                                                     | Bearer token to use instead of the browser login (env: `DS_ACCESS_TOKEN`)            |
| `--skip-auth`               | `false`                                               | Query only public endpoints; no login                                                |
| `--output-file` / `--write` | —                                                     | Write the report to a file instead of logging it                                     |

As with all unified `data-scripts`, any option can also be supplied via a `DS_`‑prefixed environment variable (e.g. `DS_FORMAT=csv`) or a `--config` JSON file.

---

## 8. Output formats

Every report opens with the **`pdc-api-base-url`** it was run against, so a saved report is self-identifying about its environment (production vs. a test instance). Its placement is format-appropriate: a plain header line for `table`, a leading `#` comment line for `csv`, and a top-level `pdcApiBaseUrl` field for `json`.

In every format the rows are sorted **alphabetically by endpoint path** (`sortMetrics`), regardless of the order the endpoints are fetched in.

- **`table`** (default): a header line (`PDC API base URL: <url>`), a blank line, then a column‑aligned plain‑text table (`ENDPOINT | COUNT | STATUS | NOTE`). Counts are grouped with thousands separators; unavailable endpoints show `—`.
- **`csv`**: a `# PDC API base URL: <url>` comment line, then RFC‑4180 CSV with header `endpoint,label,count,status,note`. Fields containing commas, quotes, or newlines are quoted and internal quotes doubled (`csvField`).
- **`json`**: `{ pdcApiBaseUrl, generatedAt, summary, metrics }`, where `summary` carries `endpointCount`, `okCount`, `failedCount`, and `itemTotal`.

Example (`--skip-auth --format table`):

```
PDC API base URL: https://api.philanthropydatacommons.org/

ENDPOINT                       COUNT  STATUS        NOTE
/applicationForms                  —  unauthorized  Authentication required (no valid token supplied)
/baseFields                      282  ok
/changemakers                     17  ok
…
```

---

## 9. Error handling & resilience

| Concern                                  | Handling                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Endpoint requires auth, no/invalid token | `401` → `unauthorized` (count `—`); the run continues                                                                       |
| Token lacks permission                   | `403` → `forbidden`; the run continues                                                                                      |
| Endpoint route missing/moved             | `404` → `not_found`; the run continues                                                                                      |
| Unexpected response shape                | No `total` and no `entries` → `error` with a descriptive note                                                               |
| Transport/other error                    | Caught per endpoint; message recorded as `error`; other endpoints still processed                                           |
| Browser login not completed              | Aborts after `AUTH_TIMEOUT_MS` (5 min) with a clear timeout error                                                           |
| Browser cannot be opened                 | Authorization URL is logged for manual paste                                                                                |
| Redirect URI not registered              | Documented prominently ([§3](#3-authentication-the-interactive-browser-flow)); `--access-token` is the no‑config workaround |

`getEndpointCount` **never throws** — every failure mode is folded into the endpoint's `status`/`note`, so a single unreadable collection never aborts the whole report.

---

## 10. Testing

Unit tests in [`getMetrics.unit.test.ts`](getMetrics.unit.test.ts) cover the pure, side‑effect‑free helpers — the same "extract the testable logic, exercise it without the network" pattern used by [`charityNavigator.unit.test.ts`](charityNavigator.unit.test.ts) and [`givingTuesday.unit.test.ts`](givingTuesday.unit.test.ts):

- **`csvField`** — leaves plain/empty values unquoted; quotes on comma, embedded quote (doubled), and newline.
- **`formatCount`** — thousands separators, `0` (not an em dash), and `null` → `—`.
- **`summarize`** — ok/failed counts and item total; empty list; excludes non‑ok counts from the total.
- **`renderCsv`** — header row, an ok row, a failed row (empty count field + note), and comma‑in‑note quoting.
- **`renderTable`** — all four column headers, slash‑prefixed paths with formatted counts, em‑dash + note for unavailable endpoints, and right‑aligned counts.
- **`renderJson`** — valid JSON carrying `generatedAt`, the `summary` block, and the `metrics` array.
- **`sortMetrics`** — alphabetical-by-path ordering, input not mutated, empty list unchanged.
- **`resolveFullCount`** — `max(total, entries)` logic: missing total, page-scoped total, truncated entries, empty collection, and the fetch-ceiling floor note.

The network‑facing functions (`getEndpointCount`, `collectMetrics`) and their `EndpointMetric`/`MetricStatus` types are also exported for integration testing with a mocked Axios `client`, and `authenticateInteractively` is deliberately isolated from metric collection so the counting logic can be exercised with a plain token.

---

## 11. Notable constants & TODOs

- `PDC_ENDPOINTS` — the editable catalogue of collections to count.
- `DEFAULT_OIDC_CLIENT_ID = 'pdc-metrics'` — the PDC web app's public client (see the loopback‑redirect caveat in [§3](#3-authentication-the-interactive-browser-flow)).
- `DEFAULT_CALLBACK_PORT = 9736` — local OAuth redirect port.
- `AUTH_TIMEOUT_MS = 300_000` — browser‑login timeout.
- `PROBE_PAGE = '1'` / `PROBE_COUNT = '1'` — the cheap single‑item probe.
- `HTTP_STATUS_*` — with the same comment as the other scripts noting a shared `@pdc/http-status-codes` package should replace these once available.
