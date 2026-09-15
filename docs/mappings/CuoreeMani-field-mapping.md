# Cuoree Mani → PDC (summary)

> Abbreviated from [`CuoreeMani-field-mapping.verbose.md`](CuoreeMani-field-mapping.verbose.md).

## At a glance

| | |
|---|---|
| **Source** | Cuoree Mani — 13 supplied field names |
| **Grain** | Mixed: organization-level + grant/proposal-level in one list |
| **Mappable** | **11 of 13** to existing PDC base fields |
| **Gaps** | 2 (payment date + amount) — PDC has no payment concept |
| **Status** | Mapping only. No implementation |

## Mapping

| # | Source field | PDC base field | Category | Fit |
|---|---|---|---|---|
| 1 | Organization name | `organization_name` | organization | ✅ Exact |
| 2 | Tax id | `organization_tax_id` | organization | ✅ Exact |
| 3 | Address | `organization_street_address_1` (+ `_2` for line 2) | organization | ✅ Exact |
| 4 | City | `organization_city` | organization | ✅ Exact |
| 5 | State | `organization_state_province` | organization | ✅ Exact |
| 6 | Zip/Postal Code | `organization_postal_code` | organization | ✅ Exact |
| 7 | Last Payment Date | ❌ **no equivalent** — nearest `review_grant_agreement_date` | evaluation | ❌ Gap |
| 8 | Last Payment Amount | ❌ **no equivalent** — nearest `review_amount_recommended` | evaluation | ❌ Gap |
| 9 | Project name (or gen op) | `proposal_project_title` (name) **+** `proposal_funding_category` (gen-op flag) | project | ⚠️ Split |
| 10 | Grant type | `proposal_type` | project | ✅ Close |
| 11 | Special populations | `proposal_demographics` | project | ✅ Close |
| 12 | Geographic area served | `organization_geographic_area` (org) **or** `proposal_location_of_work` (project) | org / project | ⚠️ Pick scope |
| 13 | Current Fiscal Year Budget | `organization_operating_budget` (pair with `organization_fiscal_year`) | organization | ✅ Close |

All targets are `string` type.

## Gotchas

- **Rows 7–8 are a real gap.** PDC's award vocabulary stops at what was *recommended* in review — there is no payment/disbursement concept. The nearest fields mean something different; mapping into them would misstate the data. New-base-field candidates: `grant_last_payment_date`, `grant_last_payment_amount`.
- **Row 9 is two facts in one column.** Name → `proposal_project_title`; general-operating vs. project-restricted → `proposal_funding_category`. `proposal_name` overlaps with `proposal_project_title` in PDC — confirm which the target consumer reads.
- **Row 12 needs a scope decision.** `organization_geographic_area` = where the org works generally; `proposal_location_of_work` (and `proposal_all_counties_served_by_project`) = where a funded project works.
