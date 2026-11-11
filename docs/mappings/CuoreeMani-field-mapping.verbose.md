# Field Mapping → PDC Base Fields

**PDC field catalog source:** live query of `https://api.philanthropydatacommons.org/baseFields` (the API that backs [philanthropydatacommons.org/base-fields-list](https://philanthropydatacommons.org/base-fields-list/)) — 282 base fields
**Generated:** 2026-08-31

| #   | Source field               | PDC base field                                                                                | Category               | Type   | Fit           |
| --- | -------------------------- | --------------------------------------------------------------------------------------------- | ---------------------- | ------ | ------------- |
| 1   | Organization name          | `organization_name`                                                                           | organization           | string | ✅ Exact      |
| 2   | Tax id                     | `organization_tax_id`                                                                         | organization           | string | ✅ Exact      |
| 3   | Address                    | `organization_street_address_1`<br>(+ `organization_street_address_2` for line 2)             | organization           | string | ✅ Exact      |
| 4   | City                       | `organization_city`                                                                           | organization           | string | ✅ Exact      |
| 5   | State                      | `organization_state_province`                                                                 | organization           | string | ✅ Exact      |
| 6   | Zip/Postal Code            | `organization_postal_code`                                                                    | organization           | string | ✅ Exact      |
| 7   | Last Payment Date          | _no direct equivalent_ — nearest `review_grant_agreement_date`                                | evaluation             | string | ❌ Gap        |
| 8   | Last Payment Amount        | _no direct equivalent_ — nearest `review_amount_recommended`                                  | evaluation             | string | ❌ Gap        |
| 9   | Project name (or gen op)   | `proposal_project_title` (name)<br>+ `proposal_funding_category` (the "gen op" designation)   | project                | string | ⚠️ Split      |
| 10  | Grant type                 | `proposal_type`                                                                               | project                | string | ✅ Close      |
| 11  | Special populations        | `proposal_demographics`                                                                       | project                | string | ✅ Close      |
| 12  | Geographic area served     | `organization_geographic_area` (org-level)<br>or `proposal_location_of_work` (project-level)  | organization / project | string | ⚠️ Pick scope |
| 13  | Current Fiscal Year Budget | `organization_operating_budget`<br>(pair with `organization_fiscal_year` to state which year) | organization           | string | ✅ Close      |

---

## Notes on the non-exact rows

**Rows 7–8 are a real gap.** PDC has no payment or disbursement concept — its award-side vocabulary stops at what was _recommended_ in review, not what was _paid_. `review_amount_recommended` and `review_grant_agreement_date` are the closest fields but mean something different, so mapping into them would misstate the data. These are new-base-field candidates (e.g. `grant_last_payment_date`, `grant_last_payment_amount`).

**Row 9 splits in two.** "Project name or gen op" is one column carrying two facts. `proposal_project_title` holds the name; general-operating vs. project-restricted belongs in `proposal_funding_category`. `proposal_name` also exists and is a reasonable alternative to `proposal_project_title` — the two overlap in PDC, so confirm which one the target consumer reads.

**Row 12 needs a scope decision.** `organization_geographic_area` is where the organization works generally; `proposal_location_of_work` (and `proposal_all_counties_served_by_project`) is where a specific funded project works. If the source column describes the organization, use the first.
