# GivingTuesday Integration — Technical Report

**Source file:** [`src/givingTuesday.ts`](src/givingTuesday.ts)
**Generated:** 2026-08-06
**Purpose:** Fetch IRS Business Master File (BMF) nonprofit data from the GivingTuesday 990 Data API and import it into the Philanthropy Data Commons (PDC) as changemaker field values.

---

## 1. Overview

`givingTuesday.ts` defines a [yargs](https://yargs.js.org/) command module (`givingTuesday`) registered in [`src/index.ts`](src/index.ts) as part of the `data-scripts` CLI. It exposes three subcommands:

| Subcommand | Purpose | Writes to PDC? | Needs PDC auth? |
|---|---|---|---|
| `lookup` | Fetch GivingTuesday BMF data for an explicit list of EINs and print or save it | No | No |
| `lookupFromPdc` | Pull all changemaker EINs from PDC, look them up in GivingTuesday, print/save the result (dry-run style) | No | No (reads PDC anonymously) |
| `updateAll` | Full sync: read PDC changemakers → look up in GivingTuesday → write results back into PDC as field values | **Yes** | **Yes (OIDC)** |

Invocation examples:

```bash
data-scripts givingTuesday lookup --eins 84-2929872
```

```bash
data-scripts givingTuesday updateAll --pdc-api-base-url <url> --oidc-base-url <url> --oidc-client-id <id> --oidc-client-secret <secret>
```

> Unlike the Charity Navigator integration, the GivingTuesday API is **open-access and unauthenticated** — no API key is required for the source system. Authentication (OIDC) is only needed to *write* into PDC via `updateAll`.

---

## 2. External Systems

### GivingTuesday 990 Data API (source)
- **Base URL:** `https://990-infrastructure.gtdata.org` (constant `API_BASE_URL`)
- **Endpoint:** `/irs-data/bmf` (constant `BMF_PATH`) — the IRS Business Master File. *(Code comment notes the published docs render `/irs_data/` but the live API uses the hyphenated `/irs-data/` path.)*
- **Client:** the shared Axios `client` ([`src/client.ts`](src/client.ts)) — plain REST GET, **one request per EIN**, passed as a `?ein=` query parameter
- **Auth:** none (open-access)
- **Rate limit:** 300 requests / 5 minutes (~1/sec). The code sleeps `RATE_LIMIT_DELAY_MS = 1100` ms between requests rather than implementing 429 backoff (matching the Candid approach).

### PDC API (destination)
- **Client:** Axios wrapper in [`src/pdc-api.ts`](src/pdc-api.ts) / [`src/client.ts`](src/client.ts)
- **Auth:** OIDC `client_credentials` grant via [`src/oidc.ts`](src/oidc.ts) (`getToken`). Only `updateAll` authenticates; reads of `/changemakers` are anonymous.
- **Relevant endpoints:**
  - `GET /changemakers` — list all changemakers (shallow, anonymous)
  - `GET /sources` — find the GivingTuesday source
  - `POST /sources` — create the source (admin-only; typically fails for non-admins)
  - `POST /changemakerFieldValueBatches` — open a batch
  - `POST /changemakerFieldValues` — write one field value

---

## 3. Data Flow (the `updateAll` path)

```
PDC /changemakers ──► extract taxId (EIN) list
       │
       ▼
Validate EINs (isValidEin) ──► split valid / invalid
       │                              │
       │                    (invalid logged as warning, skipped)
       ▼
GivingTuesday BMF API (getGivingTuesdayProfiles)
   └─ one GET per EIN, normalized via toGivingTuesdayEin
      (hyphen-stripped, zero-padded to 9 digits)
   └─ sleep 1100ms between requests (rate limit)
   └─ per-EIN failure logged & skipped ──► BmfRecord[] results
       │
       ▼
Authenticate to PDC (OIDC client_credentials) ──► access token
       │
       ▼
Find or create PDC Source (dataProviderShortCode = "givingtuesday")
       │
       ▼
Open a ChangemakerFieldValueBatch (sourceId + notes with timestamp)
       │
       ▼
For each BMF record:
   match to a PDC changemaker by normalized EIN (getChangemakerByEin)
   derive goodAsOf from Date_Released (parseGivingTuesdayDate)
   For each mapped field (baseFieldMap):
      if the BMF attribute is present & non-empty ──► POST /changemakerFieldValues
         (batchId, changemakerId, baseFieldShortCode, value, goodAsOf)
         └─ 403 Forbidden ──► warn + record changemakerId, continue
```

### Key processing details

- **EIN normalization (`toGivingTuesdayEin`):** GivingTuesday requires **zero-padded, 9-digit, hyphen-free** EINs. The helper strips a hyphen and left-pads to 9 characters (`ein.replace('-', '').padStart(9, '0')`). This same normalization is applied on both sides of the match in `getChangemakerByEin`, so PDC tax IDs and the EINs GivingTuesday echoes back compare correctly.
- **EIN validation:** `isValidEin` ([`src/ein.ts`](src/ein.ts)) accepts `^\d{2}-?\d{7}$`. Invalid EINs are logged and skipped; valid ones proceed. (Note: unlike Charity Navigator, hyphens are *not* stripped before validation — validation runs on the raw `taxId`, and normalization happens later per-request.)
- **EIN → changemaker matching:** `getChangemakerByEin` returns a changemaker only when **exactly one** matches. Zero → logged at info and skipped; more than one → warning and skipped (ambiguous, nothing written).
- **One request per EIN:** Unlike Charity Navigator's single paginated GraphQL query filtered by a set of EINs, GivingTuesday is queried **individually per EIN**. `getGivingTuesdayProfiles` loops sequentially, sleeping between calls.
- **Per-EIN fault tolerance:** A failure for one EIN is caught, logged via `logger.error`, and skipped so a single bad lookup doesn't abort the whole run.
- **Response validation:** `extractResultsFromResponse` throws a clear, EIN-tagged error when the response is `null`/`undefined`, when `body` is missing, or when `body.results` is not an array — so a malformed lookup is never silently treated as "no records found".
- **Runtime type guard:** `isBmfRecord` verifies both `ein` and `primary_name_of_organization` are strings before an untyped result is treated as a valid `BmfRecord`.
- **`goodAsOf` derivation (`parseGivingTuesdayDate`):** GivingTuesday's `Date_Released` arrives as `YYYY_MM_DD` (month/day not necessarily zero-padded). The helper converts it to an ISO `YYYY-MM-DD` string, zero-padding month/day, and returns `null` when the input is missing or unparseable (`goodAsOf` is nullable in PDC).
- **Empty-value handling:** A field is only posted when the BMF attribute is not `undefined`, not `null`, **and not the empty string `''`** (a slightly stricter check than the Charity Navigator script, which does not exclude empty strings). Values are coerced with `.toString()` — relevant because several IRS codes arrive as `number | string`.
- **Sequential writes:** Field values are POSTed one at a time (not `Promise.all`) because the PDC API times out under concurrent POSTs to `/changemakerFieldValues`.
- **403 handling:** `postChangemakerFieldValueWarnOnForbidden` swallows HTTP 403 (logs a warning, records the `changemakerId` for an end-of-run summary) and re-throws any other error.
- **Source resolution:** `getOrCreateSource` finds an existing source with `dataProviderShortCode === "givingtuesday"`; otherwise attempts to create one, warning that this usually requires a `pdc-admin`.

---

## 4. Field Mapping: GivingTuesday BMF → PDC

The mapping is defined by the `baseFieldMap` constant in [`src/givingTuesday.ts:67`](src/givingTuesday.ts). Each GivingTuesday `BmfRecord` attribute is written to a PDC **base field** identified by its short code. This is a substantially richer mapping than the Charity Navigator integration (14 fields vs. 4).

### 4.1 Fields written to PDC

| GivingTuesday BMF attribute (`BmfRecord`) | PDC base field short code |
|---|---|
| `primary_name_of_organization` | `organization_irs_name` |
| `street_address` | `organization_irs_address` |
| `city` | `organization_irs_city` |
| `state` | `organization_irs_state` |
| `zip_code` | `organization_irs_zip` |
| `subsection_descrip` | `organization_irs_subsection` |
| `classification_codes` | `organization_irs_classification` |
| `foundation_descrip` | `organization_irs_foundation_information` |
| `foundation_code` | `organization_foundation_code` |
| `national_taxonomy_of_exempt_entities_ntee_code` | `organization_ntee_code` |
| `deductibility_code` | `organization_deductibility_code` |
| `deductability_descrip` | `organization_deductibility_status` |
| `ruling_date` | `organization_ruling_date` |
| `tax_period` | `organization_tax_period` |

Each written value becomes a **`ChangemakerFieldValue`** with this shape:

| PDC field value property | Value / source |
|---|---|
| `changemakerId` | Resolved via `getChangemakerByEin` (normalized EIN match) |
| `batchId` | ID of the batch opened for this run |
| `baseFieldShortCode` | From the mapping table above |
| `value` | The BMF attribute, coerced with `.toString()` |
| `goodAsOf` | Derived from `Date_Released` via `parseGivingTuesdayDate` (ISO date or `null`) |

### 4.2 EIN — used for matching, not stored as a field

`ein` is the join key between the two systems. It is used to match a BMF record to a PDC changemaker (after normalization) but is **not** itself written as a field value.

### 4.3 Fields present on `BmfRecord` but NOT mapped/imported

The `BmfRecord` interface declares a few attributes that are **not** in `baseFieldMap` and are therefore never written to PDC (though they appear in the raw output of `lookup`/`lookupFromPdc` when `--output-file` is used):

| BMF attribute | Currently imported? |
|---|---|
| `Date_Released` | Not a field value, but reused as `goodAsOf` on every written field |
| `Date_Processed` | No |

> Note: the IRS BMF endpoint may return additional attributes beyond those declared on `BmfRecord`; only the fields explicitly listed in `baseFieldMap` are ever written to PDC.

---

## 5. Command Reference

### `lookup`
- **Args:** `--eins` (array, validated by `isValidEin`), `--output-file`/`--write` (optional).
- **Behavior:** Calls `getGivingTuesdayProfiles` for the given EINs (one rate-limited request each). Writes JSON to the output file if given, otherwise logs the result. No PDC interaction. No API key required.

### `lookupFromPdc`
- **Args:** `--pdc-api-base-url` (required), `--output-file`.
- **Behavior:** Reads all PDC changemakers, extracts + validates their EINs, looks each up in GivingTuesday. If no output file, logs which changemaker IDs were found in GivingTuesday; otherwise writes the raw response to file. **Read-only** with respect to PDC.

### `updateAll`
- **Args:** `--pdc-api-base-url` (required) and all `oidcOptions` (`--oidc-base-url`, `--oidc-client-id`, `--oidc-client-secret`, all required).
- **Behavior:** The full sync described in Section 3. The only subcommand that writes to PDC.

---

## 6. Error Handling & Resilience Summary

| Concern | Handling |
|---|---|
| Invalid EINs in PDC | Filtered out and logged as a warning; valid EINs still processed |
| Rate limiting | 1100 ms sleep between per-EIN requests (no 429 backoff logic) |
| Per-EIN request failure | Caught, logged, and skipped — the run continues |
| Null/undefined or malformed response | `extractResultsFromResponse` throws a clear, EIN-tagged error |
| Untyped results | `isBmfRecord` runtime type guard (requires string `ein` + org name) |
| Ambiguous EIN → changemaker (>1 match) | Skipped with a warning; nothing written |
| Null / undefined / empty-string attributes | Skipped (not posted) |
| Unparseable / missing `Date_Released` | `goodAsOf` set to `null` |
| Numeric-or-string IRS codes | Coerced via `.toString()` before posting |
| HTTP 403 on write | Warned + changemakerId recorded; run continues; summary warning at end |
| PDC concurrency timeouts | Field values POSTed sequentially |
| Missing GivingTuesday source | Attempt to create (usually admin-only); warns it may fail |

---

## 7. Testing

Unit tests in [`src/givingTuesday.unit.test.ts`](src/givingTuesday.unit.test.ts) cover the four exported pure helpers:

- **`toGivingTuesdayEin`** — strips a hyphen, leaves an already-normalized EIN unchanged, zero-pads a short EIN to nine digits.
- **`parseGivingTuesdayDate`** — converts zero-padded and single-digit `YYYY_MM_DD` to ISO; returns `null` for `null`/`undefined`/unparseable input.
- **`isBmfRecord`** — accepts a record with a string `ein` and org name; rejects a missing org name or a non-string `ein`.
- **`extractResultsFromResponse`** — returns the results array for well-formed and empty responses; throws clear, EIN-tagged errors for `null`/`undefined` responses, a missing `body`, or a non-array `results`.

The network-facing functions (`getGivingTuesdayBmfRecords`, `getGivingTuesdayProfiles`, the command handlers, and all PDC writes) are not directly unit-tested; testability is achieved by extracting the pure normalization/parsing/extraction logic into the four exported helpers.

---

## 8. Notable Constants & TODOs in the Code

- `GT_SHORT_CODE = 'givingtuesday'` — the PDC data provider short code for GivingTuesday.
- `RATE_LIMIT_DELAY_MS = 1100` — inter-request sleep to stay under 300 requests / 5 min.
- `EIN_LENGTH = 9` — zero-pad target for normalized EINs.
- `DATE_PART_LENGTH = 2` — zero-pad width for ISO month/day parts.
- `API_BASE_URL` / `BMF_PATH` — with a code comment noting the docs' `/irs_data/` vs. the live API's `/irs-data/` path discrepancy.
- `HTTP_STATUS_FORBIDDEN = 403` — with a comment noting a shared `@pdc/http-status-codes` package should replace this once available.

---

## 9. Comparison with the Charity Navigator Integration

The two scripts share an almost identical architecture (three subcommands, source resolution, batch + sequential field posting, 403 tolerance, EIN → changemaker matching). Key differences:

| Aspect | Charity Navigator | GivingTuesday |
|---|---|---|
| Source protocol | GraphQL (Apollo) | REST (Axios GET) |
| Source auth | Bearer API key required | None (open-access) |
| Query strategy | One paginated query filtered by a set of EINs | One request **per EIN** |
| Rate limiting | None | 1100 ms sleep between requests |
| EIN normalization | Strip hyphen | Strip hyphen **+ zero-pad to 9 digits** |
| `goodAsOf` source | `updatedAt` (as-is) | `Date_Released` parsed `YYYY_MM_DD` → ISO |
| Empty-value skip | `undefined` / `null` | `undefined` / `null` / `''` |
| Fields mapped to PDC | 4 (name, website, phone, mission) | 14 (IRS BMF address, codes, dates, etc.) |
