# Charity Navigator → PDC (summary)

> Abbreviated from [`charityNavigator-field-gap-analysis.verbose.md`](charityNavigator-field-gap-analysis.verbose.md). Read that for rationale, code samples, and full reasoning.

## At a glance

| | |
|---|---|
| **Source** | Charity Navigator GraphQL API (`NonprofitsPublic`) |
| **Implementation** | [`src/charityNavigator.ts`](../../src/charityNavigator.ts) — `baseFieldMap` |
| **Join key** | `ein` · freshness from `updatedAt` → `goodAsOf` |
| **Status** | Live. Maps **4** fields; ~6 more are available and have ready PDC targets |
| **Blocker** | Exact CN field names need GraphQL introspection before extending the query |

## Mapped today (4)

| CN attribute | PDC base field |
|---|---|
| `name` | `organization_name` |
| `website` | `organization_website` |
| `phone` | `organization_phone` |
| `mission` | `organization_mission_statement` |

`ein` and `updatedAt` are used but not stored as values.

## Phase 1 — add now (target exists, currently empty)

Requires adding these to the GraphQL query + interface + `baseFieldMap`. No PDC schema change.

| CN attribute | PDC base field |
|---|---|
| `street` | `organization_street_address_1` |
| `street2` | `organization_street_address_2` |
| `city` | `organization_city` |
| `state` | `organization_state_province` |
| `zip` | `organization_postal_code` |
| `country` | `organization_country` |

⚠️ **No collision with GivingTuesday** — GT fills the `organization_irs_*` address family; this is the *general* org address family, which is unfilled. They coexist by design.

## Phase 2 — Premier-tier financials (verify schema first)

If exposed on the tier, these are one-to-one `currency` targets: `organization_total_revenue`, `organization_total_expenses`, `organization_total_assets`, `organization_net_assets`, `organization_net_income`, `organization_total_liabilities`, `organization_grants_paid`.

## Fetched but NOT mappable — no PDC target (6)

| CN attribute | Why it can't land |
|---|---|
| `encompassScore` | No org-level score field. `review_*_score` is proposal-review, not org rating |
| `encompassStarRating` | No target |
| `encompassPublicationDate` | No target (only meaningful with a rating field) |
| `encompassRatingId` | Internal ID, low value |
| `size` | Revenue *band*, not a value — `organization_operating_budget` semantics don't match |
| `cause` | Text category; nearest is `organization_ntee_code` (a code, already filled by GivingTuesday) |

**New base fields needed** to capture CN's signature data: `organization_charity_navigator_score`, `_star_rating`, `_rating_date`.

## Gotchas

- **Field-name mismatch is unresolved.** The codebase uses camelCase (`encompassScore`) on `NonprofitPublic`; CN's public examples use snake_case (`encompass_score`) on different query shapes. Introspect before coding.
- `updateAll` iterates `baseFieldMap` and skips null/undefined — **adding a map entry needs no other code changes** once the field is in the query and interface.
- `charity_navigator_url`, `organization_url`, advisories/alerts → skip (no target or duplicate).

## Next steps

1. Run one GraphQL introspection on `NonprofitPublic` — resolves both the address field names and whether financials are exposed.
2. Ship Phase 1 (address). Lowest risk, highest value.
3. Ship Phase 2 if financials are on the tier.
4. Raise the Encompass rating base fields with PDC governance — coordinate with the same ranking/score gap in [`grantmakersIO-field-mapping.md`](grantmakersIO-field-mapping.md).
