# Cinch Portal — Widget Reference

Every widget in `app/portal-v2/page.js`: which SiteLink report it's sourced from, which columns/fields feed it, the exact formula, and the live value our portal is currently returning. Generated 3 Jul 2026 from the current codebase (`lib/reportMap.js`, `lib/buildPayload.js`, `app/portal-v2/page.js`) and the most recent `npm run pull` output you've pasted (2026-07 pull, portfolio totals + per-site reconciliation table).

Legend — **Scope**: `current` = in-progress current month (point-in-time snapshot); `prev` = last complete calendar month (flow/count metric); `portfolio` = sum-then-divide across all live sites, never an average of per-site percentages.

**"Our Portal (Live)" column**: actual values from your last pasted pull, where available. Cells marked *"not captured in last output"* weren't printed by that specific run — run `npm run kpis` (dumps every KPI to the terminal) or paste the next `npm run pull` and I'll fill them in. Cells marked **"stale — pre-fix"** were computed before the 3 Jul 2026 Ancillaries month-scoping fix and need a fresh pull to be trustworthy.

---

## Dashboard

| Widget | Type | SiteLink report(s) | Columns used | Formula | Scope | Our Portal (Live) |
|---|---|---|---|---|---|---|
| Occupancy (% of CLA) | KPI tile | OccupancyStatistics | occupied_area, cla_area | Σ occA ÷ Σ claA × 100 | current | **65.9%** |
| Occupied Units | KPI tile | OccupancyStatistics | occupied_units, total_units | Σ occ (of Σ tot) | current | **8,411 of 13,329** |
| Portfolio Occupancy (table) | Table | OccupancyStatistics, RentRoll | occ, tot, occPC, areaPC, rent | per site: occ/tot; % of CLA = occA/claA; Rent Roll = Σ dcRent | current | Portfolio row: 8,411/13,329, 63.1% occ, 65.9% CLA, £1,262,860 rent. Per-site e.g. Bicester 90.2% occ / £51,953 rent, Wisbech 24.5% occ / £16,797 rent |
| Rates per ft² (All Stores) | Table | RentRoll | rent_sum, area_sum, std_rent_sum, self_storage sums | SS Rate = Σrent(SS)÷Σarea(SS)×12; Total Rate = Σrent(all)÷Σarea(all)×12; Real Rate variants use dcStandardRate | current | Portfolio row: SS £23.96, Total £22.99, SS Real £25.65, Total Real £24.93, Occupied Area 650,198 ft². Per-site e.g. Bicester SS £27.75/Total £26.73, Mitcham SS £33.87/Total £33.86 |
| Move-ins & Move-outs | Stat card | ManagementSummary, MoveInsAndMoveOuts | move_ins, move_outs, net_area | Σ moveIns / Σ moveOuts / net ft² | **prev** | *not captured in last output* |
| Enquiries | Stat card | InquiryTracking | sRentalType, sInquiryType | Filtered to Inquiry-stage rows, counted by channel | **prev** | *not captured in last output* |
| Rented Area / SS Rate / % of CLA by Store (charts) | Chart | OccupancyStatistics, RentRoll | occA, ssRate, areaPC | per-site values, bar chart | current | per-site, see reconciliation table (27 rows, Bicester highest occ at 90.2%, Wisbech lowest at 24.5%) |
| Custom widgets | Chart | any (user-selected) | 2-4 user-selected fields | user-defined | per-field | n/a (per-widget, user-created) |

---

## KPIs

