# TechSoup OKF Bundle → PDC (summary)

> Abbreviated from [`techsoup-okf-field-gap-analysis.verbose.md`](techsoup-okf-field-gap-analysis.verbose.md). Read that for per-field source lines, sample values, and full reasoning.

## At a glance

| | |
|---|---|
| **Source** | [TechSoup/okf-civic-sample](https://github.com/TechSoup/okf-civic-sample) — an OKF v0.2 / `civic/0.6` org bundle of 14 markdown files |
| **Sample feed** | `examples/synthetic-black-mountain-workforce-partnership_pdc.json` |
| **Grain** | One changemaker per bundle; flat `fields[]` array |
| **Today** | **14 of 282** base fields (5%) |
| **Achievable, no schema change** | **~69** (24.5%) — a 4× increase |
| **Root cause** | Exporter reads YAML **frontmatter only**, never the markdown **body** — where all numbers, mission, address, financials, programs, and the verification determination live |

⚠️ Bundle is **synthetic by design** (fake EIN, address, financials). Field *shapes* transfer; values do not.

## Mapped today (14) — all from frontmatter

| PDC base field | Source |
|---|---|
| `organization_name` | `README.md#title` |
| `organization_overview` | `README.md#description` |
| `organization_dba_name` | `README.md#aliases` |
| `organization_status` | `README.md#status` ⚠️ **bug — see Gotchas** |
| `organization_country` | `x-civic.registration_country` |
| `organization_tax_id` | `x-civic.registration.id` |
| `organization_ntee_code` | `x-civic.ntee` |
| `organization_geographic_area` | `x-civic.situation` |
| `proposal_project_outcomes` | `impact.md#description` ⚠️ metadata, not content |
| `community_definition_overview` | `population.md#description` ⚠️ metadata |
| `proposal_related_programs` | `programs.md#description` ⚠️ metadata |
| `proposal_learning_and_evalution` | `technical-volunteers/cohort-outcome-reporting.md#description` |
| `proposal_name` | `what_i_need_funding_for.md#title` ⚠️ **wrong org — see Gotchas** |
| `proposal_funding_summary` | `what_i_need_funding_for.md#description` ⚠️ metadata |

**8 of 14 files contribute nothing today**, including the two largest: `verification.md`, `technology/inventory.md`, `technology/capability.md`, `technical-volunteers/constraints.md`, plus `index.md`, `log.md`, `technology/index.md`, `technical-volunteers/index.md`.

## Mappable now — organization (~22 fields)

| Bundle source | PDC base field(s) |
|---|---|
| `README.md` frontmatter `resource:` | `organization_website` ⭐ *already parsed, just dropped — one-line fix* |
| README body blockquote (mission) | `organization_mission_statement` |
| README body address | `organization_street_address_1`, `_city`, `_state_province`, `_postal_code`, `_county` |
| README title | `organization_legal_name` |
| `x-civic.registration.tax_status` (501c3) | `organization_irs_subsection`, `_charitable_organization`, `_deductibility_status` |
| `x-civic.org_type` | `organization_entity_type` |
| Founded / exemption year | `organization_start_date`, `organization_ruling_date` / `_irs_ruling_date` |
| Revenue, assets, budget, staff | `organization_total_revenue` (currency), `_total_assets` (currency), `_operating_budget`, `_paid_staff` |
| Revenue mix (federal subaward, state, transition grant) | `significant_other_funders` |
| Board size / composition | `organization_board_members_count`, `_governing_body_type`, `_leadership` |
| Key-person concentration | `organization_workplace_issues` |

## Mappable now — program / proposal / evaluation (~33 fields)

| File | PDC base field(s) |
|---|---|
| `impact.md` results table | `proposal_results`, `proposal_past_performance`; move narrative to `proposal_project_outcomes` |
| `programs.md` (7 programs) | `proposal_related_programs`, `proposal_activities`, `proposal_strategy`, `proposal_tactics_and_methods`, `proposal_duration`, `proposal_program_area`, `proposal_focus`, `proposal_location_of_work`, `proposal_all_counties_served_by_project` |
| `population.md` | `community_definition_overview`, `proposal_age_group`, `proposal_demographics`, `proposal_engagement`, `proposal_equity`, `proposal_need`, `proposal_context` |
| **`verification.md`** ⭐ | `review_status`, `review_average_score`, `review_date`, `review_close_date`, `review_end_date`, `review_assigned_to`, `review_submission_id`, `review_current_review_stage`, `review_comments_to_applicant` — **9 fields from one currently-unread file; PDC's whole 18-field `evaluation` category is unused** |
| `what_i_need_funding_for.md` body | `proposal_funding_summary`, `proposal_need`, `proposal_purpose_statement`, `proposal_activities`, `proposal_funding_category` |
| `technical-volunteers/cohort-outcome-reporting.md` | `proposal_project_title`, `proposal_need`, `proposal_activities`, `proposal_duration`, `proposal_challenges_and_risks`, `proposal_anticipated_impact`, `proposal_sustainability`, `proposal_collects_personal_data`, `proposal_organizational_strengths` |

## No PDC target — new base field candidates

| Bundle content | Suggested |
|---|---|
| Technology inventory (software/hardware) | `organization_technology_inventory` |
| Digital capability rubric (6 domains) | `organization_digital_capability_*` |
| Candid **PCS codes** (Subject/Population/OrgType) — `civic/0.6`-*required* | `organization_pcs_subject` / `_population` / `_org_type` |
| UN SDG alignment | `organization_sdg_goals` |
| Compliance screening battery (OFAC, PEP, debarment…) | `organization_screening_results` |
| Partner relationship edge (`partners_with`) | `organization_partner_reference` |
| Attested absences ("does not track 12-month retention") | value-level `absenceReason` |
| Volunteer engagement constraints | `organization_engagement_constraints` |
| Acquisition provenance lane (`acquired-via-TechSoup`) | per-value `provenanceMethod` |
| `budget_currency: USD` | unit on `currency`-typed values |

## Gotchas / data-quality bugs

1. **`organization_status` = `"stable"` is the document lifecycle value**, not an org status — and PDC marks that field `public`. The real status is `ELIGIBLE` in `verification.md` → belongs in `review_status`.
2. **`proposal_name` names the wrong organization** ("Cumberland Gap Health Cooperative" on the Black Mountain record). Upstream content bug, propagated verbatim. Add an ingest assertion.
3. **Four values are metadata, not content** — they carry the file's authorial disclaimer ("Fabricated.", "Illustrative only…") instead of its substance.
4. **Everything is typed `"string"`** — PDC declares 7 `currency`, 5 `email`, 4 `date`, 1 `number`, 8 `file`. Financials/dates must be emitted with the right type.
5. **`organization_dba_name` emits an array under `"type": "string"`** — type/value mismatch.
6. **No `goodAsOf` anywhere**, though the bundle carries `generated.at`, `sources[].last_modified`, `verified.at`, and `stale_after`. PDC declares `valueRelevanceHours` — freshness is unevaluable without it.
7. **No `pdc_share_data` value.** Consent intent is expressed as `x-civic.verifiable_by` and should carry an explicit determination.
8. ⚠️ **Privacy:** conviction history and recovery status appear only as *aggregate* population description (publishable). Individual-level equivalents must never enter PDC. 230 of 282 PDC fields are `restricted`; check per field on ingest.

## Structural decision required

The bundle holds **two distinct proposals** — a funding need (`what_i_need_funding_for.md`) and a volunteer project request (`cohort-outcome-reporting.md`). The flat feed silently merges them. Expanding proposal-side coverage will collide on `proposal_activities` / `proposal_duration` / `proposal_need`.

→ **Emit as two proposals against one changemaker** before expanding. If the schema can't yet, map only the funding need and park the volunteer request in org-scoped fields.

## Next steps

1. Fix the data-quality defects above (esp. `organization_status`; add `goodAsOf`).
2. Map `resource:` → `organization_website` — one line.
3. Build body extraction (headings/tables are regular; keep `batch.notes` as `file#anchor` pointing at heading slugs).
4. Map `verification.md` → `evaluation` category — 9 fields, vocabulary already fits.
5. Resolve the two-proposal structure, then map the two proposal bodies.
6. Raise new base fields — prioritize technology inventory and PCS codes.
7. Report the upstream content bug to TechSoup.
