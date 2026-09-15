# TechSoup OKF Bundle → PDC Field Gap Analysis

**Subject:** [`examples/synthetic-black-mountain-workforce-partnership_pdc.json`](https://github.com/TechSoup/okf-civic-sample/blob/main/examples/synthetic-black-mountain-workforce-partnership_pdc.json) in [TechSoup/okf-civic-sample](https://github.com/TechSoup/okf-civic-sample)
**Question:** The sample feed maps 14 base fields. Reading the full organization bundle (14 markdown files), how much *more* of it could be mapped into existing PDC base fields?
**PDC field catalog source:** live query of `https://api.philanthropydatacommons.org/baseFields` (the API that backs [philanthropydatacommons.org/base-fields-list](https://philanthropydatacommons.org/base-fields-list/)) — **282 base fields**, retrieved 2026-08-19
**Bundle source:** [`organizations/synthetic-black-mountain-workforce-partnership/`](https://github.com/TechSoup/okf-civic-sample/tree/main/organizations/synthetic-black-mountain-workforce-partnership) @ `main`
**Generated:** 2026-08-19

---

## 1. Executive summary

- **Yes — substantially more.** The feed maps **14 of 282** base fields. Another **~55 existing base fields** can be populated from the bundle as it stands today, with no new PDC fields required. That is roughly a **4× increase in coverage** from the same source files.
- **The root cause is mechanical, not semantic.** The exporter reads only YAML **frontmatter** (`title`, `description`, and four `x-civic` keys). It never reads the markdown **body** — and the body is where every number, the mission statement, the address, the financials, the program list, and the verification determination live. Fixing the extraction layer, not the mapping vocabulary, is where the leverage is.
- **Four highest-value additions, all trivially available:** `organization_website` (already sits in frontmatter as `resource:` and is simply dropped), `organization_mission_statement`, the address quintet (`organization_street_address_1` / `city` / `state_province` / `postal_code` / `county`), and the financial trio (`organization_total_revenue`, `organization_total_assets`, `organization_paid_staff`).
- **Three genuine data-quality bugs** in the current 14 mappings should be fixed regardless of scope: `organization_status` carries a *document* lifecycle value, `proposal_name` names the **wrong organization**, and three narrative fields carry the file's meta-disclaimer instead of its content. See §5.
- **Where the bundle is genuinely richer than PDC:** the technology inventory, the digital-capability rubric, the Candid PCS / SDG classifications, and the compliance-screening battery have **no PDC target at all**. These are new-base-field candidates (§7), and they are the part of the bundle that is uniquely TechSoup's.
- ⚠️ One structural decision is required before implementing: the bundle contains **two distinct proposal-shaped objects** (a funding need and a volunteer project request) that the flat feed collapses into one changemaker. See §6.

---

## 2. What is mapped today

All 14 values come from frontmatter, and `batch.notes` records the source as `file#frontmatter-key`.

| # | Base field | Source | Category |
|---|---|---|---|
| 1 | `organization_name` | `README.md#title` | organization |
| 2 | `organization_overview` | `README.md#description` | organization |
| 3 | `organization_dba_name` | `README.md#aliases` | organization |
| 4 | `organization_status` | `README.md#status` | organization |
| 5 | `organization_country` | `README.md#x-civic.registration_country` | organization |
| 6 | `organization_tax_id` | `README.md#x-civic.registration.id` | organization |
| 7 | `organization_ntee_code` | `README.md#x-civic.ntee` | organization |
| 8 | `organization_geographic_area` | `README.md#x-civic.situation` | organization |
| 9 | `proposal_project_outcomes` | `impact.md#description` | outcomes |
| 10 | `community_definition_overview` | `population.md#description` | project |
| 11 | `proposal_related_programs` | `programs.md#description` | project |
| 12 | `proposal_learning_and_evalution` | `technical-volunteers/cohort-outcome-reporting.md#description` | evaluation |
| 13 | `proposal_name` | `what_i_need_funding_for.md#title` | project |
| 14 | `proposal_funding_summary` | `what_i_need_funding_for.md#description` | project |

Note the pattern in rows 9–14: each pulls the file's *`description`*, which in this bundle is authored as a **note about the file** ("Synthetic annual results, illustrative only…"), not as the file's content. Four of the fourteen values are therefore metadata, not data.

Files contributing **nothing** today: `index.md`, `log.md`, `verification.md`, `technology/index.md`, `technology/inventory.md`, `technology/capability.md`, `technical-volunteers/index.md`, `technical-volunteers/constraints.md` — **8 of 14 files**, including the two largest.

---

## 3. Mappable now — organization facts

Every row below has a ready, currently-unused PDC base field. Sources are markdown body unless noted.

### 3.1 Identity, contact, location

| Bundle data | Value in bundle | PDC base field | Source |
|---|---|---|---|
| Website | `https://synthetic-black-mountain-workforce.example.org` | `organization_website` | `README.md` **frontmatter** `resource:` |
| Mission (org's own words) | "Everybody who comes through our door has already been told to learn to code…" | `organization_mission_statement` | `README.md` body blockquote |
| Street address | 44 Black Mountain Road | `organization_street_address_1` | `README.md` body |
| City | Whitesburg | `organization_city` | `README.md` body |
| State | KY | `organization_state_province` | `README.md` body |
| Postal code | 41858 | `organization_postal_code` | `README.md` body |
| County | Letcher | `organization_county` | `README.md` body / `x-civic.situation` |
| Legal name | synthetic-Black Mountain Workforce Partnership | `organization_legal_name` | `README.md#title` |

`organization_website` is the single cheapest win in this analysis — it is already a parsed frontmatter key and is simply discarded.

### 3.2 Registration and tax status

| Bundle data | Value | PDC base field | Source |
|---|---|---|---|
| Tax status | `501(c)(3)` | `organization_irs_subsection`, `organization_charitable_organization`, `organization_deductibility_status` | `x-civic.registration.tax_status` |
| Registration scheme | `IRS-EIN` | (context for `organization_tax_id`) | `x-civic.registration.scheme` |
| Org type | PCS `EA040000` (nonprofit) | `organization_entity_type` | `x-civic.org_type` |
| Founded | 2013 | `organization_start_date` | `README.md` body |
| IRS exemption granted | 2013 ("the same year") | `organization_ruling_date` / `organization_irs_ruling_date` | `README.md` body |

### 3.3 Financials and staffing

| Bundle data | Value | PDC base field | dataType |
|---|---|---|---|
| Annual revenue | ~$920,000 | `organization_total_revenue` | `currency` |
| Assets | ~$310,000 | `organization_total_assets` | `currency` |
| Operating budget | ~$920,000 (same basis) | `organization_operating_budget` | `string` |
| Paid staff | ~12 | `organization_paid_staff` | `string` |
| Currency | USD | *(no base field — see §7)* | — |
| Revenue mix | ~⅔ public: federal workforce subaward via regional board, state allocation, economic-transition grant; remainder foundation | `significant_other_funders` | `string` |

`significant_other_funders` is the only field in PDC's `partnerships` category, and this bundle has real content for it that is currently thrown away.

### 3.4 Governance

| Bundle data | Value | PDC base field | Source |
|---|---|---|---|
| Board size | 9 | `organization_board_members_count` | `verification.md` |
| Board composition | two employer representatives + one graduate seat | `organization_governing_body_type`, `organization_leadership` | `verification.md` |
| Key-person concentration | program director is the sole person able to produce the federal report | `organization_workplace_issues` | `technology/inventory.md`, `capability.md` |

---

## 4. Mappable now — program, outcome, and proposal content

### 4.1 `impact.md` — the results table (currently unmapped)

Today `proposal_project_outcomes` receives the disclaimer sentence. The actual table is unused:

| Metric | Value | PDC base field |
|---|---|---|
| Adults enrolled across short-cycle tracks | 190 | `proposal_results`, `proposal_past_performance` |
| Completion within 16-week average cycle | 82% | `proposal_results` |
| Placements (healthcare-support, driving, electrical/solar, remote) | 138 | `proposal_results` |
| Laptops circulating through lending library | 45 | `proposal_results` |
| Building-based remote-work stations in use | 8 | `proposal_results` |

Recommendation: put the rendered table into `proposal_results`, move the narrative into `proposal_project_outcomes`, and keep the "placement-at-completion, not 12-month retention" caveat in `proposal_learning_and_evalution` — it is a methodology statement, and it is the most useful thing this bundle says about its own evidence.

### 4.2 `programs.md` — seven programs (currently unmapped)

Healthcare support (CNA / phlebotomy / medical assistant), Commercial driving (CDL), Electrical and solar installation, Remote-work readiness, GED and math bridge, Wraparound supports, Laptop lending library.

| Content | PDC base field |
|---|---|
| Full program list | `proposal_related_programs` (replace the description stub), `proposal_activities` |
| "Short tracks, employer commitments first, no track without a local job at the end" | `proposal_strategy`, `proposal_tactics_and_methods` |
| Track length 12–16 weeks | `proposal_duration` |
| Job training / workforce development | `proposal_program_area`, `proposal_focus` |
| Workstation facility as unrecognized program | `proposal_supplemental_information` |
| Letcher County, KY | `proposal_location_of_work`, `proposal_all_counties_served_by_project` |

### 4.3 `population.md` — who is served (currently a one-line stub)

| Content | PDC base field |
|---|---|
| Full "who Black Mountain serves" narrative | `community_definition_overview` (replace stub) |
| Ages 19–61, median ~38 | `proposal_age_group`, `proposal_demographics` |
| Sub-populations: former mining households, adults with a conviction record, participants in recovery, participants without workable home broadband | `proposal_demographics` |
| "Low engagement is not a motivation problem, it's a track record" | `proposal_engagement`, `proposal_equity` |
| Tracked vs. not tracked (enrollment/attendance/completion/credential/placement audited; retention not collected) | `proposal_learning_and_evalution` |
| Post-coal labor market, broadband scarcity, no transit | `proposal_need`, `proposal_context` |

⚠️ **Handle with care:** conviction history and recovery status are named in `technical-volunteers/constraints.md` as the tightest-restriction categories. They appear here only as *aggregate population description*, which is publishable; individual-level equivalents must never enter PDC. PDC classifies 230 of its 282 base fields as `restricted` and 52 as `public` — the sensitivity classification should be checked per field on ingest, not assumed.

### 4.4 `verification.md` — the determination (entirely unmapped; PDC has a whole category for it)

PDC's `evaluation` category contains 18 review fields and **none are used**.

| Bundle data | Value | PDC base field |
|---|---|---|
| Current status | ELIGIBLE / APPROVE | `review_status` |
| Confidence | 92% (HIGH) | `review_average_score` or `review_total_score` |
| Determination date | 2026-06-30 | `review_date`, `review_close_date` |
| Next re-validation due | 2027-06-30 | `review_end_date` |
| Determined by | `process:airt-simulated` | `review_assigned_to` |
| Workspace ID | `SYNTH-WORKSPACE-0008` | `review_submission_id` / `review_affiliate_id` |
| Stage | Determination v1 | `review_current_review_stage` |
| Findings narrative ("Not collected — organization states so explicitly"; noted-not-flagged on public revenue share) | `review_comments_to_applicant`, `review_additional_comments` |
| Screening cleared: OFAC, PEP, debarment, adverse media, FATF, sanctions | `steps_to_prevent_illegal_activity` (imperfect — see §7) |

This is the single largest untapped file in the bundle and the one whose PDC target vocabulary is most complete.

### 4.5 `what_i_need_funding_for.md` — the ask (only the stub is mapped)

| Content | PDC base field |
|---|---|
| Body narrative (the ask, in the org's voice) | `proposal_funding_summary` (replace stub), `proposal_need`, `proposal_purpose_statement` |
| Sustain/expand community visits; recruitment; general operating support | `proposal_activities`, `proposal_funding_category` |
| "Neither of us could run our half without the other" | `proposal_related_programs`, `significant_other_funders` |

⚠️ **This file's body is the wrong organization's content** — it describes a clinic with a nurse practitioner and a truck, and its `title` names "synthetic-Cumberland Gap Health Cooperative". That title is what currently populates `proposal_name`. See §5.

### 4.6 `technical-volunteers/` — a fully-specified project (only the description stub is mapped)

`cohort-outcome-reporting.md` is, structurally, a complete proposal.

| Content | PDC base field |
|---|---|
| Title: "Three funder reports from one participant record…" | `proposal_project_title` |
| "The need, in the org's words" | `proposal_need`, `proposal_context` |
| "What a volunteer would do" (7 numbered steps) | `proposal_activities`, `proposal_tactics_and_methods` |
| 5–8 weeks, in a between-cohort window | `proposal_duration`, `proposal_start_date` |
| "What this project is not" + the five confirm-first dependencies | `proposal_challenges_and_risks` |
| "Capacity gained" (4 days/quarter; removes single point of failure) | `proposal_anticipated_impact` |
| Runbook + second trained person + definition document | `proposal_sustainability` |
| "Data sensitivity — moderate, with two sharp edges" | `proposal_collects_personal_data`, `proposal_collects_new_or_personal_data_explanation` |
| Work from synthetic/de-identified cohort; signed confidentiality; least privilege | `proposal_collects_new_data_from_individuals` |
| "No scoring, ranking, or predicting participants"; conviction history never a filter | `proposal_equity`, `proposal_challenges_and_risks` |
| `constraints.md` in full ("build smaller than you want to", "reporting cannot break") | `proposal_challenges_and_risks`, `organization_workplace_issues` |
| Organizational strengths (good connection, employer relationships, candor) | `proposal_organizational_strengths` |

---

## 5. Data-quality issues in the existing 14 mappings

These are worth fixing whether or not coverage is expanded.

1. **`organization_status` = `"stable"` is the wrong `status`.** The bundle's frontmatter `status:` is an OKF *document lifecycle* value (`stable` / `draft` — `technology/capability.md` uses `draft`). PDC's `organization_status` is a **public** field describing the organization. Mapping one to the other publishes a document state as an organizational fact. The organization's actual status lives in `verification.md` ("Current status: ELIGIBLE") and belongs in `review_status`.

2. **`proposal_name` names the wrong organization** — "synthetic-Cumberland Gap Health Cooperative — What I need funding for", on the Black Mountain record. This is an upstream content bug in `what_i_need_funding_for.md`, but the exporter propagates it verbatim. Worth an ingest-time assertion that a proposal title's organization prefix matches the changemaker.

3. **Four values are metadata, not content.** `proposal_project_outcomes`, `community_definition_overview`, `proposal_related_programs`, and `proposal_funding_summary` all carry the file's authorial note ("Fabricated.", "Illustrative only; not part of the published civic/0.6 profile.") rather than the file's substance.

4. **Everything is typed `"string"`.** PDC declares 7 `currency`, 5 `email`, 4 `date`, 1 `number`, 1 `phone_number`, and 8 `file` fields. If financials and dates are added per §3, `organization_total_revenue` / `organization_total_assets` must be emitted as `currency`, `organization_irs_ruling_date` as `date`, and `organization_volunteers` as `number`.

5. **`organization_dba_name` emits an array under `"type": "string"`.** Multi-value handling should be explicit rather than a type/value mismatch.

6. **No `goodAsOf` anywhere.** Every file carries `generated.at`, most carry `sources[].last_modified`, and two carry `stale_after`. PDC base fields declare `valueRelevanceHours` (commonly 8640 ≈ 1 year, 4380 ≈ 6 months) — without `goodAsOf`, freshness cannot be evaluated. The bundle has better provenance dating than the feed transmits:
   - `README.md` → `sources[registry].last_modified: 2026-01-15` for registry-derived facts
   - `impact.md` → `sources[org-annual-report].last_modified: 2026-01-15`, `stale_after: 2027-08-07`
   - `verification.md` → `verified.at: 2026-06-30`, `stale_after: 2027-06-30`

7. **No `pdc_share_data` value.** The bundle expresses consent-adjacent intent as `x-civic.verifiable_by: [techsoup]` and a per-file `synthetic: true`. PDC has a `pdc_share_data` field (technical, restricted) that should carry an explicit determination rather than being left absent.

---

## 6. Structural decision required: one changemaker, two proposals

The bundle contains two independent proposal-shaped objects:

- **A funding need** (`what_i_need_funding_for.md`) — general operating and program support, in the organization's voice.
- **A volunteer project request** (`technical-volunteers/cohort-outcome-reporting.md`) — a scoped, time-boxed, in-kind technical project with its own title, activities, duration, risks, and anticipated impact.

The current feed has a flat `fields[]` array under a single `changemaker` and takes `proposal_name` from one file and `proposal_learning_and_evalution` from the other — silently merging two proposals into one. Populating §4.5 and §4.6 together would make that collision unmanageable (two different values for `proposal_activities`, `proposal_duration`, `proposal_need`).

**Recommendation:** emit these as **two separate proposals** against the same changemaker before expanding proposal-side coverage. If the target schema cannot express that yet, map only the funding need to `proposal_*` fields and keep the volunteer request in organization-scoped fields (`organization_workplace_issues`) until it can.

---

## 7. Bundle content with no PDC target (new-base-field candidates)

This is the material that is uniquely TechSoup's and that PDC currently cannot receive.

| Bundle content | Why it doesn't fit | Suggested direction |
|---|---|---|
| **Technology inventory** — Microsoft 365, Zoom, Bitdefender, Canva, QuickBooks, Asana, 34 refurbished laptops, 6 workstations, business-grade internet, WordPress/GA/Mailchimp | PDC has **no** software, hardware, or systems-inventory field at any level | `organization_technology_inventory`; optionally split acquired / detected |
| **Acquisition provenance lane** (`acquired-via-TechSoup` vs `sourced-directly` vs `derived`) | PDC records provenance at the *batch/source* level, not per-value-component | Extend `batch.source` semantics, or a per-value `provenanceMethod` |
| **Digital capability rubric** — 6 domains at Established / Developing / At risk | No maturity, assessment, or capacity-score field | `organization_digital_capability_*`, one per domain |
| **Digital-maturity tier** ("low-moderate") | Same | `organization_digital_maturity_tier` |
| **Candid PCS codes** — Subject `SN020302`, `SB040000`; Population `PG090000`, `PJ020000`, `PG030000`; OrgType `EA040000` | Only `organization_ntee_code` exists; PCS is the successor taxonomy and is carried here as *required* frontmatter | `organization_pcs_subject`, `organization_pcs_population`, `organization_pcs_org_type` |
| **UN SDG alignment** — 1, 4, 8 | No target | `organization_sdg_goals` |
| **Compliance screening battery** — OFAC, PEP, debarment, adverse media, FATF, sanctions, each cleared | `steps_to_prevent_illegal_activity` is a *methodology narrative* field, not a screening-result record | `organization_screening_results` or per-screen booleans in `evaluation` |
| **Partner relationship edge** — `partners_with: synthetic-cumberland-gap-health-cooperative` | `significant_other_funders` is about funders; nothing records a peer/programmatic partner | `organization_partner_reference` (mirroring `fiscal_sponsor_organization_reference`) |
| **Known unknowns / acknowledged absences** — "does not track 12-month retention", "nobody has asked whether the portal exports" | PDC can record a value or its absence, not an *attested* absence with a reason | A value-level `absenceReason`, or `proposal_learning_and_evalution` prose as an interim |
| **Volunteer constraints** ("no scoring or ranking of participants", "no enterprise CRM") | Org-authored terms of engagement have no home; `organization_workplace_issues` is a poor fit | `organization_engagement_constraints` |
| **Currency** — `budget_currency: USD` | `currency` is a dataType, not a declarable unit field | Carry as a unit on `currency`-typed values |

---

## 8. Coverage impact

| | Fields | Share of 282 |
|---|---:|---:|
| Mapped today | 14 | 5.0% |
| Additional mappable to **existing** fields (§3–§4) | ~55 | 19.5% |
| **Total achievable with no schema change** | **~69** | **24.5%** |
| Requires new base fields (§7) | ~11 concepts | — |

By PDC category, the achievable additions land as: `organization` +22, `project` +20, `evaluation` +9, `outcomes` +3, `budget` +4, `methodology` +5, `partnerships` +1, `sustainability` +1.

---

## 9. Recommended order of work

1. **Fix the six data-quality defects in §5** — smallest effort, highest correctness return. In particular stop mapping the document `status` to `organization_status`, and add `goodAsOf` from `generated.at` / `sources[].last_modified` / `verified.at`.
2. **Map the frontmatter that is already parsed but dropped** — `resource:` → `organization_website` is one line.
3. **Extract from the markdown body.** The bundle is regular enough (`##` sections, tables, blockquote for mission) to target specific sections rather than whole-file text; `batch.notes` can keep its `file#anchor` shape by pointing at the heading slug instead of a frontmatter key.
4. **Map `verification.md` into the `evaluation` category** — 9 fields from one currently-unread file, and the vocabulary already fits.
5. **Resolve the two-proposal structure (§6)**, then map `what_i_need_funding_for.md` and `cohort-outcome-reporting.md` bodies.
6. **Raise new base fields for §7**, prioritizing the technology inventory and PCS codes — the inventory is the data no other PDC source provides, and PCS is `civic/0.6`-required frontmatter that PDC currently cannot store.
7. **Report the upstream content bug** in `what_i_need_funding_for.md` (wrong organization's text and title) to TechSoup.

---

## 10. Verification notes

- Base field catalog retrieved by paginating `https://api.philanthropydatacommons.org/baseFields?_page=N&_count=100` (the page at `/base-fields-list/` renders client-side from this endpoint and returns no field content to a plain fetch). 282 unique `shortCode`s across 11 categories.
- Every base field named in this document was confirmed present in that catalog.
- Bundle read in full at `main`: 14 files (`README.md`, `index.md`, `log.md`, `impact.md`, `population.md`, `programs.md`, `verification.md`, `what_i_need_funding_for.md`, `technology/{index,inventory,capability}.md`, `technical-volunteers/{index,constraints,cohort-outcome-reporting}.md`).
- The bundle is **synthetic by design** — the organization, EIN (`00-` prefix, never IRS-assigned), address, financials, and determination are all fabricated. Field *shapes* are transferable; values are not.
