# TechSoup Integration — Technical Report

**Source file:** [`../src/techsoup.ts`](../src/techsoup.ts)
**Generated:** 2026-09-18
**Purpose:** Read nonprofit ("changemaker") data from TechSoup [OKF](https://okf.md/spec/)-format bundles delivered as a zip file or folder, and import the mapped organization fields into the Philanthropy Data Commons (PDC) as changemaker field values.

---

## 1. Overview

`techsoup.ts` defines a [yargs](https://yargs.js.org/) command module (`techsoup`) registered in [`../src/index.ts`](../src/index.ts) as part of the `data-scripts` CLI. Unlike the Charity Navigator and GivingTuesday integrations, the **source is not a REST API** — it is a set of local files (an OKF bundle, or "package") that TechSoup produces. The destination is the same PDC REST API used by the other integrations.

It exposes three subcommands:

| Subcommand      | Purpose                                                                                                   | Writes to PDC? | Needs PDC auth?            |
| --------------- | --------------------------------------------------------------------------------------------------------- | -------------- | -------------------------- |
| `inventory`     | Examine a zip/folder, discover the OKF packages inside, and print/save the mapped fields available        | No             | No                         |
| `lookupFromPdc` | Discover the packages, extract each EIN, and report which are present in PDC (dry-run style)              | No             | No (reads PDC anonymously) |
| `updateAll`     | Full sync: discover packages → match EIN to a PDC changemaker → write mapped organization fields into PDC | **Yes**\*      | **Yes (OIDC)**\*           |

\* `updateAll --dry-run` performs the full discovery and mapping and logs exactly what it _would_ write, without authenticating or contacting the PDC for writes.

Invocation examples:

```bash
data-scripts techsoup inventory --source C:\Data\TechSoup\organizations
```

```bash
data-scripts techsoup updateAll --source techsoup-bundles.zip --dry-run --pdc-api-base-url <url> --oidc-base-url <url> --oidc-client-id <id> --oidc-client-secret <secret>
```

```bash
data-scripts techsoup updateAll --source C:\Data\TechSoup\organizations --pdc-api-base-url <url> --oidc-base-url <url> --oidc-client-id <id> --oidc-client-secret <secret>
```

> Because the source is a local bundle, no source API key is required. Authentication (OIDC) is only needed to _write_ into PDC via `updateAll` (and is skipped entirely under `--dry-run`).

---

## 2. External Systems

### TechSoup OKF bundles (source)

- **Format:** [OKF](https://okf.md/spec/) — each organization is a directory ("package") of markdown files with YAML **frontmatter**. The package root is `README.md` with frontmatter `type: org`; sibling files (`impact.md`, `population.md`, `programs.md`, `what_i_need_funding_for.md`, `technical-volunteers/*.md`, …) carry the rest.
- **Delivery:** a single `.zip`, a folder of extracted packages, or a folder containing several `.zip` files. See §6.
- **Parsing:** frontmatter is parsed with [`js-yaml`](https://github.com/nodeca/js-yaml) (`JSON_SCHEMA`, so timestamp-like scalars stay strings). Zips are read with [`adm-zip`](https://github.com/cthackers/adm-zip) — no shell dependency and cross-platform.
- **Mapping origin:** [`docs/mappings/techsoup-okf-field-gap-analysis.verbose.md`](mappings/techsoup-okf-field-gap-analysis.verbose.md).

### PDC API (destination)

- **Client:** Axios wrapper in [`../src/pdc-api.ts`](../src/pdc-api.ts) / [`../src/client.ts`](../src/client.ts)
- **Auth:** OIDC `client_credentials` grant via [`../src/oidc.ts`](../src/oidc.ts) (`getToken`). Only `updateAll` (non-dry-run) authenticates; reads of `/changemakers` are anonymous.
- **Relevant endpoints:**
  - `GET /changemakers` — list all changemakers (shallow, anonymous)
  - `GET /sources` — find the TechSoup source
  - `POST /sources` — create the source (admin-only; typically fails for non-admins)
  - `POST /changemakerFieldValueBatches` — open a batch
  - `POST /changemakerFieldValues` — write one field value

---

## 3. Data Flow (the `updateAll` path)

```
--source (zip | folder | folder-of-zips)
       │
       ▼
prepareSourceRoot ──► extract any .zip(s) to a temp dir (adm-zip), else use folder as-is
       │
       ▼
findOrgBundles ──► walk the tree; every dir whose README.md frontmatter is `type: org`
                   is one OKF package (1 package if the root itself is a bundle, else many)
       │
       ▼
GET PDC /changemakers  ──► (optionally scoped to one via --changemaker-id)
       │
       ▼  (if --dry-run: log intended writes and stop here)
Authenticate to PDC (OIDC client_credentials) ──► access token
       │
       ▼
Find or create PDC Source (dataProviderShortCode = "techsoup")
       │
       ▼
Open a ChangemakerFieldValueBatch (sourceId + notes with timestamp)
       │
       ▼
For each OKF package (one at a time):
   extract EIN from README frontmatter (x-civic.registration.id, IRS-EIN only)
      └─ no valid EIN ──► skip package
   resolve EIN against PDC changemakers (resolveChangemaker)
      ├─ exactly one match ──► use it
      ├─ >1 match (ambiguous) ──► skip package (warn)
      └─ no match ──► --add-changemakers ? POST /changemakers (taxId=EIN, name=README title)
                                          : skip package
   derive goodAsOf from README generated.at
   collect organization fields (organizationFieldMap) and proposal fields
      └─ proposal fields are reported but NOT written (stubbed — see §4.2)
   For each organization field ──► POST /changemakerFieldValues
      (batchId, changemakerId, baseFieldShortCode, value, goodAsOf)
      └─ 403 Forbidden ──► warn + record changemakerId, continue
       │
       ▼
Clean up any temp extraction dir
```

### Key processing details

- **Package detection (1 vs many):** `findOrgBundles` walks the resolved root and treats every directory whose `README.md` frontmatter declares `type: org` as one package (it does not descend into a package once found). If the root _itself_ is a package, exactly one is returned; otherwise every nested package is collected. `describeBundleCount` logs which case occurred. Either way, packages are processed **one at a time**.
- **EIN extraction (`extractEin`):** reads `x-civic.registration.id` and only accepts it when `x-civic.registration.scheme` is `IRS-EIN` (or absent) **and** the id passes `isValidEin` (`^\d{2}-?\d{7}$`). Non-US bundles (Polish `KRS`, Kenyan PBO, …) therefore yield no EIN and are skipped — they cannot match a US-EIN-keyed changemaker.
- **EIN → changemaker matching (`resolveChangemaker`):** compares hyphen-stripped EINs and classifies the result as `matched` (exactly one), `ambiguous` (more than one — always skipped with a warning, never auto-created), or `missing` (none). By default `missing` is skipped ("if it doesn't exist in the PDC, skip it"); with `--add-changemakers` a `missing` package instead **creates** a changemaker (see below).
- **Creating changemakers (`--add-changemakers`, `createChangemakerForBundle`):** off by default. When on, a `missing` package is created via `POST /changemakers` with `taxId` = the package EIN (stored **verbatim, hyphenated**, e.g. `00-1000008`) and `name` = the README `title`. A package with **no README title is skipped** (a changemaker needs a name), and a **403** on create is treated like other privileged writes (warned and skipped). Newly created changemakers are tracked in-memory so a second package with the same EIN in the same run reuses the new record rather than creating a duplicate. The flag is **ignored when `--changemaker-id` is set** (that scopes the run to one existing changemaker), and it does not apply to `ambiguous` matches.
- **`goodAsOf` derivation (`extractGoodAsOf`):** takes the date portion (`YYYY-MM-DD`) of the README's `generated.at`, or `null` if missing/unparseable (`goodAsOf` is nullable in PDC).
- **Value coercion (`toFieldValueString`):** trims strings (dropping empties), stringifies numbers/booleans, and joins arrays (e.g. `aliases`, `ntee`) with `"; "`. Objects are skipped.
- **Sequential writes:** field values are POSTed one at a time (not `Promise.all`) because the PDC API times out under concurrent POSTs to `/changemakerFieldValues`.
- **403 handling:** `postChangemakerFieldValueWarnOnForbidden` swallows HTTP 403 (logs a warning, records the `changemakerId` for an end-of-run summary) and re-throws any other error.
- **Source resolution:** `getOrCreateSource` finds an existing source with `dataProviderShortCode === "techsoup"`; otherwise attempts to create one, warning that this usually requires a `pdc-admin`.
- **Temp cleanup:** any temporary extraction directory is removed in a `finally` block, whether the run succeeds or throws.

---

## 4. Field Mapping: TechSoup OKF → PDC

The mapping mirrors the original OKF exporter (gap analysis §2) and is defined by two constants in [`../src/techsoup.ts`](../src/techsoup.ts). Each entry reads one dotted frontmatter path from one file in the package and targets a PDC **base field** short code.

### 4.1 Organization fields — written to PDC (`organizationFieldMap`)

| OKF source (`file#frontmatter.path`)     | PDC base field short code       |
| ---------------------------------------- | ------------------------------- |
| `README.md#title`                        | `organization_name`             |
| `README.md#description`                  | `organization_overview`         |
| `README.md#aliases`                      | `organization_dba_name`         |
| `README.md#status`                       | `organization_status`           |
| `README.md#x-civic.registration_country` | `organization_country`          |
| `README.md#x-civic.registration.id`      | `organization_tax_id`           |
| `README.md#x-civic.ntee`                 | `organization_ntee_code`        |
| `README.md#x-civic.situation`            | `organization_geographic_area`  |
| `population.md#description`              | `community_definition_overview` |

Each becomes a **`ChangemakerFieldValue`**:

| PDC field value property | Value / source                                               |
| ------------------------ | ------------------------------------------------------------ |
| `changemakerId`          | Resolved via `getChangemakerByEin` (normalized EIN match)    |
| `batchId`                | ID of the batch opened for this run                          |
| `baseFieldShortCode`     | From the mapping table above                                 |
| `value`                  | Coerced via `toFieldValueString` (arrays joined with `"; "`) |
| `goodAsOf`               | Derived from README `generated.at` (ISO date or `null`)      |

> **Known data-quality caveat (gap analysis §5.1):** `README#status` is an OKF _document_ lifecycle value (`stable`/`draft`), not an organizational status. It is mapped to `organization_status` to match the existing exporter output; the code carries a `NOTE` to revisit this once the correct source is settled. `organization_dba_name` and `organization_ntee_code` originate as arrays and are flattened to a `"; "`-joined string (§5.5).

### 4.2 Proposal fields — collected and reported, **not yet written** (`proposalFieldMap`)

| OKF source (`file#frontmatter.path`)                      | PDC base field short code         |
| --------------------------------------------------------- | --------------------------------- |
| `impact.md#description`                                   | `proposal_project_outcomes`       |
| `programs.md#description`                                 | `proposal_related_programs`       |
| `what_i_need_funding_for.md#title`                        | `proposal_name`                   |
| `what_i_need_funding_for.md#description`                  | `proposal_funding_summary`        |
| `technical-volunteers/<volunteer-request>.md#description` | `proposal_learning_and_evalution` |

**Why stubbed:** PDC proposal data is not a flat set of values on a changemaker. It requires an **Opportunity + ApplicationForm + ProposalVersion** scaffold (see [`../src/postProposalVersions.ts`](../src/postProposalVersions.ts)) whose form/opportunity identity is not derivable from an OKF bundle alone. Until that model is decided, `updateAll` **collects** proposal fields and logs them via `warnProposalsStubbed` (a `TODO(techsoup-proposals)` marks the write site) but does not POST them. `inventory` still reports them so their availability is visible.

> The volunteer-request markdown file is named differently per package (e.g. `cohort-outcome-reporting.md`, `intake-triage-assist.md`), so `resolveVolunteerRequestFile` finds it by frontmatter `type: volunteer-request` rather than by a fixed filename.

### 4.3 EIN — used for matching, not stored as a field

`x-civic.registration.id` is the join key. It _is_ also mapped to `organization_tax_id` (per the exporter), but its primary role is to match the package to a PDC changemaker; a package with no matching changemaker is skipped entirely.

---

## 5. Command Reference

### `inventory`

- **Args:** `--source` (required), `--output-file`/`--write` (optional), `--show-fields`/`--fields` (optional boolean, default `false`).
- **Behavior:** Resolves the source (extracting zips as needed), discovers OKF packages, and for each reports its EIN, `goodAsOf`, and the count of mapped organization/proposal fields. Writes a full JSON inventory to `--output-file` if given, otherwise logs a summary. **No PDC interaction whatsoever** — this is the way to preview the mapping fully offline.
- **`--show-fields`:** Instead of per-package counts, prints the complete field-by-field mapping to the console: each organization field as a `WOULD POST changemakerFieldValue: <shortCode> = <value>` line, and each proposal field as a `proposal field (collected, NOT written)` line, with its `file#anchor` provenance. Nothing is sent to or read from the PDC; the changemaker match is only noted as happening at run time. This is the answer to "show me exactly what would go into PDC without running anything."

```bash
data-scripts techsoup inventory --source C:\Data\TechSoup\organizations --show-fields
```

### `lookupFromPdc`

- **Args:** `--source` (required), `--pdc-api-base-url` (required), `--output-file` (optional).
- **Behavior:** Discovers packages, extracts each EIN, reads all PDC changemakers, and reports per package whether a matching changemaker exists (and its ID). **Read-only** with respect to PDC.

### `updateAll`

- **Args:** `--source` (required), `--pdc-api-base-url` (required), all `oidcOptions` (`--oidc-base-url`, `--oidc-client-id`, `--oidc-client-secret`), `--changemaker-id` (optional; scope to one changemaker), `--dry-run` (optional boolean, default `false`), `--add-changemakers` (optional boolean, default `false`).
- **Behavior:** The full sync described in §3. The only subcommand that writes to PDC. `--dry-run` performs discovery and mapping and logs each intended `POST` (including `would CREATE changemaker …` lines when `--add-changemakers` is set) without authenticating or writing.
- **`--add-changemakers`:** When a package's EIN has **no** match in the PDC, create a new changemaker for it (`taxId` = EIN, `name` = README `title`) instead of skipping it. Requires a valid IRS-EIN and a README title; ambiguous matches are never auto-created; ignored when `--changemaker-id` is set. See §3 "Creating changemakers".

```bash
data-scripts techsoup updateAll --source C:\Data\TechSoup\organizations --add-changemakers --dry-run --pdc-api-base-url <url> --oidc-base-url <url> --oidc-client-id <id> --oidc-client-secret <secret>
```

---

## 6. Source resolution & package detection

`prepareSourceRoot` accepts three shapes for `--source` and normalizes them to a single directory to walk:

| `--source`                       | Handling                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| A `.zip` file                    | Extracted (adm-zip) to a temp dir; that dir becomes the root.                            |
| A folder with no `.zip` files    | Used directly as the root (extracted packages already on disk).                          |
| A folder containing `.zip` files | Each `.zip` is extracted into a temp dir (one subfolder per archive); that becomes root. |

The **number of OKF packages** is then a property of the tree, determined by `findOrgBundles` (§3): a root that is itself a `type: org` bundle yields one package; otherwise every nested bundle is collected. `describeBundleCount` logs "single OKF package" vs "N OKF packages … processing one at a time". A zip that wraps everything in a top-level folder is handled transparently because the walk is recursive. Any temp directory created for extraction is deleted after the command finishes.

---

## 7. Error Handling & Resilience Summary

| Concern                                 | Handling                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| Source is not a `.zip` or directory     | Throws a clear error naming the offending path                                 |
| Unreadable / missing markdown file      | `parseFrontmatterFile` logs at debug and returns `null`; that field is skipped |
| Malformed YAML frontmatter              | Caught; treated as empty frontmatter (package may then be skipped)             |
| No frontmatter at all                   | Treated as an empty object                                                     |
| Non-US / non-EIN registration           | `extractEin` returns `null`; package skipped (never created, even with `--add-changemakers`) |
| EIN not present in PDC                  | Default: package skipped. With `--add-changemakers`: a changemaker is created (see below)     |
| Ambiguous EIN → changemaker (>1 match)  | Skipped with a warning; never auto-created                                     |
| Create requested but no README title    | Skipped with a warning (`--add-changemakers` needs a name)                     |
| HTTP 403 on changemaker create          | Warned; that package skipped; run continues                                    |
| Null / empty / object-valued attributes | Skipped (not posted)                                                           |
| Multi-value attributes (arrays)         | Flattened to a `"; "`-joined string                                            |
| Missing / unparseable `generated.at`    | `goodAsOf` set to `null`                                                       |
| HTTP 403 on field-value write           | Warned + changemakerId recorded; run continues; summary warning at end         |
| PDC concurrency timeouts                | Field values POSTed sequentially                                               |
| Missing TechSoup source                 | Attempt to create (usually admin-only); warns it may fail                      |
| Proposal fields                         | Collected and reported, **not written** (stubbed — §4.2)                       |
| Temp extraction directory               | Always removed in a `finally` block                                            |

---

## 8. Testing

Unit tests in [`../src/techsoup.unit.test.ts`](../src/techsoup.unit.test.ts) cover the exported pure helpers:

- **`parseFrontmatter`** — parses top-level scalars, flow sequences, an inline flow map, a nested block map under `x-civic`, and a block sequence of mappings (`sources`) without disturbing later keys; strips trailing comments; returns `{}` when no frontmatter is present.
- **`getFrontmatterValue`** — follows a dotted path; returns `undefined` for a missing key, when descending into a non-object, or when descending into an array.
- **`toFieldValueString`** — trims strings, returns `null` for empty/whitespace/`null`/`undefined`/empty-array/plain-object, stringifies numbers/booleans, and joins arrays with `"; "` (dropping empties).
- **`extractEin`** — returns a valid EIN for `IRS-EIN` (or scheme-absent) registrations, and `null` for a non-IRS scheme (e.g. Polish KRS), an invalid id, or a missing id.
- **`extractGoodAsOf`** — extracts `YYYY-MM-DD` from `generated.at`; returns `null` when missing or unparseable.
- **`extractOrganizationName`** — returns the README `title` (the name used to create a changemaker); `null` when absent or blank.
- **`getChangemakerByEin`** — matches ignoring hyphens; returns `null` when there is no match or when more than one changemaker matches.
- **`resolveChangemaker`** — classifies an EIN as `matched` (unique), `missing` (none), or `ambiguous` (>1); this is what drives the `--add-changemakers` decision.
- **`selectChangemakers`** — returns the full bundle when no ID is given; scopes to a single changemaker and updates `total`; returns an empty bundle for an unknown ID.

The parsing/OKF helpers live in [`../src/okf.ts`](../src/okf.ts) and the changemaker matching/write helpers in [`../src/changemakers.ts`](../src/changemakers.ts); [`../src/techsoup.ts`](../src/techsoup.ts) is the CLI wiring. The file-system and network-facing functions (`prepareSourceRoot`, `extractZip`, `findOrgBundles`, `collectFieldsFromMap`, `createChangemakerForBundle`, `runUpdateAllWrite`, the command handlers, and all PDC writes) are not directly unit-tested; testability is achieved by extracting the pure parsing/mapping/matching logic into the exported helpers above (the same approach as the GivingTuesday integration).

---

## 9. Notable Constants & TODOs in the Code

- `TS_SHORT_CODE = 'techsoup'` — the PDC data provider short code for TechSoup.
- `ARRAY_VALUE_SEPARATOR = '; '` — how multi-valued frontmatter is flattened into a scalar field value.
- `FRONTMATTER_PATTERN` — isolates the YAML frontmatter block so the markdown body is never handed to the YAML parser.
- `HTTP_STATUS_FORBIDDEN = 403` — with a comment noting a shared `@pdc/http-status-codes` package should replace this once available.
- `TODO(techsoup-proposals)` — the write site for proposal data, pending the Opportunity/ApplicationForm/ProposalVersion model (§4.2).

---

## 10. Comparison with the other integrations

| Aspect            | Charity Navigator                 | GivingTuesday                  | TechSoup                                                |
| ----------------- | --------------------------------- | ------------------------------ | ------------------------------------------------------- |
| Source            | GraphQL API (Apollo)              | REST API (Axios GET)           | Local OKF bundle (zip/folder)                           |
| Source auth       | Bearer API key                    | None                           | None (local files)                                      |
| Source parsing    | GraphQL response                  | JSON response                  | YAML frontmatter (`js-yaml`) + `adm-zip`                |
| EIN normalization | Strip hyphen                      | Strip hyphen + zero-pad to 9   | Strip hyphen; IRS-EIN scheme only                       |
| `goodAsOf` source | `updatedAt`                       | `Date_Released` (`YYYY_MM_DD`) | README `generated.at` (date portion)                    |
| Fields written    | 4 (name, website, phone, mission) | 14 (IRS BMF)                   | 9 organization fields (proposals stubbed)               |
| Dry run           | via `lookup`/`lookupFromPdc`      | via `lookup`/`lookupFromPdc`   | `inventory`/`lookupFromPdc` **+ `updateAll --dry-run`** |
