# Cinch Portal — Data Mapping (widget → SiteLink report)

CONFIRMED against the SiteLink **Reporting API** doc (2017 ed.). All reports are SOAP methods on
`ReportingWs.asmx`. Each takes 6 positional params: corp code, location code, username(:::licenseKey),
password, start date, end date. The API user needs the **"API All Reports"** right (+ "API Insurance"
for insurance reports). The doc gives method names + params but **not** the success column names —
those come from the first live call (`npm run test:connection`), then `reportMap.js`/`buildPayload.js`
field mapping is finalised.

| Widget area | SiteLink method | Status |
|---|---|---|
| Occupancy / area / unit mix | `OccupancyStatistics` | wired (live-first) |
| Rent roll, rate/ft², autobill, customer type | `RentRoll` | wired (live-first) |
| Move-ins & move-outs | `MoveInsAndMoveOuts` | method confirmed |
| Debtor levels / past due | `PastDueBalances` | method confirmed |
| Reservations vs scheduled move-outs | `ScheduledMoveOuts` | method confirmed |
| Insurance roll / penetration | `InsuranceRoll` | method confirmed |
| Insurance conversion / new-customer premiums | `InsuranceActivity` | method confirmed |
| Enquiries (phone/web/walk-in), lead funnel | `InquiryTracking` | method confirmed |
| Customer insights (value, length of stay) | `MarketingSummary` | method confirmed |
| Merchandise sales / per customer | `MerchandiseSummary` | method confirmed |
| Revenue / rent totals | `FinancialSummary` | method confirmed |
| Rate increases in month | `TenantRentChangeHistory` | method confirmed |
| Effective rate (credits/discounts) | `Discounts` | method confirmed |
| **True Revenue (custom report #781861)** | **— none —** | **NOT in the API.** Derive from `FinancialSummary` or keep manual. |

**Formulas** (unchanged, from the KPI Reference): rate/ft² = (rent ÷ area) × 12; autobill = iAutoBillType 1\|2 ÷ tenants;
insurance penetration = insured ÷ occupied; conversion = insured move-ins ÷ move-ins; churn = rolling-12mo
move-outs ÷ avg occupied × 100; effective rent = rate − credits − discounts.

_Live-first set in the pull = `occupancy` + `rent_roll` (fast, drives the occupancy widgets across all
sites). Add the others to `DEFAULT_REPORTS` in `lib/pull.js` once their columns are confirmed._
