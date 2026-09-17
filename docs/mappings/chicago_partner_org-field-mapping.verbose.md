# Chicago Partner Organizations (artlook) → PDC Field Mapping

**Subject:** `C:\Data\Parliament\chicago_partner_org_metadata.xlsx` — the `columns` tab (schema inventory) and the `relationships` tab (join contract)
**Supporting context:** the companion `chicago_partner_org_metadata.md` in the same folder, which adds entity groupings, the allocation matrix, and `state`-field semantics that the spreadsheet alone does not carry
**Question:** Where can data from the artlook Chicago partner-organization schema fit into PDC base fields?
**PDC field catalog source:** live query of `https://api.philanthropydatacommons.org/baseFields` (the API that backs [philanthropydatacommons.org/base-fields-list](https://philanthropydatacommons.org/base-fields-list/)) — **282 base fields**, retrieved 2026-09-16
**Generated:** 2026-09-16

---

## 1. Executive summary

- **The source is a partner directory, not a grants system.** artlook is Chicago's arts-education partner portal: organizations, the programs they offer, and the schools they partner with, all scoped by school year. There are **no proposals, no awards, and no grant amounts** in the schema. PDC coverage is therefore concentrated almost entirely in the `organization` category, with a secondary band in `project`/`methodology` derived from the program catalog. PDC's `budget` and `evaluation` categories come out nearly empty.
- **~50 of 282 PDC base fields (18%) are reachable**, of which roughly 35 are high-confidence. That is a good result for a non-grants source and compares favourably to the TechSoup bundle (~69 but from a single hand-authored org) and grantmakers.io Grantees (~12).
- **⭐ EIN is present.** `organizations.employer_identification_number` gives a direct `organization_tax_id` join to PDC changemakers — the exact thing the grantmakers.io Grantees dataset lacks. This is what makes the feed immediately usable. Coverage of the column must be measured before committing (it is nullable).
- **⭐ Everything is school-year scoped.** `school_year_id` appears on `details`, `contacts`, `employees`, `programs`, `partnerships`, `organization_disciplines`, `district_organizations`, and `allocations`. This maps directly onto PDC's `goodAsOf` + `valueRelevanceHours` model — emit **one value per school year**, not a single current value. Same recommendation made for grantmakers.io `financial_stats[]`.
- **⚠️ Three different columns are named `state` and mean three different things.** `organizations.state` is a portal approval state; `details.state` is the year-scoped active/archived flag; `partnerships.state` is partnership approval. **`details.state` is the correct source for `organization_status`** — mapping `organizations.state` would repeat the exact defect flagged in the TechSoup analysis (publishing a workflow state as an organizational fact).
- **⚠️ The schema contains individual people, credentials, and access logs.** `teaching_artists` (résumés, portfolios, wage expectations, background-check files, demographics), `users` (`encrypted_password`, `confirmation_token`, `remember_token`), `sign_ins` (IP addresses), and `contacts` (named staff) are all present. The source itself carries two explicit org-set suppression flags — `details.mask_pii` and `details.restrict_access` — which **must gate ingest**. See §8.
- **Joins are polymorphic, not foreign-key.** `detailable`, `addressable`, `contactable`, `employable`, `allocateable`, `resourceable`, `badgeable`, `surveyable`. Every org-scoped query needs a `*_type = 'Organization'` predicate. The companion doc states plainly that `information_schema` foreign keys are sparse under this tenancy model.
- **The distinctive content PDC cannot receive** is the arts-education vocabulary: disciplines and sub-disciplines, approaches, outcome types, identity frequencies, languages served, financial-assistance types, badges, and the school-partnership graph itself. These are new-base-field candidates (§7).

---

## 2. What the source is, and the structure that follows

artlook is a multi-tenant Rails/Postgres application (Apartment-style tenancy). Each community is a Postgres schema carrying the same table set.

|                        |                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tables**             | 78 across two schemas — `chicago.*` (35) and `public.*` (43)                                                                                                                                                                          |
| **Columns**            | 695 total                                                                                                                                                                                                                             |
| **Tenant schema**      | `chicago.*` — read all partner entity data from here                                                                                                                                                                                  |
| **Shared schema**      | `public.*` — read only the global lookups from here: `communities`, `users`, `positions`, `grades`, `program_types`, `demographics`, `networks`, `space_types`, `schedule_types`, `engagement_types`, `integration_types`, `sign_ins` |
| **Temporal grain**     | School year (`school_year_id`)                                                                                                                                                                                                        |
| **Changemaker entity** | `chicago.organizations`                                                                                                                                                                                                               |

### 2.1 The two schemas are structurally identical

A column-level diff confirms `chicago.*` is a **strict subset** of `public.*`: every shared table has identical columns, and `public` additionally carries six lookup/aux tables (`demographics`, `engagement_types`, `integration_types`, `schedule_types`, `sign_ins`, `space_types`).

⚠️ **Do not ingest the `public.*` entity tables.** `public.organizations`, `public.details`, `public.addresses` etc. exist as the multi-tenancy _template_, not as Chicago data. Ingesting both schemas would duplicate every changemaker. Map once, against `chicago.*`.

### 2.2 The join contract

The `relationships` tab supplies 30 documented joins. The ones that matter for a PDC ingest:

```
chicago.organizations  ──1:1──  chicago.addresses      (addressable_type='Organization')
                       ──1:N──  chicago.details        (detailable_type='Organization', by school_year)
                       ──1:N──  chicago.contacts       (contactable_type='Organization', by school_year)
                       ──1:N──  chicago.employees      (employable_type='Organization', by school_year)
                       ──1:N──  chicago.programs       (organization_id, by school_year)
                       ──1:N──  chicago.organization_disciplines
                       ──1:N──  chicago.allocations    (allocateable_type='Organization')
                       ──1:N──  chicago.partnerships   (organization_id) ──N:1── chicago.schools ──N:1── chicago.districts
                       ──1:N──  chicago.district_organizations
chicago.programs       ──1:N──  chicago.program_grades ──N:1── public.grades
                       ──1:N──  chicago.allocations    (allocateable_type='Program')
```

### 2.3 The allocation fabric

`chicago.allocations` is a generic polymorphic tag join — it is how most descriptive attributes attach to an organization or program. Per the companion doc's allocation matrix:

| Allocated to       | Resource types attached                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| **Organization**   | Discipline, LeadershipCharacteristic, BadgeQuestion                                                     |
| **Program**        | Approach, FinancialAssistanceType, IdentityFrequency, OutcomeType, ProgramType, SubDiscipline, Language |
| **Partnership**    | ProgramType, Program                                                                                    |
| **TeachingArtist** | Approach, BadgeQuestion, Discipline, SubDiscipline, OutcomeType, ProgramType, Language                  |
| **TaProgram**      | Approach, FinancialAssistanceType, IdentityFrequency, OutcomeType, ProgramType, SubDiscipline, Language |

A developer cannot read the program catalog without resolving `allocations` — `resourceable_type` / `resourceable_id` point at the lookup table, and `allocations.state` says whether the tag is approved for that year.

---

## 3. Mappable now — organization identity, contact, and location

### 3.1 Identity — `chicago.organizations`

| Source column                    | PDC base field                             | PDC type | Fit         | Notes                                                                                   |
| -------------------------------- | ------------------------------------------ | -------- | ----------- | --------------------------------------------------------------------------------------- |
| `name`                           | `organization_name`                        | string   | ✅ High     | `NOT NULL`                                                                              |
| `name`                           | `organization_legal_name`                  | string   | ⚠️ Medium   | artlook does not distinguish legal from display name; populate only if no better source |
| `nickname`                       | `organization_dba_name`                    | string   | ✅ High     |                                                                                         |
| `nickname`                       | `organization_acronym`                     | string   | ⚠️ Medium   | Only when the value is genuinely an acronym — pick one of these two, not both           |
| `employer_identification_number` | `organization_tax_id`                      | string   | ⭐ **High** | **The join key.** Nullable — measure coverage first                                     |
| `mission`                        | `organization_mission_statement`           | string   | ⭐ **High** | `varchar`, so likely short-form                                                         |
| `id` / `sql_identifier`          | `organization_id`                          | string   | ➖ Optional | External reference; `sql_identifier` is a legacy key                                    |
| `created_at` / `updated_at`      | → `goodAsOf`                               | —        | ✅          | Row-level freshness                                                                     |
| `state`                          | **🚫 do not map to `organization_status`** | —        | ❌          | Portal approval workflow (`approved` / `pending_approval`) — see §5                     |
| `open_to_partnerships`           | _(no target — see §7)_                     | —        | ❌          | High-value availability signal                                                          |
| `employees_count`                | `organization_paid_staff`                  | string   | ⚠️ **Low**  | Counts _portal users affiliated with the org_, not headcount — see §5                   |
| `partnerships_count`             | _(no target)_                              | —        | ❌          | Denormalized counter                                                                    |
| `creation_type`                  | → `batch.notes` provenance                 | —        | ➖          | `Uploaded Via Data Base` / `Created in Active Admin` / `Self Registered` / `Untracked`  |
| `imported`                       | → provenance flag                          | —        | ➖          |                                                                                         |

### 3.2 Year-scoped profile — `chicago.details` (`detailable_type='Organization'`)

This table, not `organizations`, carries most of the publishable profile.

| Source column                                                      | PDC base field                               | PDC type     | Fit         | Notes                                                                                                         |
| ------------------------------------------------------------------ | -------------------------------------------- | ------------ | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `description`                                                      | `organization_overview`                      | string       | ⭐ **High** | `text` — the long-form org description                                                                        |
| `website`                                                          | `organization_website`                       | string       | ⭐ **High** |                                                                                                               |
| `phone`                                                            | `organization_phone`                         | string       | ✅ High     |                                                                                                               |
| `fax`                                                              | `organization_fax`                           | phone_number | ✅ High     | PDC types this as `phone_number`, not `string`                                                                |
| `governance`                                                       | `organization_governing_body_type`           | string       | ⚠️ Medium   | Enum values not in the export — inspect before mapping                                                        |
| `governance`                                                       | `organization_entity_type`                   | string       | ⚠️ Medium   | Depends on what the enum actually encodes; pick one target                                                    |
| `state`                                                            | `organization_status`                        | string       | ⭐ **High** | `approved` = active that year, `archived` = inactive. **This is the correct source**                          |
| `school_year_id`                                                   | → `goodAsOf`                                 | —            | ⭐ **High** | Resolve via `chicago.school_years.number`; `current` flags the live year                                      |
| `district_funding_cents` + `district_funding_currency`             | `significant_other_funders`                  | string       | ⚠️ Low      | District funding _received_. Not `organization_total_revenue` — it is one funding stream, not a total. See §7 |
| `csc_rating`                                                       | _(no target — see §7)_                       | —            | ❌          | A rating; PDC has no org-level rating field                                                                   |
| `professional_development`                                         | _(no target)_                                | —            | ❌          | Boolean capability flag                                                                                       |
| `schedule_url`, `services_route`, `billing_account`                | _(no target)_                                | —            | ❌          | Operational/internal                                                                                          |
| `state_board_identifier`, `nces_identifier`, `district_identifier` | _(no target)_                                | —            | ❌          | School-side identifiers; not meaningful for a partner org                                                     |
| `mask_pii`, `restrict_access`                                      | **🚫 ingest gates — never ingest as values** | —            | —           | See §8                                                                                                        |
| `imported`                                                         | → provenance flag                            | —            | ➖          |                                                                                                               |

### 3.3 Location — `chicago.addresses` (`addressable_type='Organization'`, 1:1)

| Source column               | PDC base field                     | PDC type | Fit                                                            |
| --------------------------- | ---------------------------------- | -------- | -------------------------------------------------------------- |
| `street`                    | `organization_street_address_1`    | string   | ✅ High (`NOT NULL`)                                           |
| `city`                      | `organization_city`                | string   | ✅ High (`NOT NULL`)                                           |
| `state`                     | `organization_state_province`      | string   | ✅ High (`NOT NULL`)                                           |
| `zip`                       | `organization_postal_code`         | string   | ✅ High (`NOT NULL`)                                           |
| `latitude`                  | `organization_latitude_epsg_4326`  | string   | ✅ High                                                        |
| `longitude`                 | `organization_longitude_epsg_4326` | string   | ✅ High                                                        |
| `community_area`            | `organization_neighborhood`        | string   | ⭐ **High**                                                    | Chicago's 77 community areas — a genuinely good fit for a field PDC rarely gets filled |
| `street` + `city` + `state` | `organization_location`            | string   | ➖ Optional composite                                          |
| _(constant)_                | `organization_country` = `US`      | string   | ✅ Derived                                                     |
| _(constant for Chicago)_    | `organization_county` = `Cook`     | string   | ⚠️ Derived — verify; the tenant may include collar-county orgs |
| `ward`                      | _(no target — see §7)_             | —        | ❌ Chicago alderman ward                                       |
| `congressional_district`    | _(no target)_                      | —        | ❌                                                             |
| `network_id`                | `organization_unit`                | string   | ⚠️ Low — resolve via `chicago.networks.name`                   |

⚠️ There is **no `street2` column** and **no `country` column**. `organization_street_address_2` will be empty and country must be asserted as a constant.

### 3.4 People — `chicago.contacts` and `chicago.employees`

Both are year-scoped and polymorphic on the organization.

| Source                                           | PDC base field                               | Fit       | Notes                                                                   |
| ------------------------------------------------ | -------------------------------------------- | --------- | ----------------------------------------------------------------------- |
| `contacts.first_name` (where `primary = true`)   | `organization_exec_admin_first_name`         | ⚠️ Medium | `primary` marks the main contact, which is not necessarily an executive |
| `contacts.last_name`                             | `organization_exec_admin_last_name`          | ⚠️ Medium |                                                                         |
| `contacts.email`                                 | `organization_exec_admin_email`              | ⚠️ Medium | PDC types this as `email`                                               |
| `contacts.email` (general/shared)                | `organization_email`                         | ✅ High   | Prefer a non-personal address if one exists                             |
| `contacts.phone`                                 | `organization_phone`                         | ✅ High   | Fallback if `details.phone` is null                                     |
| `contacts.fax`                                   | `organization_fax`                           | ✅ High   |                                                                         |
| `contacts.title`                                 | `organization_executive_administrator_title` | ⚠️ Medium | Free text                                                               |
| `contacts.position_id` → `public.positions.name` | `organization_executive_administrator_title` | ⚠️ Medium | Controlled vocabulary — prefer over free-text `title`                   |
| `contacts.position_id` → `public.positions.name` | `organization_grants_officer`                | ⚠️ Low    | Only if a position value actually denotes development/grants            |
| `contacts` / `employees` rendered list           | `organization_leadership`                    | ⚠️ Medium |                                                                         |
| `contacts.middle_initial`                        | _(no org-level target)_                      | ❌        | `proposal_submitter_middle_initial` exists but is proposal-scoped       |
| `contacts.state`, `employees.state`              | → filter to approved/active                  | ➖        |                                                                         |
| `employees.*`, `users.*`                         | **🚫 see §8**                                | —         | Portal accounts, not staff records                                      |

⚠️ **`contacts` are named individuals.** Every field above is personal data about a real person. PDC classifies 230 of its 282 base fields as `restricted` and 52 as `public` — ingest at PDC's declared sensitivity, and respect `details.mask_pii`.

---

## 4. Mappable now — programs and service delivery

The program catalog is the second-largest source of PDC-mappable content. Note the modelling caveat: **these are _offerings_, not funded proposals.** PDC's `proposal_*` vocabulary is the nearest available home, but nothing here was ever applied for or awarded. Agree this with the PDC data team before implementation — the same caveat raised for grantmakers.io award-side mappings.

### 4.1 `chicago.programs` (org-owned, year-scoped)

| Source                                                | PDC base field                                                  | Fit                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| `programs.name`                                       | `proposal_project_title`                                        | ✅ High                                                             |
| All programs for an org, rendered                     | `proposal_related_programs`                                     | ⭐ **High**                                                         |
| `programs.description`                                | `proposal_activities`, `proposal_summary` / `proposal_abstract` | ✅ High                                                             |
| `programs.discipline_id` → `chicago.disciplines.name` | `proposal_program_area`, `proposal_focus`                       | ✅ High                                                             |
| `programs.school_year_id`                             | `proposal_duration` / → `goodAsOf`                              | ⚠️ Low — a year label, not a duration                               |
| `program_grades.grade_id` → `public.grades.name`      | `proposal_age_group`                                            | ⭐ **High** — grade bands are the cleanest age signal in the schema |

### 4.2 Program allocations (`allocateable_type='Program'`)

Each resolves through `chicago.allocations` → the named lookup table.

| Allocated resource                            | PDC base field                                             | Fit                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `outcome_types` (`name`, `definition`)        | `proposal_anticipated_impact`, `proposal_project_outcomes` | ✅ High — these are _intended_ outcomes, not measured results; do **not** use `proposal_results` |
| `approaches` (`name`, `definition`)           | `proposal_tactics_and_methods`, `proposal_strategy`        | ✅ High                                                                                          |
| `identity_frequencies` (`name`, `definition`) | `proposal_demographics`, `proposal_equity`                 | ⚠️ Medium — inspect the vocabulary; see §8                                                       |
| `financial_assistance_types`                  | `proposal_funding_category`                                | ⚠️ Low — this is assistance offered _to participants_, not the funding type of a grant           |
| `program_types` (`public`)                    | `proposal_program_area`                                    | ✅ High                                                                                          |
| `sub_disciplines`                             | `proposal_focus`                                           | ✅ High                                                                                          |
| `languages`                                   | _(no target — see §7)_                                     | ❌ Languages of delivery                                                                         |
| `public.engagement_types`                     | `proposal_engagement`                                      | ⚠️ Medium — confirm the enum is about participant engagement                                     |

⚠️ Filter on `allocations.state` — an unapproved allocation for that school year should not be published.

### 4.3 Geography of service — via `partnerships`

| Source                                                | PDC base field                            | Fit               |
| ----------------------------------------------------- | ----------------------------------------- | ----------------- |
| `partnerships` → `schools` (names/locations served)   | `proposal_location_of_work`               | ✅ High           |
| `partnerships` → `schools` → `districts.name`         | `organization_geographic_area`            | ✅ High           |
| `schools.region`                                      | `organization_region`                     | ⚠️ Medium         |
| _(derived: all partner schools are in Cook County)_   | `proposal_all_counties_served_by_project` | ⚠️ Derived        |
| `districts` → `public.communities.name` (= "Chicago") | `organization_geographic_area`            | ✅ Tenant context |

⚠️ **Partner schools are identifiable institutions.** Publishing the full school list attached to an organization exposes the partnership graph. That is public in artlook's own map product, but it is a disclosure decision for PDC, not an automatic one.

---

## 5. Data-quality traps

1. **⚠️ The three `state` columns.** Per the companion doc's own "State field semantics" section:
   - `organizations.state` — portal **approval** (`approved` / `pending_approval`)
   - `details.state` — year-scoped **archive flag** (`approved` = active that year, `archived` = inactive)
   - `partnerships.state` — **partnership** approval
   - Also `contacts.state`, `employees.state`, `allocations.state`, `teaching_artists.state`, `school_years.state`

   `organization_status` is a **public** PDC field. Map it from `details.state` only. Mapping `organizations.state` publishes an internal moderation queue position as an organizational fact — the identical defect flagged in [`techsoup-okf-field-gap-analysis.md`](techsoup-okf-field-gap-analysis.md) §5.

2. **⚠️ `organizations.employees_count` is not a staff count.** Per the relationships tab, `employees` are "portal users employed by org" — it counts artlook accounts, not headcount. A three-person nonprofit with six logins and a forty-person nonprofit with one login both mislead. If `organization_paid_staff` is populated at all, label it as derived and caveat it; otherwise leave it empty.

3. **`organizations.partnerships_count` and `schools.*_count` are denormalized counters** maintained by the application. They are not facts about the organization and have no PDC target.

4. **Nullability is broad.** In `chicago.organizations`, only `id`, `name`, `state`, and the timestamps are `NOT NULL`. **`employer_identification_number`, `mission`, and `nickname` are all nullable** — the two fields the integration depends on most are optional. Measure actual fill rates before scoping.

5. **Type discipline.** PDC declares 7 `currency`, 5 `email`, 4 `date`, 1 `number`, 1 `phone_number`, and 8 `file` fields. Relevant here: `organization_fax` is `phone_number`; `organization_exec_admin_email` is `email`. `district_funding_cents` is **cents** — convert before any currency mapping.

6. **`goodAsOf` must come from the school year, not `updated_at`.** `updated_at` records when a row was last touched in the application; `school_year_id` records what period the value describes. A 2019 profile edited in 2026 is still a 2019 fact. Resolve `school_year_id` → `chicago.school_years.number` and derive `goodAsOf` from that, using `updated_at` only as batch metadata.

7. **No `pdc_share_data` value exists in the source.** PDC has that field (technical, restricted). Given §8, this feed needs an explicit consent determination rather than an absent one — and `details.restrict_access` / `details.mask_pii` are the organization's own stated preference and should inform it.

---

## 6. Structural decisions required before implementation

**A. One changemaker per organization, or one per organization-year?**
Every descriptive attribute is year-scoped. The natural PDC shape is **one changemaker, many values, each with a `goodAsOf` derived from its school year** — the same pattern recommended for grantmakers.io `financial_stats[]`. The alternative (one changemaker per org-year) would fragment identity and is not recommended.

**B. Do programs become proposals?**
artlook programs are service offerings with no application, amount, funder, or decision. Mapping them into `proposal_*` fields makes them _look_ like funded projects in PDC. Two options:

- **Conservative:** map the program catalog into `proposal_related_programs` and `organization_overview` only, and skip the rest of §4.
- **Full:** use the `proposal_*` vocabulary as mapped in §4, on the understanding that PDC consumers will read them as proposals.

**Recommendation: confirm with the PDC data team.** This is the single decision that most changes the shape of the output.

**C. Teaching artists are out of scope.**
`teaching_artists` are individuals who can be the partner entity on a partnership _instead of_ an organization. They are not changemakers and must not be ingested as such (§8). Any partnership whose partner is a TA rather than an org should be dropped from the org-side rollup.

---

## 7. Source content with no PDC target (new-base-field candidates)

This is the arts-education-specific material — the part of artlook that no other PDC source provides.

| Source content                                                                               | Why it doesn't fit                                                                                                                               | Suggested direction                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **Arts discipline taxonomy** — `disciplines`, `sub_disciplines`, `organization_disciplines`  | `organization_ntee_code` is the nearest structured concept but is a different taxonomy. A Discipline → NTEE `A*` crosswalk is possible but lossy | `organization_discipline`, or an NTEE derivation documented as derived |
| **`open_to_partnerships`**                                                                   | No availability/capacity field. The most actionable single fact in the schema for anyone seeking a partner                                       | `organization_open_to_partnership`                                     |
| **Outcome types** (`name` + `definition`)                                                    | Usable via `proposal_anticipated_impact` but loses the controlled vocabulary and its definitions                                                 | `organization_outcome_areas`                                           |
| **Approaches** (`name` + `definition`)                                                       | Same — a defined pedagogical vocabulary flattened into prose                                                                                     | `organization_approaches`                                              |
| **Identity frequencies**                                                                     | A defined equity/identity-representation vocabulary; `proposal_demographics` is free text                                                        | `organization_identity_representation`                                 |
| **Languages of delivery** (`languages`)                                                      | No language-served field anywhere in PDC                                                                                                         | `organization_languages_served`                                        |
| **Financial assistance types**                                                               | Assistance offered _to participants_ (sliding scale, scholarships); PDC's budget vocabulary is about the org's own finances                      | `organization_participant_financial_assistance`                        |
| **Badges** (`badge_questions`, `badge_relationships`)                                        | Org-level attestations/credentials with question text and icons                                                                                  | `organization_credentials`                                             |
| **`csc_rating`**                                                                             | No org-level rating field — **the same gap hit by Charity Navigator's Encompass score and grantmakers.io's `rank_giving`**                       | A general org-level score/rating family serving all three providers    |
| **School partnership graph** (`partnerships`, `partnership_matches`, `partnership_programs`) | `significant_other_funders` is about funders; nothing records a delivery-site or peer partner. Same gap identified in the TechSoup analysis      | `organization_partner_reference`                                       |
| **District vendor status** (`district_organizations.vendor_account`, `certified`, `active`)  | Procurement eligibility with a named public agency — genuinely useful for funders, no home in PDC                                                | `organization_public_agency_certification`                             |
| **Chicago civic geography** — `ward`, `congressional_district`, `community_area`             | `organization_neighborhood` absorbs `community_area`; ward and congressional district have no target                                             | `organization_civic_district`                                          |
| **District funding received** (`district_funding_cents`)                                     | Revenue from one named public source. `organization_total_revenue` would misstate it as a total                                                  | `organization_funding_by_source`, or a repeatable funder/amount pair   |
| **Survey completions** (`survey_attempts.feedback`)                                          | Partner survey responses; `review_*` is proposal review, not a survey                                                                            | Likely out of scope                                                    |
| **Grade bands** (`grades`, `program_grades`)                                                 | Mapped to `proposal_age_group` as prose, losing the structure                                                                                    | `organization_grade_levels_served`                                     |

---

## 8. Privacy and access cautions

The source is an operational application database, not a published dataset. It contains material that must never reach PDC.

1. **🚫 Never ingest `public.users`.** Columns include `encrypted_password`, `confirmation_token`, and `remember_token`. These are authentication secrets.

2. **🚫 Never ingest `public.sign_ins`.** `ip_address` per login event — access telemetry about identified individuals.

3. **🚫 Never ingest `chicago.teaching_artists` as changemakers.** These are individual people. The table holds `resume`, `portfolio`, `profile_pic`, `social_media`, `background_check_file`, `ideal_wage`, and `demographic_id`. A background-check reference and a wage expectation attached to a named individual are among the most sensitive fields in the entire schema. `show_phone_on_map` is that person's own visibility choice and is not a licence to republish elsewhere.

4. **⚠️ `details.mask_pii` and `details.restrict_access` are the organization's own stated preferences** and are `NOT NULL` on `restrict_access`. Both must be evaluated as ingest gates per organization per year, before any value is emitted. An organization that set `restrict_access` in artlook has not consented to broader publication.

5. **⚠️ `chicago.contacts` are named staff** — first name, last name, email, phone, title. Publishable in principle (artlook shows partner contacts), but ingest at PDC's declared sensitivity classification per field, not at the source's.

6. **⚠️ Inspect the `identity_frequencies` vocabulary before mapping it.** The table has `name`, `display_name`, and `definition`. If the values describe the identities of _participants served_, aggregate publication is normally fine; if they describe staff or leadership identity, treat them as demographic data about identifiable people at a small organization. Check before mapping to `proposal_demographics` / `proposal_equity`.

7. **⚠️ `public.demographics`** exists as a shared lookup and is referenced by `teaching_artists.demographic_id` — i.e. demographic data about **individuals**. Do not ingest.

8. **Consent posture.** Unlike IRS-derived sources, this is data organizations entered into a portal for a specific purpose (being discoverable by Chicago schools). Republication into PDC is a different purpose. `pdc_share_data` should carry an explicit determination, and the two suppression flags above should inform it.

---

## 9. Coverage impact

|                                      |       Fields | Share of 282 |
| ------------------------------------ | -----------: | -----------: |
| High-confidence (✅/⭐)              |          ~35 |        12.4% |
| Including medium/low-confidence (⚠️) |      **~50** |    **17.7%** |
| Requires new base fields (§7)        | ~15 concepts |            — |

By PDC category:

| Category       | Fields reachable | Comment                                                               |
| -------------- | ---------------: | --------------------------------------------------------------------- |
| `organization` |              ~30 | The core of the mapping — identity, address, contact, profile, status |
| `project`      |              ~12 | Program catalog, subject to decision §6B                              |
| `methodology`  |               ~4 | Approaches, equity, engagement                                        |
| `outcomes`     |               ~2 | Intended outcomes only                                                |
| `partnerships` |                1 | `significant_other_funders`, weakly                                   |
| `budget`       |               ~1 | Nearly empty — no financial data in the schema                        |
| `evaluation`   |                0 | No reviews, decisions, or determinations exist                        |

---

## 10. Recommended order of work

1. **Profile the data before scoping.** Measure fill rates for `employer_identification_number`, `mission`, `details.description`, `details.website`, and the address columns; and count organizations where `restrict_access` or `mask_pii` is set. The EIN fill rate in particular determines whether this is a join-ready feed or a name-matching problem.
2. **Settle decision §6B** (do programs become proposals?) with the PDC data team. It changes the output shape more than anything else here.
3. **Ship the organization core first** — §3.1 identity + §3.2 profile + §3.3 address. Roughly 25 fields, high confidence, one changemaker per `chicago.organizations` row keyed on EIN.
4. **Emit one value per school year with a `goodAsOf`** derived from `school_years.number`, not from `updated_at`. This is free given the schema and is what PDC's `valueRelevanceHours` is for.
5. **Apply the §8 gates in the extract query**, not downstream — `restrict_access`, `mask_pii`, `details.state = 'approved'`, `allocations.state` approved, and `*_type = 'Organization'` on every polymorphic join.
6. **Add the program catalog** (§4) once §6B is settled.
7. **Raise new base fields** (§7), prioritizing `open_to_partnerships` and the discipline taxonomy — the availability signal is the most actionable fact in the source, and the arts vocabulary is what makes this feed distinct.
8. **Coordinate the org-level rating gap** with [`charityNavigator-field-gap-analysis.md`](charityNavigator-field-gap-analysis.md) and [`grantmakersIO-field-mapping.md`](grantmakersIO-field-mapping.md) — `csc_rating`, Encompass score, and `rank_giving` are three providers hitting one missing PDC concept.

---

## 11. Verification notes

- PDC base field catalog retrieved by paginating `https://api.philanthropydatacommons.org/baseFields?_page=N&_count=100` (the `/base-fields-list/` page renders client-side from this endpoint and returns no field content to a plain fetch). **282 unique short codes** across 11 categories. dataType distribution: 256 `string`, 8 `file`, 7 `currency`, 5 `email`, 4 `date`, 1 `number`, 1 `phone_number`. Sensitivity: 230 `restricted`, 52 `public`.
- **All 71 PDC base fields named in this document were confirmed present in that catalog.**
- Source schema read from the workbook's two tabs: `columns` (696 rows incl. header → **695 columns across 78 tables**) and `relationships` (31 rows incl. header → **30 documented joins**). Column-level diff confirms `chicago.*` is a strict subset of `public.*`, with `public` carrying six additional lookup tables.
- `state`-field semantics, the allocation matrix, and the entity groupings are taken from the companion `chicago_partner_org_metadata.md`; the spreadsheet alone does not carry them.
- **Enum values are not in the export.** `details.governance`, `organizations.state`, `details.state`, `partnerships.state`, `organizations.creation_type`, and the contents of every lookup table (`disciplines`, `approaches`, `outcome_types`, `identity_frequencies`, `financial_assistance_types`, `languages`, `positions`, `grades`, `program_types`) are unknown from this source. Several ⚠️ ratings above would firm up given a values dump — that is the single most useful follow-up artifact.
