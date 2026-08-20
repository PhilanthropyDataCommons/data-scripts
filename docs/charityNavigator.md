# Charity Navigator Integration — Technical Report

**Source file:** [`../src/charityNavigator.ts`](../src/charityNavigator.ts)
**Generated:** 2026-08-06
**Purpose:** Fetch nonprofit profile data from the Charity Navigator Premier GraphQL API and import it into the Philanthropy Data Commons (PDC) as changemaker field values.

---

## 1. Overview

`charityNavigator.ts` defines a [yargs](https://yargs.js.org/) command module (`charityNavigator`) that is registered in [`../src/index.ts`](../src/index.ts) as part of the `data-scripts` CLI. It exposes three subcommands:

| Subcommand      | Purpose                                                                                                       | Writes to PDC? | Needs PDC auth?            |
| --------------- | ------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------- |
| `lookup`        | Fetch Charity Navigator data for an explicit list of EINs and print or save it                                | No             | No                         |
| `lookupFromPdc` | Pull all changemaker EINs from PDC, look them up in Charity Navigator, print/save the result (dry-run style)  | No             | No (reads PDC anonymously) |
| `updateAll`     | Full sync: read PDC changemakers → look up in Charity Navigator → write results back into PDC as field values | **Yes**        | **Yes (OIDC)**             |

Invocation examples:

```bash
data-scripts charityNavigator lookup --eins 13-1837418 --charity-navigator-api-key <key>
```

```bash
data-scripts charityNavigator updateAll --pdc-api-base-url <url> --oidc-base-url <url> --oidc-client-id <id> --oidc-client-secret <secret> --charity-navigator-api-key <key>
```

The API key may also be supplied via the `DS_CHARITY_NAVIGATOR_API_KEY` environment variable.

---

## 2. External Systems

### Charity Navigator Premier API (source)

- **Endpoint:** `https://api.charitynavigator.org/graphql` (constant `API_URL`)
- **Client:** Apollo Client (`@apollo/client`) with an in-memory cache
- **Auth:** Bearer token in the `Authorization` header (`Bearer <apiKey>`), injected by a `SetContextLink` auth link (`apolloInit`)
- **Query:** `NonprofitsPublic` (`QueryNonprofitsPublic`) against the `nonprofitsPublic` field, filtered by a set of EINs

### PDC API (destination)

- **Client:** Axios wrapper in [`../src/pdc-api.ts`](../src/pdc-api.ts) / [`../src/client.ts`](../src/client.ts)
- **Auth:** OIDC `client_credentials` grant via [`../src/oidc.ts`](../src/oidc.ts) (`getToken`), producing a Bearer access token. Only `updateAll` authenticates; reads of `/changemakers` are anonymous.
- **Relevant endpoints:**
  - `GET /changemakers` — list all changemakers (shallow, anonymous)
  - `GET /sources` — find the Charity Navigator source
  - `POST /sources` — create the source (admin-only; typically fails for non-admins)
  - `POST /changemakerFieldValueBatches` — open a batch
  - `POST /changemakerFieldValues` — write one field value

---

## 3. Data Flow (the `updateAll` path)

```
PDC /changemakers ──► extract taxId (EIN) list
       │
       ▼
Validate EINs (isValidEin) ──► strip hyphens ──► split valid / invalid
       │                                              │
       │                                    (invalid logged as warning, skipped)
       ▼
Charity Navigator GraphQL (getCharityNavigatorProfiles)
   └─ paginated fetch (fetchAllPages, perPage=100) ──► NonprofitPublic[] edges
       │
       ▼
Authenticate to PDC (OIDC client_credentials) ──► access token
       │
       ▼
Find or create PDC Source (dataProviderShortCode = "charitynav")
       │
       ▼
Open a ChangemakerFieldValueBatch (sourceId + notes with timestamp)
       │
       ▼
For each nonprofit:
   match to a PDC changemaker by EIN (getChangemakerByEin)
   For each mapped field (baseFieldMap):
      if the CN attribute is present ──► POST /changemakerFieldValues
         (batchId, changemakerId, baseFieldShortCode, value, goodAsOf)
         └─ 403 Forbidden ──► warn + record changemakerId, continue
```

### Key processing details

- **EIN normalization:** PDC stores tax IDs possibly with a hyphen (`NN-NNNNNNN`). `isValidEin` ([`../src/ein.ts`](../src/ein.ts)) accepts `^\d{2}-?\d{7}$`. Before querying Charity Navigator, hyphens are stripped (`e.replace('-', '')`) because the CN API expects unhyphenated EINs. When matching results back to changemakers, `getChangemakerByEin` also strips hyphens from the PDC `taxId` for comparison.
- **EIN → changemaker matching:** `getChangemakerByEin` returns a changemaker only when **exactly one** matches an EIN. Zero matches → logged at info and skipped; more than one match → logged as a warning and skipped (ambiguous, so nothing is written).
- **Pagination:** `fetchAllPages` loops page-by-page (starting at page 1, `perPage = 100`) accumulating `edges` until `currentPage >= totalPages`. It **hard-fails** if `totalPages` is not a positive integer (guards against `undefined` → infinite loop, and `null`/`0` → silent partial import). `extractPageFromResponse` throws a clear error if a page returns `null`/`undefined` data instead of throwing a cryptic `TypeError`.
- **Runtime validation:** GraphQL responses are untyped at runtime. `isNonprofitPublic` verifies that `ein`, `name`, and `updatedAt` are strings before an edge is treated as a valid `NonprofitPublic`.
- **Sequential writes:** Field values are POSTed one at a time in a `for` loop (not `Promise.all`) because the PDC API times out under concurrent POSTs to `/changemakerFieldValues`.
- **403 handling:** `postChangemakerFieldValueWarnOnForbidden` swallows HTTP 403 (no permission) — it logs a warning and records the `changemakerId` in a set for a summary log at the end — while re-throwing any other error. This lets a run continue past changemakers the client lacks permission to write.
- **Source resolution:** `getOrCreateSource` looks for an existing source with `dataProviderShortCode === "charitynav"`. If not found it attempts to create one, but warns that this usually requires a `pdc-admin` and may fail.

---

## 4. Field Mapping: Charity Navigator → PDC

The mapping is defined by the `baseFieldMap` constant in [`../src/charityNavigator.ts:44`](../src/charityNavigator.ts). Each Charity Navigator `NonprofitPublic` attribute is written to a PDC **base field** identified by its short code.

### 4.1 Fields actually written to PDC

| Charity Navigator attribute (`NonprofitPublic`) | PDC base field short code        | Notes                       |
| ----------------------------------------------- | -------------------------------- | --------------------------- |
| `name`                                          | `organization_name`              | Organization legal name     |
| `website`                                       | `organization_website`           | Optional; skipped if absent |
| `phone`                                         | `organization_phone`             | Optional; skipped if absent |
| `mission`                                       | `organization_mission_statement` | Optional; skipped if absent |

Each written value becomes a **`ChangemakerFieldValue`** with this shape:

| PDC field value property | Value / source                                               |
| ------------------------ | ------------------------------------------------------------ |
| `changemakerId`          | Resolved via `getChangemakerByEin` (EIN match)               |
| `batchId`                | ID of the batch opened for this run                          |
| `baseFieldShortCode`     | From the mapping table above                                 |
| `value`                  | The CN attribute, coerced with `.toString()`                 |
| `goodAsOf`               | The nonprofit's `updatedAt` timestamp from Charity Navigator |

A value is only posted when the CN attribute is neither `undefined` nor `null` (an explicit runtime null-check, since the API can return null despite the TypeScript types).

### 4.2 EIN — used for matching, not stored as a field

`ein` is the join key between the two systems. It is used to match a Charity Navigator record to a PDC changemaker, but it is **not** itself written as a field value.

### 4.3 Fields fetched but NOT mapped/imported

The GraphQL query requests several attributes that are **not** part of `baseFieldMap` and are therefore fetched but never written to PDC. They are available in the raw output of `lookup`/`lookupFromPdc` (when `--output-file` is used) but ignored by `updateAll`:

| Charity Navigator attribute | Currently imported?                                                |
| --------------------------- | ------------------------------------------------------------------ |
| `updatedAt`                 | Not a field value, but reused as `goodAsOf` on every written field |
| `encompassRatingId`         | No                                                                 |
| `encompassScore`            | No                                                                 |
| `encompassStarRating`       | No                                                                 |
| `encompassPublicationDate`  | No                                                                 |
| `size`                      | No                                                                 |
| `cause`                     | No                                                                 |

> These represent an opportunity for future mapping (e.g. ratings/scores) if corresponding PDC base fields exist. Adding them would be a matter of extending `baseFieldMap` and ensuring the target base field short codes exist in PDC.

---

## 5. Command Reference

### `lookup`

- **Args:** `--eins` (array, validated by `isValidEin`), `--charity-navigator-api-key` (or env var), `--output-file`/`--write` (optional).
- **Behavior:** Calls `getCharityNavigatorProfiles` for the given EINs. Writes JSON to the output file if given, otherwise logs the result. No PDC interaction.

### `lookupFromPdc`

- **Args:** `--pdc-api-base-url` (required), `--charity-navigator-api-key`, `--output-file`.
- **Behavior:** Reads all PDC changemakers, extracts + validates + de-hyphenates their EINs, looks them up in Charity Navigator. If no output file, logs which changemaker IDs were found in Charity Navigator; otherwise writes the raw CN response to file. **Read-only** with respect to PDC (does not write field values).

### `updateAll`

- **Args:** `--pdc-api-base-url` (required), all `oidcOptions` (`--oidc-base-url`, `--oidc-client-id`, `--oidc-client-secret`, all required), `--charity-navigator-api-key`.
- **Behavior:** The full sync described in Section 3. This is the only subcommand that writes to PDC.

---

## 6. Error Handling & Resilience Summary

| Concern                                | Handling                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| Missing API key                        | Explicit check; throws with guidance to use CLI flag or `DS_CHARITY_NAVIGATOR_API_KEY` |
| Invalid EINs in PDC                    | Filtered out and logged as a warning; valid EINs still processed                       |
| Malformed `totalPages`                 | `fetchAllPages` throws loudly (prevents infinite loop / silent partial import)         |
| Null/undefined GraphQL data            | `extractPageFromResponse` throws a clear, page-numbered error                          |
| Untyped edges                          | `isNonprofitPublic` runtime type guard                                                 |
| Ambiguous EIN → changemaker (>1 match) | Skipped with a warning; nothing written                                                |
| Null CN attribute values               | Skipped (not posted)                                                                   |
| HTTP 403 on write                      | Warned + changemakerId recorded; run continues; summary warning at end                 |
| PDC concurrency timeouts               | Field values POSTed sequentially                                                       |
| Missing Charity Navigator source       | Attempt to create (usually admin-only); warns it may fail                              |

---

## 7. Testing

Unit tests in [`../src/charityNavigator.unit.test.ts`](../src/charityNavigator.unit.test.ts) cover the two exported helpers:

- **`fetchAllPages`** — accumulates edges across multiple pages, handles a single page, handles an empty first page, and throws on invalid `totalPages` values (`undefined`, `null`, `0`).
- **`extractPageFromResponse`** — returns `nonprofitsPublic` for valid data and throws clear, page-numbered errors when `data` is `null` or `undefined`.

The network-facing functions (`getCharityNavigatorProfiles`, the command handlers, and all PDC writes) are not directly unit-tested; testability is achieved by extracting the pure pagination/extraction logic into the two exported helpers.

---

## 8. Notable Constants & TODOs in the Code

- `CN_SHORT_CODE = 'charitynav'` — the PDC data provider short code for Charity Navigator.
- `PER_PAGE = 100` — fixed GraphQL page size.
- `HTTP_STATUS_FORBIDDEN = 403` — with a code comment noting that a shared `@pdc/http-status-codes` package should replace this once available.
- [`../src/pdc-api.ts`](../src/pdc-api.ts) contains a `TODO` to replace locally-copied `ChangemakerFieldValue*` types with the `@pdc/sdk` equivalents.
