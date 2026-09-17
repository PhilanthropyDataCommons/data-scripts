# Charity Navigator → PDC Field Gap Analysis

**Subject:** [`src/charityNavigator.ts`](src/charityNavigator.ts) field mapping (`baseFieldMap`)
**Question:** Which Charity Navigator fields are _not_ being loaded into PDC, and can any of them be mapped to existing PDC base fields going forward?
**PDC field catalog source:** live query of `https://api.philanthropydatacommons.org/baseFields` (the same API that backs [philanthropydatacommons.org/base-fields-list](https://philanthropydatacommons.org/base-fields-list/)) — **282 base fields** total, retrieved 2026-08-19.
**Generated:** 2026-08-19

---

## 1. Executive Summary

- The script currently maps **4 of the ~12 fields** it requests from Charity Navigator into PDC.
- Of the **6 fetched-but-unmapped fields** (`encompassScore`, `encompassStarRating`, `encompassRatingId`, `encompassPublicationDate`, `size`, `cause`), **none map cleanly to an existing PDC base field** — PDC has no organization-level rating, score, size, or cause/sector field today. Importing them would require **new PDC base fields** to be created first.
- The **larger, actionable opportunity is in fields the query does _not_ currently request.** Charity Navigator's public nonprofit type also exposes a **structured postal address** (street, city, state, zip, country) and, on the Premier tier, likely **financial totals**. PDC already has empty, ready-to-fill base fields for both — these are the recommended additions.
- ⚠️ **One verification step is required:** the exact fields available on the API's `NonprofitPublic` type should be confirmed by GraphQL introspection with the API key before extending the query (see §6).

---

## 2. What is mapped today

From `baseFieldMap` in [`src/charityNavigator.ts:44`](src/charityNavigator.ts):

| Charity Navigator attribute | PDC base field short code        | PDC category |
| --------------------------- | -------------------------------- | ------------ |
| `name`                      | `organization_name`              | organization |
| `website`                   | `organization_website`           | organization |
| `phone`                     | `organization_phone`             | organization |
| `mission`                   | `organization_mission_statement` | organization |

Plus two fields used but not stored: `ein` (join key) and `updatedAt` (written as each value's `goodAsOf`).

---

## 3. Fetched but NOT mapped — evaluated against PDC

These fields are already requested by the `NonprofitsPublic` GraphQL query ([`src/charityNavigator.ts:74`](src/charityNavigator.ts)) but are dropped before writing to PDC.

| CN attribute               | What it is                                    | Closest PDC field(s)                                                                                                                                                                        | Mappable today?           |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `encompassScore`           | Encompass numeric rating (0–100)              | _none_ — `review_average_score` / `review_total_score` exist but are **evaluation-category, proposal-review** fields, not org ratings                                                       | ❌ No org-level target    |
| `encompassStarRating`      | Star rating (0–4)                             | _none_                                                                                                                                                                                      | ❌ No org-level target    |
| `encompassRatingId`        | Internal CN rating identifier                 | _none_                                                                                                                                                                                      | ❌ Internal ID, low value |
| `encompassPublicationDate` | Date the rating was published                 | _none_ (only meaningful alongside a rating field)                                                                                                                                           | ❌ No target              |
| `size`                     | CN size bucket (revenue-based band)           | loosely `organization_operating_budget` — but that is a value, not a band                                                                                                                   | ❌ Semantics don't match  |
| `cause`                    | Human-readable cause/category (e.g. "Health") | `organization_ntee_code` is the nearest structured concept, but it is a _code_ (and is already filled by GivingTuesday); no `organization_cause`/`sector`/`focus` field exists at org level | ❌ No clean target        |

**Conclusion:** None of the six can be mapped to an existing PDC base field. The Encompass rating trio (`encompassScore` + `encompassStarRating` + `encompassPublicationDate`) is the most valuable content Charity Navigator uniquely provides, but **PDC currently has nowhere to put it.** To capture it, the team would need to request new base fields — suggested short codes below:

- `organization_charity_navigator_score` (number)
- `organization_charity_navigator_star_rating` (number)
- `organization_charity_navigator_rating_date` (date) — or simply use the value's `goodAsOf`

(`encompassRatingId` and `cause`/`size` are lower priority; `size` and `cause` overlap with data PDC already derives from IRS/NTEE sources.)

---

## 4. NOT fetched by the query — the real mapping opportunity

Charity Navigator's public nonprofit type exposes more than the 12 fields the current query selects. Per Charity Navigator's own [`cn-examples`](https://github.com/CharityNavigator/cn-examples) query samples, the public nonprofit object also includes a **structured address** and organization URLs. These have **ready, currently-empty PDC targets**:

| CN attribute (available, not queried) | Recommended PDC base field                                        | PDC data type | Notes                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `street` / `street2`                  | `organization_street_address_1` / `organization_street_address_2` | string        | PDC's general org address (distinct from the IRS address that GivingTuesday fills via `organization_irs_address`) |
| `city`                                | `organization_city`                                               | string        |                                                                                                                   |
| `state`                               | `organization_state_province`                                     | string        |                                                                                                                   |
| `zip`                                 | `organization_postal_code`                                        | string        |                                                                                                                   |
| `country`                             | `organization_country`                                            | string        |                                                                                                                   |

> **No collision with GivingTuesday.** GivingTuesday populates the `organization_irs_*` address family; the fields above are the _general_ organization-address family, which is currently unfilled. The two coexist by design.

### Premier-tier financials (needs schema confirmation — see §6)

PDC has a full set of empty **budget-category** fields ready to receive nonprofit financials. If the Premier `NonprofitPublic` type (or a related type) exposes 990-derived totals, these are direct one-to-one targets:

| Financial concept | PDC base field                   | PDC data type |
| ----------------- | -------------------------------- | ------------- |
| Total revenue     | `organization_total_revenue`     | currency      |
| Total expenses    | `organization_total_expenses`    | currency      |
| Total assets      | `organization_total_assets`      | currency      |
| Net assets        | `organization_net_assets`        | currency      |
| Net income        | `organization_net_income`        | currency      |
| Total liabilities | `organization_total_liabilities` | currency      |
| Grants paid       | `organization_grants_paid`       | currency      |

I could not confirm from public documentation that CN's _public_ type exposes these financial fields (they were not present in the public query samples). This is the one item that must be verified against the live schema before mapping.

### Low-value / no-target extras

- `charity_navigator_url` — no PDC field; skip.
- `organization_url` — duplicates `website` → `organization_website` (already mapped).
- `highest_level_alert` / advisories — no PDC org field; skip.
- `ein` — could optionally be written to `organization_tax_id`, but it is redundant with the changemaker's own `taxId`. Optional.

---

## 5. Recommended changes to `baseFieldMap`

**Phase 1 — no schema risk, high value (add address fields):**

First extend the GraphQL query in `QueryNonprofitsPublic` to select `street`, `street2`, `city`, `state`, `zip`, `country` (confirm exact field names — see §6), add them to the `NonprofitPublic` interface, then extend `baseFieldMap`:

```ts
const baseFieldMap: Array<[keyof NonprofitPublic, string]> = [
  ['name', 'organization_name'],
  ['website', 'organization_website'],
  ['phone', 'organization_phone'],
  ['mission', 'organization_mission_statement'],
  // Phase 1 additions — general organization postal address:
  ['street', 'organization_street_address_1'],
  ['street2', 'organization_street_address_2'],
  ['city', 'organization_city'],
  ['state', 'organization_state_province'],
  ['zip', 'organization_postal_code'],
  ['country', 'organization_country'],
];
```

**Phase 2 — after confirming Premier schema (add financials):** map any exposed revenue/expenses/assets fields to the `organization_total_*` / `organization_net_*` budget fields above.

**Phase 3 — requires PDC governance (new base fields):** propose `organization_charity_navigator_score` / `_star_rating` / `_rating_date`, then map `encompassScore` / `encompassStarRating` / `encompassPublicationDate`. This is the only way to capture Charity Navigator's signature rating data.

> Note: the existing `updateAll` loop already handles any new mapping entry automatically — it iterates `baseFieldMap` and skips null/undefined values — so once a field is in the interface, the query, and the map, no other code changes are needed.

---

## 6. Important caveat — verify the live schema first

There is a naming mismatch worth resolving before writing code:

- The **codebase** query uses a `NonprofitPublic` type with **camelCase** fields (`encompassScore`, `website`, `phone`, `size`, `cause`).
- Charity Navigator's public **`cn-examples`** use **snake_case** fields (`encompass_score`, `street`, `causes`) on `publicSearchFaceted` / `bulkNonprofits` queries.

These are different query shapes, so the exact field names available on the `nonprofitsPublic` edge type used here must be confirmed by **GraphQL introspection** (the API key is already required by the script). Recommended one-time check:

```bash
# with the CN API key, introspect the NonprofitPublic type:
# query { __type(name: "NonprofitPublic") { fields { name type { name kind ofType { name } } } } }
```

That single introspection query will definitively answer (a) the exact address field names, and (b) whether financial totals are exposed on this tier — resolving both open items in §4.

---

## 7. Bottom line

| Category                                         | Count                    | Action                                                                                         |
| ------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------- |
| Currently mapped                                 | 4                        | —                                                                                              |
| Fetched but unmapped, **no PDC target**          | 6                        | Request new PDC base fields for the Encompass rating (score/star/date); the rest are low value |
| **Available in CN, unmapped, PDC target EXISTS** | ~6 address fields        | **Add to query + `baseFieldMap` (Phase 1) — recommended**                                      |
| Available on Premier tier, PDC target exists     | up to 7 financial fields | Verify schema, then map (Phase 2)                                                              |

The single highest-value, lowest-risk change is **importing Charity Navigator's structured address into the existing (empty) PDC organization-address fields.** The Encompass ratings are Charity Navigator's most distinctive data but cannot be stored until PDC adds matching base fields.
