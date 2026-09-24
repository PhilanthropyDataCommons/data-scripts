# Chicago Partner Organizations (artlook) → PDC (summary)

> Abbreviated from [`chicago_partner_org-field-mapping.verbose.md`](chicago_partner_org-field-mapping.verbose.md). Read that for per-column fit grades, nullability, and full reasoning.

## At a glance

|                        |                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| **Source**             | artlook Chicago — arts-education partner portal (Rails/Postgres, multi-tenant)            |
| **Schema doc**         | `C:\Data\Parliament\chicago_partner_org_metadata.xlsx` — `columns` + `relationships` tabs |
| **Size**               | 78 tables / 695 columns across two schemas                                                |
| **Changemaker entity** | `chicago.organizations`                                                                   |
| **Temporal grain**     | School year (`school_year_id`) — on almost every table                                    |
| **Mappable**           | **~50 of 282** (17.7%); ~35 high-confidence                                               |
| **Status**             | Analysis only. Not implemented                                                            |

**⭐ EIN is present** (`organizations.employer_identification_number`) → direct `organization_tax_id` join. Nullable — measure fill rate first.

**This is a partner directory, not a grants system.** No proposals, no awards, no amounts. PDC's `evaluation` category comes out empty and `budget` nearly so.

## 🚩 Read first

1. **`chicago.*` is a strict subset of `public.*`.** `public` is the multi-tenancy _template_, not Chicago data. Read entities from `chicago.*`, shared lookups (`users`, `positions`, `grades`, `program_types`, `communities`) from `public.*`. **Ingesting both duplicates every changemaker.**
2. **Joins are polymorphic, not FK.** `detailable` / `addressable` / `contactable` / `employable` / `allocateable` / `badgeable` / `surveyable`. Every org query needs `*_type = 'Organization'`.
3. **Three columns named `state`, three meanings.** `organizations.state` = portal approval · `details.state` = year active/archived · `partnerships.state` = partnership approval. **Use `details.state` for `organization_status`** — mapping `organizations.state` repeats the TechSoup defect (publishing a workflow state as an org fact).
4. **The DB holds credentials and individuals.** See Privacy gates below.

---

## Mapping — organization core

### `chicago.organizations`

| Source                                            | PDC base field                                                   | Fit                                    |
| ------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| `employer_identification_number`                  | `organization_tax_id`                                            | ⭐ join key (nullable)                 |
| `name`                                            | `organization_name` (+ `organization_legal_name`)                | ✅                                     |
| `nickname`                                        | `organization_dba_name` **or** `organization_acronym` — pick one | ✅                                     |
| `mission`                                         | `organization_mission_statement`                                 | ⭐                                     |
| `id` / `sql_identifier`                           | `organization_id` (external ref)                                 | ➖                                     |
| `state`                                           | 🚫 **not** `organization_status` — portal approval               | ❌                                     |
| `employees_count`                                 | `organization_paid_staff`                                        | ⚠️ **counts portal logins, not staff** |
| `open_to_partnerships`                            | ❌ no target — highest-value missing signal                      |                                        |
| `partnerships_count`, `creation_type`, `imported` | counters / provenance only                                       | ➖                                     |

### `chicago.details` — year-scoped profile (`detailable_type='Organization'`)

Carries most of the publishable content.

| Source                                                                                                                       | PDC base field                                                                 | Fit                                                         |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `description`                                                                                                                | `organization_overview`                                                        | ⭐                                                          |
| `website`                                                                                                                    | `organization_website`                                                         | ⭐                                                          |
| `phone` / `fax`                                                                                                              | `organization_phone` / `organization_fax` (`phone_number` type)                | ✅                                                          |
| `state`                                                                                                                      | `organization_status` ⭐ **correct source** (`approved`=active yr, `archived`) | ✅                                                          |
| `school_year_id`                                                                                                             | → `goodAsOf` via `school_years.number`                                         | ⭐                                                          |
| `governance`                                                                                                                 | `organization_governing_body_type` **or** `organization_entity_type`           | ⚠️ enum unknown                                             |
| `district_funding_cents` (+`_currency`)                                                                                      | `significant_other_funders`                                                    | ⚠️ one stream, **not** total revenue; value is in **cents** |
| `csc_rating`                                                                                                                 | ❌ no org-level rating field in PDC                                            |                                                             |
| `mask_pii`, `restrict_access`                                                                                                | 🚫 **ingest gates, not values**                                                |                                                             |
| `nces_identifier`, `state_board_identifier`, `billing_account`, `schedule_url`, `services_route`, `professional_development` | ❌ no target                                                                   |                                                             |

### `chicago.addresses` (`addressable_type='Organization'`, 1:1)

| Source                              | PDC base field                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `street` / `city` / `state` / `zip` | `organization_street_address_1` / `_city` / `_state_province` / `_postal_code` (all `NOT NULL`) |
| `latitude` / `longitude`            | `organization_latitude_epsg_4326` / `_longitude_epsg_4326`                                      |
| `community_area`                    | `organization_neighborhood` ⭐ Chicago's 77 community areas                                     |
| _(constant)_                        | `organization_country` = `US`; `organization_county` = `Cook` ⚠️ verify                         |
| `network_id` → `networks.name`      | `organization_unit` ⚠️                                                                          |
| `ward`, `congressional_district`    | ❌ no target                                                                                    |

⚠️ **No `street2` and no `country` column** — `organization_street_address_2` stays empty; country must be asserted.

### `chicago.contacts` / `employees` — ⚠️ named individuals