| Widget | Type | SiteLink report(s) | Columns used | Formula | Scope | Our Portal (Live) |
|---|---|---|---|---|---|---|
| Total Store Occupancy | Stat card | OccupancyStatistics, RentRoll | occ, tot, rent_sum, area_sum | Occupancy = Σocc/Σtot; Rate = Σrent÷Σarea×12 | current | **63.1% occupancy, £22.99/ft², 8,411/13,329 units** |
| Indoor Self Storage | Stat card | OccupancyStatistics, RentRoll (SS) | ss.occ, ss.tot, ss rent/area sums | Same, Self Storage only | current | **62.8% occupancy, £23.96/ft²** (7,757/12,356 units) |
| Offices Occupancy | Stat card | OccupancyStatistics, RentRoll (Office) | offices.occ, offices.tot, offices rent/area sums | Same, Office only | current | **75.4% occupancy, £33.72/ft²** (89/118 units) |
| Scheduled Reservations vs Scheduled Move-outs | Stat card | ReservationList, ScheduledMoveOuts, RentRoll | active_tenant_ids, scheduled_move_outs | Reservations = activeReservations (ReservationList rows not already an occupied tenant); Move-outs = ScheduledMoveOuts; Net = difference | live, always "right now" (ignores date-range picker by design) | **SWITCHED BACK 7 Jul 2026**: 438 reservations, 267 move-outs, net +171. Briefly rebuilt 6 Jul as a historical monthly-flow metric (reservationsMade/moveOuts, 571/154/+417) but switched back after confirming (a) legacy's own equivalent widget is also permanently live-only — ignores its date picker too, so a historical version on our side was never going to be comparable — and (b) the old ~3x overcount (Task #25, was 1,420/285/+1,135 vs a ~446 target) is already fixed by activeReservations' occupied-tenant-ID filter; 438 is right in range. The historical reservationsMade/moveOuts fields are still computed and available (custom widget builder) but no longer power this KPI card. |
| Debtor Levels | Stat card | PastDueBalances, OccupancyStatistics | accounts_overdue_30plus, total_overdue_30plus | % Tenants = accounts(30+)÷occ; % Rent Roll = £(30+)÷actual occupied rent; Total = Σ£ | current | **0.7% tenants, 2.4% rent roll, £30,616 total** |
| Move-ins & Move-outs (KPIs copy) | Stat card | ManagementSummary, MoveInsAndMoveOuts | same as Dashboard | same | **prev** | *not captured in last output* |
| Autobill Conversion | Stat card | MoveInsAndMoveOuts, RentRoll | move_in_tenant_ids, autobill_tenant_ids | New autobilled ÷ new customers | **prev** | **81.4%** — **stale, pre-fix** (this pull ran before the 3 Jul month-scoping fix; rerun `npm run pull` to get a trustworthy number) |
| Customer Churn | Stat card | ManagementSummary, OccupancyStatistics (12mo) | history moveOuts/occ | Trailing-12mo moveOuts ÷ avg occ | trailing 12mo | mock **78.88%** — real calc waiting on your 12-month backfill |
| Units by Customer Type | Chart | RentRoll | customerType.{business,residential}.units | % split of occupied units | current | **Business 14.7% (1,253 units), Residential 85.3% (7,267 units)** |
| Rate per ft² by Customer Type | Chart | RentRoll | customerType.{business,residential}.{area,rent} | Σrent÷Σarea×12 per segment | current | **Business £21.83/ft², Residential £23.36/ft²** |
| Occupied Area (%MLA) by Store / Rate Increases by Store (charts) | Chart | OccupancyStatistics, TenantRentChangeHistory | areaPCmla, rateChanges.increases | per-site | current | *not captured in last output (per-site breakdown, needs a table dump)* |
| Unit Mix Occupancy (All Stores) | Table | OccupancyStatistics (unit_mix) | tot, occ, total_area per size bucket | Grouped by size, Σocc/Σtot | current | *not captured in last output* |
| Units by Customer Type — by Store | Table | RentRoll | customerType per site | per-site personal/business split | current | *not captured in last output (portfolio total above: 14.7%/85.3%)* |
| Offices Occupancy — by Store | Table | OccupancyStatistics, RentRoll (Office) | offices.{occ,tot,rate} | per-site | current | *not captured in last output (portfolio total above: 89/118, £33.72)* |
| Indoor Self Storage Occupancy — by Store | Table | OccupancyStatistics, RentRoll (SS) | ss.{occ,tot,rate} | per-site | current | *not captured in last output (portfolio total above: 7,757/12,356, £23.96)* |
| Occupied Area by % of CLA — by Store | Table | OccupancyStatistics | occA, claA | per-site | current | *not captured in last output (portfolio total above: 65.9%)* |

---

## Financials

