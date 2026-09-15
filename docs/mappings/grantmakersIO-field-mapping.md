# Grantmakers.io → PDC (summary)

> Abbreviated from [`grantmakersIO-field-mapping.verbose.md`](grantmakersIO-field-mapping.verbose.md). Read that for per-field confidence grades, schema provenance, and full reasoning.

## At a glance

| | |
|---|---|
| **Source** | [grantmakers.io](https://www.grantmakers.io) — parsed IRS **Form 990-PF** e-file data, two Algolia-backed datasets |
| **Schema of record** | `shared/typings/` in [grantmakers/grantmakers-next](https://github.com/grantmakers/grantmakers-next) |
| **Scope limit** | **990-PF only** = US *private* foundations. Community, operating, and public foundations file Form 990 and are **absent by design** |
| **Lag** | Grants appear **9–18+ months** after they were actually made |
| **Status** | Not implemented. Analysis only |

| Dataset | Records | Source fields | PDC fields mappable |
|---|---:|---:|---:|
| **Profiles** (foundations) | 163,004 | 63 | **~40** |
| **Grantees** (grants) | 4,882,146 | 21 | **~12** |
| Union (distinct) | — | — | **~47 of 282 (17%)** |

## 🚩 Two blockers — read first

**1. Access.** Grantmakers.io's [ToS](https://www.grantmakers.io/about/terms/) **expressly forbid automated collection** from the site. Content is CC BY-SA 4.0. **Do not build a scraper.** Options, in order of preference:

| | Route | Effort |
|---|---|---|
| **A** ⭐ | Direct feed / partnership — the only route to the enhanced data below | Low technical, needs an agreement |
| B | Fork their open-source ETL, run against IRS source | High |
| C | Ingest IRS 990-PF XML directly and re-do all parsing/joins | Highest |

**2. Grantee records carry no EIN.** Form 990-PF Part XV doesn't require a recipient EIN (unlike Form 990 Schedule I), so grantee identity is free text the funder typed. `organization_tax_id` cannot be populated on the recipient side. **Do not ingest Grantees until EIN resolution is available** — 4.9M unresolvable name strings would damage changemaker identity more than the grant history helps.

---

# PART A — Grantees (grants)

**Grain:** one 990-PF Part XV grant line, keyed `{funderEIN}_{taxYear}_{ordinal}`. Covers tax years 2021–2025.

**Modelling note:** one row mixes three PDC entities — funder, recipient, and award. PDC has no grant/award object; its nearest vocabulary is `proposal_*` (an application) and `review_*` (a decision). A 990-PF grant is the *outcome* of both. **Award-side mappings below are approximations — agree them with the PDC data team first.**

### Recipient (changemaker) side

| grantmakers.io | PDC base field | Fit |
|---|---|---|
| `grantee_name` | `organization_name` | ⚠️ verbatim, unnormalized |
| `grantee_city` | `organization_city` | ✅ |
| `grantee_state` | `organization_state_province` | ✅ |
| `grantee_country` | `organization_country` | ✅ |
| `grantee_is_foreign` | *(implied by country)* | ➖ |
| `grantee_labeled_as_person` | **🚫 exclusion filter — never ingest** | see Gotchas |
| *(no EIN)* | `organization_tax_id` ❌ | **the blocker** |

### Award side

| grantmakers.io | PDC base field | Fit |
|---|---|---|
| `grant_amount` | `review_amount_recommended` | ⚠️ it's *awarded*, not recommended |
| `grant_purpose` | `proposal_purpose_statement` (alt: `proposal_summary`, `proposal_abstract`) | ⚠️ often terse ("GENERAL SUPPORT" × 340k) |
| `grant_purpose` (controlled values) | `proposal_funding_category` | ⚠️ |
| `tax_year` | `proposal_date` + drives `goodAsOf` | ⚠️ filing year ≠ award date |
| `grant_number` | *(internal dedupe only)* | ➖ |
| `grants_to_preselected_only` | ❌ no target — high-value eligibility signal | |

### Funder side (carried on every grant row)

| grantmakers.io | PDC base field |
|---|---|
| `ein` | `organization_tax_id` (funder) — **the reliable EIN in this dataset** |
| `organization_name` | `organization_name` (funder) · **also → `significant_other_funders` on the recipient** ⭐ |
| `city` / `state` | `organization_city` / `organization_state_province` (funder) |
| `foundation_is_likely_inactive` | `organization_status` (funder) — derived, label as such |

**Provenance:** `last_updated_irs` → `goodAsOf`. `last_updated_grantmakers` → batch metadata. `objectID` → `batch.notes` + idempotency key.

---

# PART B — Foundation Profiles

**The strong half.** A 990-PF filer record is close to one-to-one with PDC's `organization` and `budget` categories.

### Identity & address

| grantmakers.io | PDC base field |
|---|---|
| `ein` | `organization_tax_id` ⭐ join key |
| `organization_name` | `organization_name`, `organization_legal_name` |
| `organization_name_prior_year`, `_second_prior_year` | `organization_dba_name` ⚠️ these are *former* names, not DBAs |
| `organization_name_slug` | `organization_id` (optional external ref) |
| `street` / `street2` / `city` / `state` / `zip` / `country` | `organization_street_address_1` / `_2` / `_city` / `_state_province` / `_postal_code` / `_country` |
| `contact.website.cleaned` | `organization_website` — **use `cleaned`, not `website_verbatim`** |
| `website_is_an_email = true` | `organization_email` — **prevents writing a `mailto:` into the website field** |

### Financials

| grantmakers.io | PDC base field | Fit |
|---|---|---|
| `total_giving` | `organization_grants_paid` (currency) | ⭐ exact match, empty in PDC today |
| `assets` | `organization_total_assets` (currency) | ✅ |
| `contributions` | `organization_total_revenue` (currency) | ⚠️ contributions *received* ≠ total revenue |
| `distributions` | `organization_total_expenses` **or** `organization_operating_budget` — pick one | ⚠️ qualifying distributions ≠ total expenses |
| `financial_stats[]` (17 yrs) | **one PDC value per tax year, each with its own `goodAsOf`** ⭐ | ✅ exactly what `valueRelevanceHours` is for |

⚠️ **Do not map `assets` → `organization_net_assets`.** 990-PF gives FMV of total assets; liabilities aren't extracted. Leave `organization_net_assets`, `_total_liabilities`, `_net_income` empty.

### Filing & IRS status

| grantmakers.io | PDC base field |
|---|---|
| `filings[].tax_period` | `organization_tax_period`, `organization_fiscal_year_end_date_month` |
| `filings[].tax_year` | `organization_fiscal_year_end_date_year` |
| `filings[].object_id_irs` | `organization_form_990` (file) — resolves to IRS XML |
| `pub78.deductibility_code[]` | `organization_deductibility_code`, `_deductibility_status` |
| `eobmf_recognized_exempt` | `organization_charitable_organization` |
| `eobmf_ruling_date` (yyyymm) | `organization_irs_ruling_date` (date) / `organization_ruling_date` |
| *(files 990-PF)* | `organization_entity_type` = private foundation |
| `filing_is_final_return`, `is_likely_inactive` | `organization_status` ⚠️ derived — never as an IRS revocation |
| `part_v` | ❌ `null` in every profile sampled — defined but unpopulated |

### People & governance

Search index gives `name` + `title` only; the **profile payload adds `hours` and `compensation`**.

| grantmakers.io | PDC base field |
|---|---|
| `people[]` | `organization_board_members_names` (file), `organization_board_members_count`, `organization_leadership` |
| `people[]` title ~ `CHAIR*` | `organization_board_chair` + `_board_chair_title` |
| `people[]` title ~ `PRESIDENT`/`CEO`/`EXEC*` | `organization_executive_administrator` + `_title` |
| `people[].compensation` + `hours` | `organization_governing_body_compensation` ⭐ rarely available elsewhere |
| `people[]` where `hours > 0` (count) | `organization_paid_staff` — prefer over the `is_likely_staffed` boolean |

⚠️ Titles are abbreviated and unnormalized (`CHAIRMAN&CEO`, `VP SECY & GC`, `VPEVALUATION`). Chair/exec extraction needs normalization + a confidence flag.

### Programs & grantmaking practice

| grantmakers.io | PDC base field |
|---|---|
| `charitable_activities[].description` | `proposal_related_programs`, `proposal_activities` |
| `charitable_activities[].expenses` | `proposal_budget` / `proposal_project_budget` |
| `grants_application_contact.name` / `.email` / `.phone` | `organization_grants_officer` / `organization_email` / `organization_phone` |
| `grants_application_info` / `_deadlines` / `_restrictions` | ❌ no target |
| `grants_to_preselected_only` | ❌ no target — **the single most actionable eligibility fact** |

**No target, skip:** `grant_max/min/median/count*`, `grants_facets[]`, `rank`/`rank_total`/`rank_giving`.
**Internal gates, never ingest:** `has_website`, `has_grants`, `has_recent_grants`, `has_extra_grants`, `has_charitable_activities`, `enable_algolia_search`, `charitable_activities_are_restatement_of_grants`, `grants_reference_attachment`.

---

## Available upstream but not public — the real opportunity

These are already extracted by grantmakers.io's pipeline and stripped from the public data. **This is the partnership ask.**

### EOBMF join — ~15 PDC fields, already ingested

They join the full IRS Business Master File but surface only two derived booleans from it.

| EOBMF column | PDC base field |
|---|---|
| `NTEE_CD` | `organization_ntee_code` ⭐⭐ |
| `SUBSECTION` / `CLASSIFICATION` / `FOUNDATION` | `organization_irs_subsection` / `_irs_classification` / `_foundation_code` |
| `DEDUCTIBILITY` / `RULING` / `STATUS` | `organization_deductibility_code` / `_irs_ruling_date` / `_revocation_status` |
| `NAME` / `STREET` / `CITY` / `STATE` / `ZIP` | `organization_irs_name` / `_irs_address` / `_irs_city` / `_irs_state` / `_irs_zip` |
| `TAX_PERIOD` / `ACCT_PD` | `organization_tax_period` / `_fiscal_year_end_date_month` |
| `ASSET_AMT` / `INCOME_AMT` / `REVENUE_AMT` | `organization_total_assets` / `_net_income` / `_total_revenue` (banded) |

EOBMF is keyed on EIN and covers **all** exempt orgs — also a route to enriching PDC changemakers grantmakers.io doesn't profile.

### Grant `Enhancements` layer — fixes the grantee identity blocker

| Enhancement | PDC base field |
|---|---|
| **`grantee_ein`** | `organization_tax_id` (recipient) ⭐⭐ **the missing join key** — LLM-derived with `confidence` + `EnhancementSource`; accept only `llm_confirmed` / `direct_match` / `high` |
| `grantee_mission` | `organization_mission_statement` ⭐ |
| `grantee_classification` | `organization_entity_type` — also the correct individual-recipient filter |
| `grantee_name_displayed` / `_normalizations` | `organization_name`, `organization_dba_name` |
| `grantee_keywords` | `proposal_focus`, `proposal_program_area` |
| `formatted_grant_purpose` | `proposal_purpose_statement` |
| `privacy_shield` | **🚫 suppression gate, never ingest** |

⚠️ Model-generated — must carry provenance distinguishing it from filed IRS data. `Enhancement` already has `source`, `confidence`, `enhanced_at` (→ `goodAsOf`).

### Other stripped fields

`phone` → `organization_phone` · `organization_names_all.*` → `organization_legal_name` / `_irs_name` · `aiSummary` (+`aiAccessDate`) → `organization_overview` / `_mission_statement` · **`RecipientFoundationStatusTxt`** → `organization_foundation_code` *(grantee-side IRS classification, in the raw XML, discarded today)*.

## Gotchas

- **Individual grant recipients must be excluded.** `grantee_labeled_as_person` is true on a meaningful share (scholarships, hardship, employee matching) — named private individuals with city/state. Filter on it **and** `privacy_shield.is_individual === false` **and** `grantee_classification !== 'individual'`.
- **Malformed rows are common.** The first record the live index returns is `grantee_name: "GRANTS"`, $698M, purpose `"SEE ATTACHED PDF"`. Needs a validity gate.
- **`goodAsOf` from `last_updated_irs`, not `last_updated_grantmakers`** (the latter is a processing timestamp). Given the 9–18mo lag, many values arrive near or past their `valueRelevanceHours` window — a correct and useful signal, if the timestamp is honest.
- **`people[]` are named individuals with compensation.** Public on the 990-PF, but ingest at PDC's declared sensitivity (230 of 282 fields are `restricted`), not the IRS source's.
- **Consent posture differs** — this is data orgs filed under legal obligation, not chose to share. `pdc_share_data` should carry an explicit determination.
- **GivingTuesday overlap** — their repo carries a `GivTuesGrant` interface; this repo already ingests GT ([`src/getMetrics.ts`](../../src/getMetrics.ts)). Same underlying 990-PF filings, two providers → **guaranteed double-counting** unless dedup/precedence is settled first.
- Three large DAF/corporate programs are deliberately excluded (BofA Charitable, JPMorgan Chase Foundation, AmazonSmile).

## No PDC target — new base field candidates

`funder_application_guidelines` / `_deadlines` / `_restrictions` · `funder_accepts_unsolicited_applications` (from `grants_to_preselected_only`) · `funder_grant_count` / `_grant_median` / `_grant_range` · `organization_rank_by_giving` · `organization_former_name` · `funder_payout_rate` (990-PF Part V) · `grant_recipient_relationship` · a value-level `qualityFlag` / `confidence`.

## Next steps

1. **Settle the access route** — nothing else starts first.
2. **Ingest Profiles → the ~40 org/budget fields.** `organization_grants_paid` alone justifies the integration.
3. **Emit `financial_stats[]` as one value per tax year** with its own `goodAsOf` — comes free.
4. **Ask for the EOBMF join** — ~15 more fields incl. `organization_ntee_code`.
5. **Hold Grantees** until `grantee_ein` is available. Exception: populate `significant_other_funders` on changemakers that already have a PDC record + EIN-confirmed match.
6. **Reconcile with GivingTuesday** before adding any grant records.
7. **Raise new base fields**, prioritizing `grants_to_preselected_only`.
8. **Coordinate the ranking/score gap** with [`charityNavigator-field-gap-analysis.md`](charityNavigator-field-gap-analysis.md) — same missing PDC concept, two providers.