`first_name`/`last_name`/`email` (where `primary=true`) → `organization_exec_admin_first_name`/`_last_name`/`_email` · shared email → `organization_email` · `position_id`→`public.positions.name` → `organization_executive_administrator_title` (prefer over free-text `title`) · rendered list → `organization_leadership`.

---

## Mapping — programs (⚠️ decision required)

**These are service offerings, not funded proposals.** Nothing here was applied for or awarded. Using `proposal_*` makes them read as funded projects in PDC. **Confirm with the PDC data team before building.**

| Source                                  | PDC base field                                                  |
| --------------------------------------- | --------------------------------------------------------------- |
| all `programs` for an org               | `proposal_related_programs` ⭐                                  |
| `programs.name`                         | `proposal_project_title`                                        |
| `programs.description`                  | `proposal_activities`, `proposal_summary` / `proposal_abstract` |
| `discipline_id` → `disciplines.name`    | `proposal_program_area`, `proposal_focus`                       |
| `program_grades` → `public.grades.name` | `proposal_age_group` ⭐ cleanest age signal in the schema       |

**Program allocations** (`allocations` where `allocateable_type='Program'`, filter `allocations.state`):

| Resource                            | PDC base field                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `outcome_types`                     | `proposal_anticipated_impact`, `proposal_project_outcomes` — _intended_, so **not** `proposal_results` |
| `approaches`                        | `proposal_tactics_and_methods`, `proposal_strategy`                                                    |
| `identity_frequencies`              | `proposal_demographics`, `proposal_equity` ⚠️ inspect vocabulary first                                 |
| `program_types` / `sub_disciplines` | `proposal_program_area` / `proposal_focus`                                                             |
| `financial_assistance_types`        | `proposal_funding_category` ⚠️ assistance to _participants_                                            |
| `languages`                         | ❌ no target                                                                                           |

**Geography via partnerships:** partner schools → `proposal_location_of_work` · districts → `organization_geographic_area` · `schools.region` → `organization_region`.

---

## 🚫 Privacy gates — apply in the extract query

| Never ingest               | Why                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `public.users`             | `encrypted_password`, `confirmation_token`, `remember_token` — auth secrets                                                             |
| `public.sign_ins`          | `ip_address` per login — access telemetry on identified people                                                                          |
| `chicago.teaching_artists` | Individuals. Holds `resume`, `portfolio`, `background_check_file`, `ideal_wage`, `demographic_id`, `social_media`. **Not changemakers** |
| `public.demographics`      | Demographic data about individuals (via `teaching_artists.demographic_id`)                                                              |

**Gate every org-year on `details.restrict_access` and `details.mask_pii`** — these are the organization's own stated preferences, set in artlook. `contacts` are named staff; ingest at PDC's declared sensitivity (230 of 282 fields are `restricted`), not the source's. This is portal data entered to be discoverable by Chicago schools — republication to PDC is a different purpose, so `pdc_share_data` needs an explicit determination.

## Gotchas

- **`goodAsOf` from the school year, not `updated_at`.** A 2019 profile edited in 2026 is still a 2019 fact. Use `school_years.number`; keep `updated_at` as batch metadata.
- **Nullability is broad.** Only `id`, `name`, `state`, timestamps are `NOT NULL` on `organizations`. EIN, mission, and nickname are all optional — the two fields the integration leans on most.
- **`district_funding_cents` is in cents.** Convert before any currency mapping.
- **Denormalized counters** (`partnerships_count`, `employees_count`, `courses_count`) are app-maintained, not facts about the org.
- **Enum values are absent from the export** — `governance`, all `state` columns, `creation_type`, and every lookup table's contents. A values dump is the most useful follow-up artifact; several ⚠️ ratings would firm up.
- **Teaching artists can be the partner** on a partnership instead of an org — drop those from any org-side rollup.

## No PDC target — new base field candidates

`organization_open_to_partnership` (from `open_to_partnerships` — the most actionable fact in the schema) · `organization_discipline` (arts taxonomy; NTEE `A*` crosswalk possible but lossy) · `organization_outcome_areas` · `organization_approaches` · `organization_identity_representation` · `organization_languages_served` · `organization_participant_financial_assistance` · `organization_credentials` (badges) · `organization_partner_reference` (school partnership graph) · `organization_public_agency_certification` (district vendor status) · `organization_civic_district` (ward, congressional district) · `organization_funding_by_source` · `organization_grade_levels_served`.

⭐ **`csc_rating` hits the same missing PDC concept** as Charity Navigator's Encompass score and grantmakers.io's `rank_giving` — three providers, one org-level rating gap.

## Coverage

| Category                  |                              Reachable |
| ------------------------- | -------------------------------------: |
| `organization`            |                                    ~30 |
| `project`                 | ~12 (subject to the programs decision) |
| `methodology`             |                                     ~4 |
| `outcomes`                |                                     ~2 |
| `partnerships` / `budget` |                                ~1 each |
| `evaluation`              |                                      0 |

## Next steps

1. **Profile before scoping** — fill rates for EIN, `mission`, `details.description`/`website`/address; count orgs with `restrict_access` or `mask_pii` set.
2. **Settle: do programs become proposals?** Changes the output shape more than anything else.
3. **Ship the organization core** (~25 fields, high confidence) keyed on EIN.
4. **Emit one value per school year** with `goodAsOf` — free given the schema.
5. **Apply privacy gates in the extract query**, not downstream.
6. **Add the program catalog** once step 2 is settled.
7. **Raise new base fields**, prioritizing `open_to_partnerships` and the discipline taxonomy.
8. **Coordinate the rating gap** with [`charityNavigator-field-gap-analysis.md`](charityNavigator-field-gap-analysis.md) and [`grantmakersIO-field-mapping.md`](grantmakersIO-field-mapping.md).