| Widget | Type | SiteLink report(s) | Columns used | Formula | Scope | Our Portal (Live) |
|---|---|---|---|---|---|---|
| Customer Insights | Stat card | RentRoll | rent_sum, occ, avg_length_of_stay_days | Avg customer value = Σrent÷Σocc; Avg stay = occ-weighted avg | current | Avg customer value ≈ **£150.13/month** (£1,262,860 ÷ 8,411); Avg length of stay *not captured in last output* |
| Past Due Balances | Stat card | PastDueBalances | total_overdue_30plus | Total (30+ days) and % of rent roll | current | **£30,616 total, 2.4% of rent roll** |
| True Revenue | Table | CustomReportByReportID(781861) | 9 revenue columns, grouped by ChargeDesc | Σ per column, grouped | current | True Period total ≈ **£91,782** month-to-date. Top lines: Rent £75,796, StoreProtect £11,517, Security Deposit £1,850 |
| True Revenue — Unit Types | Table | same | same, grouped by UnitType | Σ per column, grouped | current | Self Storage £43,059, Indoor Self Storage £33,116, Enterprise £7,537, Office £2,055, Parking £1,263, Drive Up £1,152, others smaller |

---

## Ancillaries

| Widget | Type | SiteLink report(s) | Columns used | Formula | Scope | Our Portal (Live) |
|---|---|---|---|---|---|---|
| Autobill Conversion | Stat card | MoveInsAndMoveOuts, RentRoll | move_in_tenant_ids, autobill_tenant_ids | New autobilled ÷ new customers | **prev** | **81.4%** — **stale, pre-fix**, rerun to confirm |
| Insurance Conversion | Stat card | InsuranceActivity/ManagementSummary, MoveInsAndMoveOuts | newPolicies, moveIns | New move-in policies ÷ move-ins | **prev** | *not captured in last output* |
| Insurance Roll | Stat card | InsuranceRoll | insured_units, monthly_premium | Premiums, % Rent Roll, % Insured | current | **£169,379 premiums, 13.4% of rent roll, 83.1% insured** |
| Insurance Premiums (New Customers) | Stat card | InsuranceActivity | newPolicies, newPremium | Premiums weekly = (Σnewpremium÷Σnewpolicies)×12÷52 | **prev** (Premiums weekly); mock (Contents avg) | *not captured in last output* |
| Merchandise Income per New Customer | Stat card | MerchandiseSummary, MoveInsAndMoveOuts | sales, moveIns | Σsales÷Σmoveins | **prev** | *not captured in last output* |
| Merchandise Sales | Stat card | MerchandiseSummary | dcChargeTotal | Σ sales | **prev** | *not captured in last output* |
| Insurance % Insured by Store / Insurance Roll (All Stores) table | Chart/Table | InsuranceRoll, RentRoll | insured, premium, rent | per-site | current | *not captured in last output (portfolio total above: 83.1% insured, £169,379 premiums)* |

All the "not captured" Ancillaries rows above are exactly the ones affected by the 3 Jul 2026 month-scoping fix — worth prioritizing a fresh pull + a dump of these specific numbers to confirm the fix actually worked.

---

## Marketing

| Widget | Type | SiteLink report(s) | Columns used | Formula | Scope | Our Portal (Live) |
|---|---|---|---|---|---|---|
| Enquiries by Channel | Stat card | InquiryTracking | phone/walkin/web/total | Σ per channel | **prev** | *not captured in last output* |
| Enquiry → Reservation | Stat card | InquiryTracking | conversions, total | Σconversions÷Σtotal×100 | **prev** | *not captured in last output* |
| Cost per Lead | Stat card | *(none)* | — | mock only | mock | mock **£9.40 blended, £12,820 spend** (not real — no spend data exists in SiteLink) |
| Web Enquiries by Store | Chart | InquiryTracking | enquiries.web | per-site | **prev** | *not captured in last output* |
| Reservations vs Move-ins | Chart | ReservationList, ManagementSummary | activeReservations, moveIns | Σreservations vs Σmoveins | mixed (current/prev) | Reservations 1,420 (see KPIs row above); Move-ins *not captured in last output* |
| Leads by Store (All Stores) | Table | InquiryTracking | phone/web/walkin/total/conversions | per-site | **prev** | *not captured in last output* |

---

## Month on Month

Portfolio-level trend lines from `history[]` — do not respect the store/region filter. Currently only 2 points (current + previous month) until a backfill runs.

