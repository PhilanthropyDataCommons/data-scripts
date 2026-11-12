# TechSoup Integration — Technical Report

**Source file:** [`../src/techsoup.ts`](../src/techsoup.ts)
**Generated:** 2026-09-18 (updated 2026-11-11: single-JSON-file import only; zip and markdown readers removed)
**Purpose:** Import one TechSoup organization, delivered as a single already-mapped PDC JSON file, into the Philanthropy Data Commons (PDC) as changemaker field values — either into an existing changemaker or a newly created one.

**Modules:** [`../src/techsoup.ts`](../src/techsoup.ts) (CLI) · [`../src/pdc-json.ts`](../src/pdc-json.ts) (JSON reader) · [`../src/fields.ts`](../src/fields.ts) (`TechSoupDocument` as read, `TechSoupPackage` once sorted by category) · [`../src/changemakers.ts`](../src/changemakers.ts) (choosing the changemaker, preview, PDC writes).

---

## 1. Overview

`techsoup` is a single [yargs](https://yargs.js.org/) command registered in [`../src/index.ts`](../src/index.ts). It takes **one JSON file** as its argument and loads that file's organization fields into **one** PDC changemaker.

```bash
npm run techsoup -- <file.json> [--create-changemaker | --changemaker-id <id>] [--dry-run] --pdc-api-base-url <url> --oidc-base-url <url> --oidc-client-id <id> --oidc-client-secret <secret>
```

How the target changemaker is chosen:

| Flags                   | Target                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `--create-changemaker`  | Create a **new** changemaker (`taxId` = file EIN, `name` = `changemaker.name`). Refused if the EIN already exists in PDC. |
| `--changemaker-id <id>` | Load into the existing changemaker with that ID (the file EIN is not required; a mismatch is warned about).               |
| neither                 | Match the file EIN (`organization_tax_id`) against PDC changemakers; exactly one must match.                              |

`--create-changemaker` and `--changemaker-id` are mutually exclusive.

`--dry-run` prints the target changemaker (ID, name, taxId — or `NEW changemaker`, or why nothing would be imported) and every field that would be imported, then stops. It reads the PDC changemaker list anonymously but does not authenticate or write.

> The OIDC options are declared as required by the shared `oidcOptions`, so supply them (or the `DS_*` environment variables) even with `--dry-run`; they are only used for a real import.

---

## 2. Input file

One JSON document per organization — the TechSoup exporter's `_pdc.json` shape:

```json
{
  "changemaker": { "name": "Example Org" },
  "fields": [
    { "baseFieldShortCode": "organization_name", "value": "Example Org", "batch": { "notes": "README.md#title" } },
    { "baseFieldShortCode": "organization_tax_id", "value": "12-3456789" },
    { "baseFieldShortCode": "organization_dba_name", "value": ["Alias One", "Alias Two"] },
    { "baseFieldShortCode": "proposal_name", "value": "A funding ask" }
  ]
}
```

- **EIN** — the `organization_tax_id` field value, kept only when it passes `isValidEin` (`^\d{2}-?\d{7}$`). Non-US ids yield no EIN.
- **Name** — `changemaker.name` (needed only when creating a changemaker).
- **Values** — coerced by `toFieldValueString`: strings trimmed (blank dropped), numbers/booleans stringified, arrays joined with `"; "`, objects dropped.
- **Provenance** — `batch.notes` (or the short code) is shown in the dry-run output.
- **`goodAsOf`** — always `null` (the file carries no generation date).
- **Split** — fields are classified by the PDC's own base-field categories (`GET /baseFields`, which needs no token). Only `organization` fields are posted to the changemaker; fields of any other category (`project`, `budget`, …) are proposal fields and are listed but not imported. Short codes that are not base fields in the target PDC are skipped with a warning.
- A file without a `fields` array, or that is not valid JSON, fails with an error.

---

## 3. Data Flow

```
<file.json>
     │
     ▼
readPdcJsonFile ──► TechSoupDocument { slug, ein, name, goodAsOf, fields }
     │
     ▼
GET PDC /baseFields (anonymous) ──► applyBaseFieldCategories ──► TechSoupPackage { …, organizationFields, proposalFields }
     │
     ▼
GET PDC /changemakers (anonymous)
     │
     ▼
planImport ──► update (existing changemaker) | create (new changemaker) | skip (reason)
     │
     ├─ --dry-run ──► log formatImportPreview lines and stop
     ├─ skip ──────► fail with the reason
     ▼
Authenticate (OIDC client_credentials)
     │
     ▼
find PDC Source "techsoup" (oldest if several; create only if none — 403/404 → stop, nothing written)
     │
     ▼
create changemaker (if planned; 403 → warn and stop) ──► open ChangemakerFieldValueBatch
     │
     ▼
POST each organization field to /changemakerFieldValues (sequentially; 403 → warn and continue)
proposal fields: reported, NOT written (stubbed — see §4.2)
```

---

## 4. Field Mapping

The JSON file is already mapped to PDC base-field short codes, so no mapping happens at import time. The tables below record the mapping TechSoup's exporter applies (from its OKF markdown profile), to document what the JSON is expected to contain. Which fields are written is decided by each base field's PDC category, not by these tables.

### 4.1 Organization fields — written to PDC

| OKF source (`file#frontmatter.path`)     | PDC base field short code      |
| ---------------------------------------- | ------------------------------ |
| `README.md#title`                        | `organization_name`            |
| `README.md#description`                  | `organization_overview`        |
| `README.md#aliases`                      | `organization_dba_name`        |
| `README.md#status`                       | `organization_status`          |
| `README.md#x-civic.registration_country` | `organization_country`         |
| `README.md#x-civic.registration.id`      | `organization_tax_id`          |
| `README.md#x-civic.ntee`                 | `organization_ntee_code`       |
| `README.md#x-civic.situation`            | `organization_geographic_area` |

> **Known data-quality caveat (gap analysis §5.1):** `README#status` is an OKF _document_ lifecycle value (`stable`/`draft`), not an organizational status. It is mapped to `organization_status` to match the existing exporter output.

### 4.2 Proposal fields — reported, **not yet written**

| OKF source (`file#frontmatter.path`)                      | PDC base field short code         |
| --------------------------------------------------------- | --------------------------------- |
| `impact.md#description`                                   | `proposal_project_outcomes`       |
| `programs.md#description`                                 | `proposal_related_programs`       |
| `what_i_need_funding_for.md#title`                        | `proposal_name`                   |
| `what_i_need_funding_for.md#description`                  | `proposal_funding_summary`        |
| `technical-volunteers/<volunteer-request>.md#description` | `proposal_learning_and_evalution` |
| `population.md#description`                               | `community_definition_overview`   |

`community_definition_overview` is a `project`-category base field in the PDC, so it can only be stored with a proposal even though it does not start with `proposal_`.

PDC proposal data needs an **Opportunity + ApplicationForm + ProposalVersion** scaffold (see [`../src/postProposalVersions.ts`](../src/postProposalVersions.ts)) that a single organization file cannot supply. Until that model is decided, proposal fields are listed by `--dry-run` and warned about by `warnProposalsStubbed` (`TODO(techsoup-proposals)`), but not POSTed.

---

## 5. Error Handling

| Concern                                          | Handling                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| File missing / not JSON / no `fields` array      | Error; nothing is read from or written to the PDC                                                 |
| No valid EIN and no `--changemaker-id`           | Skipped with reason (dry-run prints it; real run fails)                                           |
| EIN not in PDC (default mode)                    | Skipped; reason suggests `--create-changemaker`                                                   |
| EIN matches several changemakers                 | Skipped; reason suggests `--changemaker-id`                                                       |
| `--changemaker-id` not found                     | Skipped with reason                                                                               |
| `--changemaker-id` taxId differs from file EIN   | Warning; import proceeds into the given ID                                                        |
| `--create-changemaker` but EIN already in PDC    | Skipped (no duplicate); reason names the existing changemaker                                     |
| `--create-changemaker` but no `changemaker.name` | Skipped with reason                                                                               |
| HTTP 403 creating the changemaker                | Warned; nothing imported                                                                          |
| HTTP 403 on a field-value write                  | Warned; remaining fields continue; summary warning at end                                         |
| PDC concurrency timeouts                         | Field values POSTed sequentially                                                                  |
| No TechSoup source                               | Attempt to create (usually admin-only). 403/404 → clear "ask a pdc-admin" error, before any write |

---

## 6. Testing

Unit tests in [`../src/techsoup.unit.test.ts`](../src/techsoup.unit.test.ts) cover:

- **`readPdcJsonFile` / `parsePdcJsonDocument`** — reads one file (slug from the file name), keeps every usable field in file order, and rejects non-PDC-shaped or invalid JSON.
- **`pdcJsonToDocument`** — EIN from `organization_tax_id` (null for non-US), name from `changemaker.name`, array flattening, `batch.notes` provenance, blank values dropped.
- **`toChangemakerTarget`** — maps `--create-changemaker` / `--changemaker-id` / neither to a target.
- **`planImport`** — every branch: EIN match/missing/ambiguous/absent; explicit ID found/missing/without EIN; create new/duplicate/ambiguous/no name/no EIN.
- **`formatImportPreview`** — the dry-run output names the target changemaker (existing or new), lists each field to import, lists proposal fields separately, and prints only the reason on skip.
- **`applyBaseFieldCategories`** — keeps only `organization`-category fields, moves other categories to the proposal fields, drops unknown short codes.
- **`selectTechSoupSource`** — one, none, or several TechSoup sources.
- **`toLoggableError`** — HTTP errors are logged without request headers or tokens.
- **`resolveChangemaker`**, **`toFieldValueString`**.

The PDC-facing write path (`runImportWrite`) and the command handler are not unit-tested; the decision logic is extracted into the pure `planImport` / `formatImportPreview` helpers above.
