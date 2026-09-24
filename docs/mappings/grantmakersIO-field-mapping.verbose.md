# Grantmakers.io → PDC Field Mapping

**Subject:** [grantmakers.io](https://www.grantmakers.io) — both public datasets
· **Grantees** (grant records) — [/search/grantees/](https://www.grantmakers.io/search/grantees/)
· **Profiles** (foundations) — [/search/profiles/](https://www.grantmakers.io/search/profiles/)
**Question:** What can be mapped from each dataset into PDC base fields, and what has no PDC target?
**PDC field catalog source:** live query of `https://api.philanthropydatacommons.org/baseFields` (the API that backs [philanthropydatacommons.org/base-fields-list](https://philanthropydatacommons.org/base-fields-list/)) — **282 base fields**, retrieved 2026-08-19
**Grantmakers.io schema sources:** live Algolia indices behind both search pages; the rendered profile payload; and the project's own TypeScript typings in [grantmakers/grantmakers-next](https://github.com/grantmakers/grantmakers-next) (`shared/typings/`)
**Generated:** 2026-08-19

---

## 1. Executive summary

- **Both datasets map well, but asymmetrically.** The **Profiles** dataset (163,004 foundations, 63 fields) maps cleanly onto **~40 existing PDC base fields** — it is essentially a pre-parsed 990-PF organization record and PDC already has targets for nearly all of it. The **Grantees** dataset (4,882,146 grant records, 21 fields) maps to only **~12** — not because the data is poor, but because **PDC has no grant/award object**, and because of the identity problem below.
- **⚠️ The single biggest blocker is that grantee records carry no EIN.** IRS Form 990-PF Part XV does not require the filer to supply a recipient EIN (unlike Form 990 Schedule I). Grantee identity is a free-text name the funder typed. Without an EIN there is no reliable join to a PDC changemaker, and 4.9M name strings cannot be safely resolved into organization records.
- **Grantmakers.io is already solving that**, and it is the highest-value thing to ask them for. Their typings define an `Enhancements` layer with an LLM-derived **`grantee_ein`** carrying a confidence grade, plus `grantee_classification`, `grantee_mission`, and a `privacy_shield` flag for individual recipients. None of it is in the public index today. **If PDC can obtain the enhanced grants collection, the Grantees mapping goes from ~12 fields to a genuine changemaker-plus-funding-history feed.**
- **The largest untapped org-level source is the EOBMF join the pipeline already performs.** `shared/typings/irs/all.ts` shows grantmakers.io ingests the full IRS Exempt Organizations Business Master File (`NTEE_CD`, `SUBSECTION`, `CLASSIFICATION`, `FOUNDATION`, `DEDUCTIBILITY`, `RULING`, `STATUS`, addresses, financial bands) but surfaces only **two** derived booleans from it. PDC has exact base-field targets for **~15 more** of those columns — including `organization_ntee_code`, which PDC wants and grantmakers.io already holds.
- **⚠️ Governance blocker, must be resolved before any implementation.** Grantmakers.io's [Terms of Service](https://www.grantmakers.io/about/terms/) **expressly forbid automated collection** from the site. Site content is CC BY-SA 4.0. The compliant paths are (a) ingest the IRS 990-PF source directly, (b) use the open-source ETL in `grantmakers-next`, or (c) agree a direct feed with the project. **Do not build a scraper.** See §9.
- **Coverage note:** grantmakers.io is **990-PF only** — US private foundations. Community foundations, operating foundations, and public foundations file Form 990 and are **absent by design**. Three large DAF/corporate programs are also deliberately excluded. Data lags actual grantmaking by **9–18+ months**.

| Dataset                            |   Records | Source fields | PDC fields mappable now | Requires new PDC fields |
| ---------------------------------- | --------: | ------------: | ----------------------: | ----------------------: |
| Profiles (foundations)             |   163,004 |            63 |                 **~40** |             ~9 concepts |
| Grantees (grants)                  | 4,882,146 |            21 |                 **~12** |             ~5 concepts |
| Union (distinct PDC fields)        |         — |             — |    **~47 of 282 (17%)** |            ~12 concepts |
| Available upstream, not yet public |         — |          +~25 |                **+~20** |                       — |

---

## 2. What grantmakers.io is, and the scope limits that follow

Grantmakers.io parses the IRS machine-readable **Form 990-PF** e-file dataset into two search indices and a profile page per foundation. Both search pages are backed by Algolia; both use the index name `grantmakers_io` on two separate Algolia applications.

Constraints that shape any PDC ingest:

| Constraint                         | Consequence for PDC                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **990-PF only**                    | Only US **private foundations**. Community, operating, and public foundations are not present. A PDC funder roster built from this alone will be systematically incomplete. |
| **Grantee identity is free text**  | The filer types the recipient name. No EIN, no canonical form. `"SALVATION ARMY"`, `"THE SALVATION ARMY"`, and `"American Red Cross"` are all distinct facet values.        |
| **9–18+ month lag**                | The `tax_year` on a grant is the filing year, not the award date. `goodAsOf` must reflect the filing, not the grant.                                                        |
| **Verbatim data**                  | Values appear exactly as filed, misspellings included. Grantmakers.io applies only light formatting.                                                                        |
| **Deliberate exclusions**          | Bank of America Charitable Foundation, JPMorgan Chase Foundation, and AmazonSmile Foundation are omitted (DAF/volume).                                                      |
| **Grantee index covers 2021–2025** | Facet counts: 2021 (83,722) · 2022 (1,073,330) · 2023 (1,595,501) · 2024 (1,536,302) · 2025 (535,068). Recent years are still filling in.                                   |

---

# PART A — Grantees dataset → PDC

**Index:** `grantmakers_io` (app `QA1231C5W9`) · **4,882,146 records** · **21 attributes**
**Schema of record:** `GrantInCollection` in [`shared/typings/grantmakers/all.ts`](https://github.com/grantmakers/grantmakers-next/blob/main/shared/typings/grantmakers/all.ts)
**Record grain:** one grant line from one foundation's 990-PF Part XV, keyed `{funderEIN}_{taxYear}_{ordinal}`.

## A.1 The modelling problem

A grantee record is a **completed award**, and it mixes three PDC entities into one row:

1. the **funder** (`ein`, `organization_name`, `city`, `state`, `foundation_is_likely_inactive`)
2. the **changemaker/recipient** (`grantee_name`, `grantee_city`, `grantee_state`, `grantee_country`, …)
3. the **award** (`grant_amount`, `grant_purpose`, `tax_year`, `grant_number`)

PDC has no first-class grant or award object. Its nearest vocabulary is the `proposal_*` fields (an application) and `review_*` fields (a decision). A 990-PF grant is neither — it is the _outcome_. Every award-side mapping below is therefore an approximation and should be agreed with the PDC data team before implementation.

## A.2 Mapping — recipient (changemaker) side

| grantmakers.io field        | Type    | PDC base field                                           | Category     | Confidence                         |
| --------------------------- | ------- | -------------------------------------------------------- | ------------ | ---------------------------------- |
| `grantee_name`              | string  | `organization_name`                                      | organization | ⚠️ Medium — verbatim, unnormalized |
| `grantee_city`              | string  | `organization_city`                                      | organization | ✅ High                            |
| `grantee_state`             | string  | `organization_state_province`                            | organization | ✅ High                            |
| `grantee_state_displayed`   | string  | _(display variant of the above — do not map separately)_ | —            | —                                  |
| `grantee_country`           | string  | `organization_country`                                   | organization | ✅ High                            |
| `grantee_is_foreign`        | boolean | _(no field — implied by `organization_country`)_         | —            | ➖ Derived                         |
| `grantee_labeled_as_person` | boolean | **🚫 do not map — use as an exclusion filter**           | —            | See §8                             |

**No EIN.** `organization_tax_id` cannot be populated on the recipient side. This is the defining limitation of the dataset for PDC purposes.

## A.3 Mapping — award side

| grantmakers.io field         | Type           | PDC base field                                                                                                 | Category   | Confidence                                                                               |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `grant_amount`               | number         | `review_amount_recommended`                                                                                    | evaluation | ⚠️ Medium — it is _awarded_, not recommended; `proposal_amount_requested` is a worse fit |
| `grant_purpose`              | string         | `proposal_purpose_statement` (primary), `proposal_summary` / `proposal_abstract` (alt)                         | project    | ⚠️ Medium — often terse (`"GENERAL SUPPORT"`, 340,464 occurrences)                       |
| `grant_purpose`              | string         | `proposal_funding_category` when it matches a controlled value (`GENERAL OPERATING`, `SCHOLARSHIP`, `CAPITAL`) | project    | ⚠️ Medium                                                                                |
| `tax_year`                   | number         | `proposal_date`; also drives `goodAsOf`                                                                        | project    | ⚠️ Filing year, not award date                                                           |
| `grant_number`               | number         | _(ordinal within the filing — internal dedupe only)_                                                           | —          | ➖                                                                                       |
| `grants_to_preselected_only` | `true \| null` | _(no target — see §7)_                                                                                         | —          | ❌                                                                                       |

A synthesized `proposal_name` (e.g. `"{funder} — {purpose} ({tax_year})"`) is possible but fabricates a record the filer never created. **Not recommended.**

## A.4 Mapping — funder side (carried on every grant row)

| grantmakers.io field            | PDC base field                                               | Notes                                                                            |
| ------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `ein`                           | `organization_tax_id`                                        | On the **funder's** changemaker record — this is the reliable EIN in the dataset |
| `organization_name`             | `organization_name` (funder)                                 |                                                                                  |
| `organization_name`             | `significant_other_funders`                                  | On the **recipient's** record — a real, useful signal PDC can hold today         |
| `city` / `state`                | `organization_city` / `organization_state_province` (funder) |                                                                                  |
| `foundation_is_likely_inactive` | `organization_status` (funder)                               | Derived by `shared/algorithms/inactive.ts` — label as derived                    |

## A.5 Provenance and freshness

| grantmakers.io field                    | Use                                                    |
| --------------------------------------- | ------------------------------------------------------ |
| `last_updated_irs`                      | → value `goodAsOf` (authoritative source timestamp)    |
| `last_updated_grantmakers`              | → `batch` metadata (processing timestamp)              |
| `_id` / `objectID` (`{ein}_{year}_{n}`) | → `batch.notes` provenance pointer and idempotency key |

## A.6 Grantees — distinct PDC fields reachable

`organization_name` · `organization_city` · `organization_state_province` · `organization_country` · `organization_tax_id` (funder) · `organization_status` (funder) · `significant_other_funders` · `review_amount_recommended` · `proposal_purpose_statement` · `proposal_summary` · `proposal_funding_category` · `proposal_date` — **12 fields.**

---

# PART B — Foundation Profiles dataset → PDC

**Index:** `grantmakers_io` (app `KDWVSZVS1I`) · **163,004 records** · **59 indexed attributes**
**Full profile payload:** **63 fields** (the rendered profile carries more than the search index — notably `people[].hours`, `people[].compensation`, `charitable_activities[]`, `financial_stats[]`, `grants_application_*`, `pub78`, `contact.website`)
**Schema of record:** `GrantmakersExtractedDataObj` in [`shared/typings/grantmakers/all.ts`](https://github.com/grantmakers/grantmakers-next/blob/main/shared/typings/grantmakers/all.ts)

This is the strong half of the mapping. A 990-PF filer record is close to a one-to-one match for PDC's `organization` and `budget` categories.

## B.1 Identity and naming

| grantmakers.io                                                        | PDC base field                         | Confidence                                                 |
| --------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `ein`                                                                 | `organization_tax_id`                  | ✅ High — the join key for the whole integration           |
| `organization_name`                                                   | `organization_name`                    | ✅ High                                                    |
| `organization_name` (as filed)                                        | `organization_legal_name`              | ✅ High                                                    |
| `organization_name_prior_year`, `organization_name_second_prior_year` | `organization_dba_name` (multi-value)  | ⚠️ Medium — these are _historical_ names, not DBAs; see §7 |
| `organization_name_slug`                                              | `organization_id` (external reference) | ➖ Optional                                                |
| `_id`                                                                 | _(mirror of `ein` — do not map)_       | —                                                          |

## B.2 Address and contact

| grantmakers.io                                                                              | PDC base field                                            | Confidence                                                                        |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `street`                                                                                    | `organization_street_address_1`                           | ✅ High                                                                           |
| `street2`                                                                                   | `organization_street_address_2`                           | ✅ High                                                                           |
| `city`                                                                                      | `organization_city`                                       | ✅ High                                                                           |
| `state`                                                                                     | `organization_state_province`                             | ✅ High                                                                           |
| `zip`                                                                                       | `organization_postal_code`                                | ✅ High                                                                           |
| `country`                                                                                   | `organization_country`                                    | ✅ High                                                                           |
| `is_foreign`                                                                                | _(implied by `organization_country`)_                     | ➖                                                                                |
| `contact.website.cleaned` / `website`                                                       | `organization_website`                                    | ✅ High — use `cleaned`, not `verbatim`                                           |
| `website_verbatim`                                                                          | _(retain as provenance only)_                             | ➖                                                                                |
| `contact.website.status` (`VALID`/`REPAIRED`/`INVALID`/`NEEDS_REVIEW`), `.type`, `.notes[]` | _(provenance — gate ingest on `status !== 'INVALID'`)_    | ➖                                                                                |
| `website_is_an_email` = `true`                                                              | `organization_email` (the value is an address, not a URL) | ✅ High — **important**: prevents writing a `mailto:` into `organization_website` |

## B.3 Financials

`organization_grants_paid` is an exact match for `total_giving` and is currently empty in PDC for most foundations — this is the standout addition.

| grantmakers.io                                                                                                   | PDC base field                                               | dataType   | Confidence                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------- |
| `total_giving`                                                                                                   | `organization_grants_paid`                                   | `currency` | ✅ High — exact semantic match                                              |
| `assets`                                                                                                         | `organization_total_assets`                                  | `currency` | ✅ High                                                                     |
| `contributions`                                                                                                  | `organization_total_revenue`                                 | `currency` | ⚠️ Medium — contributions _received_, not total revenue                     |
| `distributions`                                                                                                  | `organization_total_expenses`                                | `currency` | ⚠️ Medium — qualifying distributions ≠ total expenses                       |
| `distributions`                                                                                                  | `organization_operating_budget`                              | `string`   | ⚠️ Low — proxy only; pick one of these two, not both                        |
| `financial_stats[]` (`tax_year`, `assets`, `total_giving`, `contributions`, `distributions`; 17 years for Lilly) | one PDC value **per tax year**, each with its own `goodAsOf` |            | ✅ High — this is how PDC's `valueRelevanceHours` model is meant to be used |

⚠️ **Do not map `assets` to `organization_net_assets`.** 990-PF reports fair market value of total assets; net assets requires liabilities, which grantmakers.io does not extract. `organization_net_assets`, `organization_total_liabilities`, and `organization_net_income` should be left empty.

## B.4 Filing, tax status, and IRS registration

| grantmakers.io                                  | PDC base field                                                                                 | Confidence                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `filings[].tax_period` (yyyymm)                 | `organization_tax_period`                                                                      | ✅ High                                                                                                 |
| `filings[].tax_period` → month                  | `organization_fiscal_year_end_date_month`                                                      | ✅ High                                                                                                 |
| `filings[].tax_year`                            | `organization_fiscal_year_end_date_year`                                                       | ✅ High                                                                                                 |
| `filings[].object_id_irs`                       | `organization_form_990` (`file`) — resolves to the IRS XML/PDF                                 | ✅ High — 17 filings available for a large filer                                                        |
| `filing_is_final_return`                        | `organization_status`                                                                          | ⚠️ Medium — signals dissolution                                                                         |
| `filing_is_amendment`, `filing_version`         | _(no target — filing metadata)_                                                                | ❌                                                                                                      |
| `pub78.deductibility_code[]` (e.g. `["PF"]`)    | `organization_deductibility_code`                                                              | ✅ High                                                                                                 |
| `pub78.deductibility_code[]`                    | `organization_deductibility_status`                                                            | ✅ High                                                                                                 |
| `pub78.irs_file_last_modified` / `.accessed_on` | → `goodAsOf`                                                                                   | ✅ High                                                                                                 |
| `eobmf_recognized_exempt`                       | `organization_charitable_organization`                                                         | ✅ High                                                                                                 |
| `eobmf_ruling_date` (yyyymm, e.g. `"193807"`)   | `organization_irs_ruling_date` (`date`) and/or `organization_ruling_date`                      | ✅ High — must be widened to a real date                                                                |
| _(constant: files 990-PF)_                      | `organization_entity_type` = private foundation                                                | ✅ High                                                                                                 |
| `is_likely_inactive`                            | `organization_status`                                                                          | ⚠️ Derived — algorithm in `shared/algorithms/inactive.ts`; label as derived, never as an IRS revocation |
| `part_v`                                        | _(currently `null` in every sampled profile — reserved for 990-PF Part V distribution ratios)_ | ❌ Not populated                                                                                        |

## B.5 People and governance

`people[]` is the richest under-used part of the profile. The **search index** exposes only `name` and `title`; the **profile payload** adds `hours` and `compensation`, and the typings add an optional `location`.

| grantmakers.io                                           | PDC base field                                                                        | Confidence                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `people[]` (full array)                                  | `organization_board_members_names` (`file`)                                           | ✅ High                                                       |
| `people[].length`                                        | `organization_board_members_count`                                                    | ✅ High                                                       |
| `people[]` where title matches `CHAIR*`                  | `organization_board_chair` + `organization_board_chair_title`                         | ✅ High                                                       |
| `people[]` where title matches `PRESIDENT`/`CEO`/`EXEC*` | `organization_executive_administrator` + `organization_executive_administrator_title` | ✅ High                                                       |
| `people[]` rendered narrative                            | `organization_leadership`                                                             | ✅ High                                                       |
| `people[].compensation` (+ `hours`)                      | `organization_governing_body_compensation`                                            | ✅ High — direct match, and rarely available elsewhere        |
| `people[]` where `hours > 0` (count)                     | `organization_paid_staff`                                                             | ⚠️ Medium — better than the boolean below                     |
| `is_likely_staffed`                                      | `organization_paid_staff`                                                             | ⚠️ Low — a derived boolean, not a count; prefer the row above |
| `people[].location` (typings; 990-N only)                | _(no target)_                                                                         | ❌                                                            |

⚠️ **Title strings are heavily abbreviated and unnormalized** — `"CHAIRMAN&CEO"`, `"VP SECY & GC"`, `"DIR EMERITUS"`, `"VPEVALUATION"`. Any chair/executive extraction needs a normalization pass and should carry a confidence flag. Note also that these are **named individuals**; see §8.

## B.6 Programs and grantmaking practice

| grantmakers.io                                    | PDC base field                                                                                                                                               | Confidence                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `charitable_activities[].description`             | `proposal_related_programs`, `proposal_activities`                                                                                                           | ✅ High — 990-PF Part IX-A direct charitable activities  |
| `charitable_activities[].expenses`                | `proposal_budget` / `proposal_project_budget`                                                                                                                | ⚠️ Medium                                                |
| `charitable_activities_count`                     | _(derived count — no target)_                                                                                                                                | ➖                                                       |
| `charitable_activities_are_restatement_of_grants` | _(data-quality flag — use to suppress the above when `true`)_                                                                                                | ➖                                                       |
| `grants_application_contact.name`                 | `organization_grants_officer`                                                                                                                                | ✅ High                                                  |
| `grants_application_contact.email`                | `organization_email`                                                                                                                                         | ✅ High                                                  |
| `grants_application_contact.phone`                | `organization_phone`                                                                                                                                         | ✅ High                                                  |
| `grants_application_contact.address.*`            | `organization_street_address_1/2`, `organization_city`, `organization_state_province`, `organization_postal_code` — **only if** the filing address is absent | ⚠️ Medium — it is an application address, often the same |
| `grants_application_info`                         | _(no target — see §7)_                                                                                                                                       | ❌                                                       |
| `grants_application_deadlines`                    | _(no target)_                                                                                                                                                | ❌                                                       |
| `grants_application_restrictions`                 | _(no target)_                                                                                                                                                | ❌                                                       |
| `grants_to_preselected_only`                      | _(no target — a hard eligibility signal, high value)_                                                                                                        | ❌                                                       |
| `grants_reference_attachment`                     | _(data-quality flag: grant detail is in an unparsed PDF attachment)_                                                                                         | ➖                                                       |

## B.7 Grantmaking statistics and rankings — no PDC target

`grant_max` · `grant_min` · `grant_median` · `grant_count` · `grant_count_all_years` · `grant_count_last_three_years` · `grants_facets[]` (per-year facet counts by recipient name, city, state, country, purpose, amount band) · `grants_current_year_top_20[]` · `grants_last_three_years_top_20[]` · `rank` · `rank_total` · `rank_giving`

PDC has no funder-profile/statistics vocabulary. These are **new-base-field candidates** (§7) and are among the most useful things a changemaker would want to know about a prospective funder.

`has_website` · `has_grants` · `has_recent_grants` · `has_extra_grants` · `has_charitable_activities` · `enable_algolia_search` are internal derived booleans — **do not ingest**; use them as ingest gates.

## B.8 Profiles — distinct PDC fields reachable

~40: `organization_tax_id`, `organization_name`, `organization_legal_name`, `organization_dba_name`, `organization_id`, `organization_street_address_1`, `organization_street_address_2`, `organization_city`, `organization_state_province`, `organization_postal_code`, `organization_country`, `organization_location`, `organization_website`, `organization_email`, `organization_phone`, `organization_total_assets`, `organization_total_revenue`, `organization_total_expenses`, `organization_grants_paid`, `organization_operating_budget`, `organization_tax_period`, `organization_fiscal_year_end_date_month`, `organization_fiscal_year_end_date_year`, `organization_form_990`, `organization_deductibility_code`, `organization_deductibility_status`, `organization_charitable_organization`, `organization_irs_ruling_date`, `organization_ruling_date`, `organization_entity_type`, `organization_status`, `organization_paid_staff`, `organization_board_members_names`, `organization_board_members_count`, `organization_board_chair`, `organization_board_chair_title`, `organization_executive_administrator`, `organization_executive_administrator_title`, `organization_leadership`, `organization_governing_body_compensation`, `organization_grants_officer`, `proposal_related_programs`, `proposal_activities`, `proposal_budget`.

---

## 6. Available upstream but not in the public data — the real opportunity

These appear in grantmakers.io's own typings and ETL but are stripped from the public index and profile payload. **This is where PDC should focus a partnership conversation**, because the extraction work is already done.

### 6.1 The EOBMF join — ~15 PDC fields, already ingested

`shared/typings/irs/all.ts` defines `EobmfDoc` with the full IRS Exempt Organizations Business Master File record. Grantmakers.io joins it but surfaces only `eobmf_recognized_exempt` and `eobmf_ruling_date`.

| EOBMF column                                        | PDC base field                                                                                           | Value to PDC                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `NTEE_CD`                                           | `organization_ntee_code`                                                                                 | ⭐ **Highest** — PDC's structured classification field |
| `SUBSECTION`                                        | `organization_irs_subsection`                                                                            | High                                                   |
| `CLASSIFICATION`                                    | `organization_irs_classification`                                                                        | High                                                   |
| `FOUNDATION`                                        | `organization_foundation_code`                                                                           | High                                                   |
| `DEDUCTIBILITY`                                     | `organization_deductibility_code`                                                                        | High                                                   |
| `RULING`                                            | `organization_irs_ruling_date`                                                                           | High                                                   |
| `STATUS`                                            | `organization_revocation_status`                                                                         | High                                                   |
| `NAME`                                              | `organization_irs_name`                                                                                  | High                                                   |
| `STREET` / `CITY` / `STATE` / `ZIP`                 | `organization_irs_address` / `organization_irs_city` / `organization_irs_state` / `organization_irs_zip` | High                                                   |
| `TAX_PERIOD`                                        | `organization_tax_period`                                                                                | Medium                                                 |
| `ACCT_PD`                                           | `organization_fiscal_year_end_date_month`                                                                | Medium                                                 |
| `ASSET_AMT` / `INCOME_AMT` / `REVENUE_AMT`          | `organization_total_assets` / `organization_net_income` / `organization_total_revenue`                   | Medium — banded                                        |
| `ICO` ("in care of")                                | _(no target)_                                                                                            | —                                                      |
| `GROUP`, `AFFILIATION`, `ACTIVITY`, `FILING_REQ_CD` | _(no target)_                                                                                            | —                                                      |

Because EOBMF is keyed on EIN and covers **all** exempt organizations — not just 990-PF filers — this is also the route to enriching PDC changemakers that grantmakers.io does not profile.

### 6.2 The grant `Enhancements` layer — the fix for the grantee identity problem

`Enhancements` / `EnhancedGrant` in `shared/typings/grantmakers/all.ts`:

| Enhancement                                                                                        | PDC base field                               | Why it matters                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `grantee_ein`                                                                                      | `organization_tax_id` (recipient)            | ⭐⭐ **The missing join key.** LLM-derived with a `confidence` of `high`/`medium`/`low` and an `EnhancementSource` (`llm`, `llm_confirmed`, `direct_name_match`, `normalized_name_match`). PDC should accept only `llm_confirmed` / `direct_match` / `high`. |
| `grantee_name_displayed`, `grantee_name_normalizations`                                            | `organization_name`, `organization_dba_name` | Normalized names — far better than the verbatim string                                                                                                                                                                                                       |
| `grantee_mission`                                                                                  | `organization_mission_statement`             | ⭐ PDC has no other source for grantee missions here                                                                                                                                                                                                         |
| `grantee_parent_mission`                                                                           | `organization_overview`                      | For subsidiary/chapter recipients                                                                                                                                                                                                                            |
| `grantee_classification` (`individual`/`nonprofit`/`government`/`educational`/`foreign`/`unknown`) | `organization_entity_type`                   | ⭐ Also the correct filter for excluding individual recipients                                                                                                                                                                                               |
| `grantee_keywords`                                                                                 | `proposal_focus`, `proposal_program_area`    | Medium                                                                                                                                                                                                                                                       |
| `formatted_grant_purpose`                                                                          | `proposal_purpose_statement`                 | Cleaner than the raw `grant_purpose`                                                                                                                                                                                                                         |
| `privacy_shield` (`is_individual`, `is_public_achievement`)                                        | **🚫 gate, do not ingest**                   | The authoritative individual-recipient suppression signal                                                                                                                                                                                                    |

⚠️ These values are **model-generated**. If ingested, they must carry provenance distinguishing them from filed IRS data — PDC's `batch.source` / `dataProvider` structure supports this, and the `Enhancement` type already carries `source`, `confidence`, and `enhanced_at` to populate `goodAsOf`.

### 6.3 Other fields in the typings but not in the public payload

| Field                                                                                                                 | PDC base field                                             | Note                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `phone`                                                                                                               | `organization_phone`                                       | Present on `GrantmakersExtractedDataObj`, explicitly `Omit`-ed from the public R2 object                  |
| `organization_names_all.filing.{line1,line2,combined,formatted}`                                                      | `organization_legal_name`                                  | The two-line filed name, properly reconciled                                                              |
| `organization_names_all.eobmf.{name,sort_name,ico}`                                                                   | `organization_irs_name`                                    |                                                                                                           |
| `organization_names_all.pub78`                                                                                        | `organization_irs_name`                                    | Third-source name corroboration                                                                           |
| `aiSummary`, `aiSummarySource`, `aiAccessDate`                                                                        | `organization_overview` / `organization_mission_statement` | AI-generated; provenance-sensitive, `aiAccessDate` → `goodAsOf`                                           |
| `IrsGrant.RecipientRelationshipTxt`                                                                                   | _(no target)_                                              | Disqualified-person / related-party disclosure — in the raw IRS XML, dropped before the grants collection |
| `IrsGrant.RecipientFoundationStatusTxt`                                                                               | `organization_foundation_code` (recipient!)                | ⭐ **A grantee-side IRS classification that is discarded today.** Worth asking for.                       |
| `pub78_tax_deductibility`                                                                                             | `organization_deductibility_status`                        |                                                                                                           |
| `part_v` (`PartV` interface — 5-year qualifying distributions, distribution rates, net value of noncharitable assets) | `organization_grants_paid`, budget category                | Defined but null in every profile sampled                                                                 |

### 6.4 Cross-reference: GivingTuesday

`shared/typings/grantmakers/all.ts` also defines a `GivTuesGrant` interface over the GivingTuesday 990-PF data mart (`FILEREIN`, `SIGOCPYRBNBN1`, `SIGOCPYAMOUN`, `SIGOCPYPOGOC`, …). Since this repo already ingests GivingTuesday ([`src/getMetrics.ts`](src/getMetrics.ts), branch `ENH-296`), **the same underlying 990-PF grants are reachable from two providers.** Deduplication strategy and provider precedence should be settled before adding grantmakers.io grants, or PDC will double-count.

---

## 7. Grantmakers.io content with no PDC target (new-base-field candidates)

| Content                                                                                                                                                   | Dataset             | Why it doesn't fit                                                                                          | Suggested direction                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Grant application guidance** — `grants_application_info`, `grants_application_deadlines`, `grants_application_restrictions`                             | Profiles            | PDC's vocabulary is applicant-facing; a funder's own published guidelines have no home                      | `funder_application_guidelines`, `funder_application_deadlines`, `funder_application_restrictions`        |
| **`grants_to_preselected_only`**                                                                                                                          | Both                | The single most actionable eligibility fact about a foundation — "does not accept unsolicited applications" | `funder_accepts_unsolicited_applications`                                                                 |
| **Giving statistics** — `grant_max`, `grant_min`, `grant_median`, `grant_count`, `grant_count_all_years`, `grant_count_last_three_years`                  | Profiles            | No funder-statistics fields                                                                                 | `funder_grant_count`, `funder_grant_median`, `funder_grant_range`                                         |
| **Grant distribution facets** — `grants_facets[]` by recipient/city/state/country/purpose/amount band, per tax year                                       | Profiles            | Aggregate analytics; PDC stores per-organization values                                                     | Likely out of scope for base fields — better as a derived PDC service                                     |
| **Rankings** — `rank`, `rank_total`, `rank_giving`                                                                                                        | Profiles            | No org-level ranking field (same gap identified for Charity Navigator's Encompass score)                    | `organization_rank_by_giving` — **or** a general org-level score/rating family that serves both providers |
| **Historical organization names** — `organization_name_prior_year`, `organization_name_second_prior_year`                                                 | Profiles            | `organization_dba_name` conflates "also known as" with "formerly known as"                                  | `organization_former_name`, or a temporal qualifier on `organization_dba_name`                            |
| **Filing lineage** — `filing_version`, `filing_is_amendment`, `object_id_irs`                                                                             | Profiles            | Filing metadata has no home beyond the `file` pointer                                                       | Carry in `batch.notes`; optionally `organization_form_990_filing_id`                                      |
| **Individual-recipient flag** — `grantee_labeled_as_person`, `privacy_shield`                                                                             | Grantees            | Correctly has no target — it is a suppression signal, not data                                              | Keep out of PDC entirely (§8)                                                                             |
| **Data-quality flags** — `grants_reference_attachment`, `charitable_activities_are_restatement_of_grants`, `is_malformed_grant`, `contact.website.status` | Both                | PDC values have provenance but no per-value quality grade                                                   | A value-level `qualityFlag` / `confidence`, which would also serve §6.2                                   |
| **990-PF Part V distribution ratios** (`PartV`)                                                                                                           | Profiles            | No payout-rate vocabulary                                                                                   | `funder_payout_rate`, `funder_qualifying_distributions`                                                   |
| **Recipient relationship / foundation status** (`RecipientRelationshipTxt`, `RecipientFoundationStatusTxt`)                                               | Grantees (upstream) | Related-party disclosure has no PDC concept                                                                 | `grant_recipient_relationship`                                                                            |

---

## 8. Privacy, quality, and consent cautions

1. **Individual grant recipients must be excluded.** `grantee_labeled_as_person` is `true` on a meaningful share of the 4.9M rows (scholarships, hardship grants, employee matching). These are **named private individuals** with a city and state. They are not changemakers and must never enter PDC. Filter on `grantee_labeled_as_person === false` **and**, if the enhanced collection is used, on `privacy_shield.is_individual === false` and `grantee_classification !== 'individual'`.

2. **`people[]` are named individuals with compensation.** Officer/director names, hours, and pay are public on the 990-PF, so publishing them is lawful — but PDC classifies **230 of its 282 base fields as `restricted`** and only 52 as `public`. `organization_governing_body_compensation` and the board-name fields should be ingested at the sensitivity PDC declares, not at the sensitivity of the IRS source.

3. **Malformed and placeholder grantee rows are common.** The very first record returned by the live index is `grantee_name: "GRANTS"`, `grant_amount: 698,710,460`, `grant_purpose: "SEE ATTACHED PDF"`, `grantee_labeled_as_person: true` — a filer who put a summary line where a grantee should be. Any ingest needs a validity gate; `is_malformed_grant` and `grants_reference_attachment` exist for this.

4. **`goodAsOf` must come from `last_updated_irs`, not `last_updated_grantmakers`.** The latter is a processing timestamp. Given PDC's `valueRelevanceHours` (commonly 8640 ≈ 1 year) and the dataset's 9–18 month lag, a large share of grant-derived values will already be near or past their relevance window on arrival. That is a correct and useful signal — but only if the timestamp is honest.

5. **Consent posture differs from a changemaker-supplied feed.** Everything here is public IRS data that the organization filed under legal obligation, not data it chose to share with PDC. `pdc_share_data` should carry an explicit determination for this provider rather than being left absent, and the distinction between filed data (§B), derived data (`is_likely_*`), and model-generated data (§6.2) should be visible in `batch.source`.

6. **Prefer `contact.website.cleaned` over `website_verbatim`**, and route `website_is_an_email === true` to `organization_email`. Roughly speaking, a non-trivial share of filed "website" values are email addresses or phone numbers — `contact.website.type` distinguishes `URL` / `EMAIL` / `PHONE-US` / `NULL` / `UNKNOWN`.

---

## 9. ⚠️ Access route — resolve before implementation

Grantmakers.io's [Terms of Service](https://www.grantmakers.io/about/terms/) state that crawling or otherwise using automated means to collect information from the Service is **expressly forbidden**, and direct users to the IRS source. Site content is licensed **CC BY-SA 4.0** (logo excepted).

The analysis in this document was produced by reading the published pages, the client-side search configuration, and the project's public source repository — but **that is not a basis for a production pipeline.** Three compliant options, in order of preference:

| Option                                                                                                                                    | What it gives                                                                                                                                               | Effort                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **A. Direct feed / partnership with grantmakers.io**                                                                                      | Everything in §6 — the EOBMF join, the enhanced grants with `grantee_ein`, `phone`, the reconciled names. Also the only route to the LLM-derived data.      | Low technical, requires an agreement |
| **B. Fork the open-source ETL** ([`grantmakers-next`](https://github.com/grantmakers/grantmakers-next)) and run it against the IRS source | Same parsed shape, self-hosted, no ToS issue. CC BY-SA attribution applies to their content; the IRS source is public domain.                               | High — a real ETL to operate         |
| **C. Ingest IRS 990-PF e-file XML directly**                                                                                              | Full control, no intermediary, but PDC re-does the parsing, name cleaning, EOBMF/Pub78 joins, and grantee resolution that grantmakers.io has already solved | Highest                              |

**Recommendation: pursue Option A first.** The `Enhancements` layer in §6.2 is the difference between a 12-field grants mapping and a usable one, and it cannot be reproduced cheaply.

---

## 10. Recommended order of work

1. **Settle the access route (§9)** — nothing else should start first.
2. **Ingest Profiles → the ~40 organization/budget fields in §B.** This is the clean, high-confidence half: 163,004 US private foundations with EIN, address, website, assets, grants paid, filings, deductibility, ruling date, board, and officer compensation. `organization_grants_paid` alone is worth the integration.
3. **Emit `financial_stats[]` as one value per tax year with its own `goodAsOf`** rather than a single current figure — this is what PDC's freshness model is built for and it comes free.
4. **Ask for the EOBMF join (§6.1).** ~15 more fields including `organization_ntee_code`, already extracted upstream, and applicable to PDC changemakers beyond the 990-PF universe.
5. **Do not ingest Grantees until grantee EIN resolution is available (§6.2).** Without it, 4.9M unresolvable name strings will damage changemaker identity more than the grant history helps. The one exception worth doing early: populate **`significant_other_funders`** on changemakers that _already_ have a PDC record and an EIN-confirmed match.
6. **Reconcile with the GivingTuesday feed (§6.4)** before adding any grant records — same source filings, two providers, guaranteed double-counting otherwise.
7. **Raise the new base fields in §7**, prioritizing `grants_to_preselected_only` (an eligibility fact changemakers act on) and the funder application-guidance trio.
8. **Coordinate the ranking/score gap with the Charity Navigator analysis** — [`charityNavigator-field-gap-analysis.md`](charityNavigator-field-gap-analysis.md) reached the same conclusion from a different provider. One org-level score/rating field family would serve both.

---

## 11. Verification notes

- PDC base field catalog retrieved by paginating `https://api.philanthropydatacommons.org/baseFields?_page=N&_count=100`. The `/base-fields-list/` page renders client-side from this endpoint and returns no field content to a plain fetch. **282 unique short codes** across 11 categories; dataType distribution: 256 `string`, 8 `file`, 7 `currency`, 5 `email`, 4 `date`, 1 `number`, 1 `phone_number`. Sensitivity: 230 `restricted`, 52 `public`.
- Every PDC base field named in this document was confirmed present in that catalog.
- Grantmakers.io schemas confirmed three ways: (a) live queries against both Algolia indices behind the two search pages (21 attributes over 50 sampled grantee records; 59 over 20 sampled profiles, plus a full 63-field profile payload); (b) the rendered profile page data; (c) the authoritative interfaces `GrantInCollection`, `GrantmakersExtractedDataObj`, `EobmfDoc`, `Enhancements`, `Person`, `PartV`, and `IrsGrant` in [`shared/typings/`](https://github.com/grantmakers/grantmakers-next/tree/main/shared/typings) at `main`.
- Record counts and facet distributions are live values as of 2026-08-19: 4,882,146 grantee records (tax years 2021–2025), 163,004 foundation profiles.
- `part_v` was `null` on every profile sampled (large, mid, and small filers), so it is treated here as defined-but-unpopulated.