| Widget | Type | SiteLink report(s) | Columns used | Formula | Our Portal (Live) |
|---|---|---|---|---|---|
| Revenue Collected | Trend chart | FinancialSummary | total_charge, total_credit | Charge − Credit, per month | *not captured — needs history dump* |
| Rent Roll | Trend chart | RentRoll | monthly_rent | Σ rent, per month | Current month point: £1,262,860 (see KPIs above); prior points not captured |
| Insurance Roll | Trend chart | InsuranceRoll | monthly_premium | Σ premium, per month | Current month point: £169,379 (see Ancillaries above); prior points not captured |
| Total Occupied Area | Trend chart | OccupancyStatistics | occupied_area | Σ occA, per month | Current month point: 650,198 ft²; prior points not captured |
| Self Storage Occupied Area | Trend chart | OccupancyStatistics (SS) | ss.occupied_area | Σ ssOccA, per month | *not captured — needs history dump* |
| Self Storage Rate per ft² | Trend chart | RentRoll (SS) | ss.rent_sum, ss.area_sum | Σrent(SS)÷Σarea(SS)×12, per month | Current month point: £23.96/ft² (see KPIs above); prior points not captured |

---

## Custom Widget Builder — full field catalog

Unchanged reference — no live/target values apply (user builds their own formula per widget).

| Group | Fields |
|---|---|
| Occupancy & Area | Occupied Units, Total Units, Occupancy %, Occupied Area (ft²), CLA Area (ft²), Total Area/MLA (ft²), Occupied Area % of CLA, Occupied Area % of MLA, Vacant Units, Unrentable Units |
| Rent & Rate | Rent Roll (£), Gross Potential (£), Gross Occupied (£), Rent per Unit (£), Rate per ft² (£), Real Rate per ft² (£), Actual Occupied Unit Rates (£) |
| Indoor Self Storage | Occupied/Total Units, Occupancy %, Occupied Area, Rate/Real Rate per ft², Rent Roll, Gross Potential |
| Offices | Occupied/Total Units, Occupancy %, Rate per ft² |
| Move-ins, Move-outs & Reservations | Move-ins, Move-outs, Net ft², Move-outs (YTD), Scheduled Move-outs, Reservations (InquiryTracking), Active Reservations |
| Debtors | Total Overdue (30+ days), Accounts Overdue (30+ days), All Overdue (any age), % Tenants, % Rent Roll |
| Insurance | Insured Units, Monthly Premium, Penetration %, New Move-in Policies, New Premium, Cancellations |
| Enquiries | Total, Conversions, Phone, Walk-ins, Web(+Email), Web only, Email only |
| Merchandise & Revenue | Sales, Cost, Margin, Revenue Collected, Charged, Payments, Discounts |
| Rate Changes & Marketing | Increases, Decreases, Avg Increase %, Marketing Tenants/Commercial/Residential/Avg Rent |
| Autobill & Tenancy | Autobill Rate (whole book), Autobill Tenants (whole book), Total Tenants (whole book), New Autobilled Tenants (this month), New Tenants (this month), Avg Length of Stay |

---

## Known open items

- **Reservations vs Move-outs**: confirmed overcounting — 1,420 vs a ~446 target. Blocked pending SiteLink support/manager input on `QTRentalStatusID`. `probe:reservations-qtrentaltype` tests a new hypothesis.
- **Enquiries**: funnel-stage filter fixed most of the overcount but ~20% residual gap remains. `probe:enquiries-gap2` tests the "Email channel" and duplicate-row hypotheses.
- **Ancillaries month-scoping bug**: fixed in code 3 Jul 2026 (Insurance Conversion, Merchandise Sales/Income, Autobill Conversion) — needs a fresh `npm run pull` to verify, since the previous month's `insurance_activity`/`merchandise`/`rent_roll` data has to actually be pulled before the fix takes effect.
- **Customer Churn**: mock until ≥12 months of history are stored (your weekend backfill will unblock this).
- **Cost per Lead**: permanently mock — no ad-spend data anywhere in SiteLink.
- **Insurance Premiums "Contents avg"**: permanently mock — no per-new-customer coverage-value data exists.
- **Region filtering**: mock-data-only; live sites have no region field.
- **8-year backfill + date-range filtering**: scoped, deliberately deferred.
