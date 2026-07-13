// Assemble the single JSON document the portal reads (portal_payload.payload).
// Emits: `sites` (full detail for the current month), `monthly` (LIGHT per-site record for EVERY
// stored month — powers date-range / compare / multi-store), `history` (portfolio trend per month),
// `totals`, and `months`. No tenant PII — only the aggregated objects from reportMap.parse().
import { admin } from './supabaseAdmin.js';

const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
// Round-half-up to 2dp — see identical comment/fix in lib/reportMap.js. Plain `.toFixed(2)` can
// round DOWN on values whose binary float representation sits just under the true .xx5 boundary
// (e.g. 28.005 stored as 28.00499999999999...). Applied everywhere a rate/rent £ figure is rounded.
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
// FIXED 13 Jul 2026 (tooltip-audit side-finding): 'discounts' was pulled and stored by lib/pull.js
// (DEFAULT_REPORTS includes it, added 9 Jul 2026 for the Discount Summary page + Move-in Variance
// KPI widget) but was missing here — fetchAllRaw()'s `.in('report', ALL_REPORTS)` filter silently
// dropped every discounts row on read-back, so disc.discount_plans was always [] and the whole
// Discount Summary page had been showing mock data in production since it was built, with no visual
// indicator (the page's own `live` flags all correctly derive from dsRows, they just never had
// anything to read). Move-in Variance vs Standard Rate (KPIs page) reads a DIFFERENT report
// (ManagementSummary's VarFromStdRate) and was unaffected.
const ALL_REPORTS = ['occupancy', 'rent_roll', 'management', 'move_ins_outs', 'past_due', 'scheduled_outs',
  'insurance_roll', 'insurance_activity', 'lead_funnel', 'marketing', 'merchandise', 'financial', 'rate_changes',
  'reservations', 'true_revenue', 'rental_activity', 'discounts'];
// NOTE (2 Jul 2026, Michael): the new portal intentionally tracks every site it has a SiteLink code
// for, including ones the legacy portal doesn't yet — those stores should stay LIVE and included in
// every widget, not excluded. Any resulting gap vs. legacy's own totals is an expected difference in
// scope, not something to patch around here.
// UPDATED 8 Jul 2026 (Michael): added L028 (Edmonton) and L029 (Abingdon) to SITELINK_LOCATIONS.
// Abingdon was previously the one site legacy tracked that we didn't (task #68, closed) — legacy's
// own per-site Enquiries table confirms it as a genuinely SHARED site, so this closes that scope gap
// rather than widening it. Edmonton doesn't appear anywhere in legacy's per-site table, so — like
// Bedford (L021) and Paulton (L026) — it looks like a site we track that legacy doesn't (yet).
// Both are brand new to THIS system: no historical raw_report rows exist for them before today, so
// they'll only have data from whichever pull first includes them onward (Month-on-Month/history
// views will show them as blank/zero for prior months — expected, not a bug).
// Authoritative location code → name (the SiteLink `sites` table seeds name=code for some sites).
const NAMES = { L001: 'Bicester', L002: 'Leighton Buzzard', L003: 'Letchworth', L004: 'Chippenham', L005: 'Brighton', L006: 'Huntingdon', L007: 'Newmarket', L008: 'Enfield', L009: 'Newbury', L010: 'Mitcham', L011: 'Sittingbourne', L012: 'Gillingham', L013: 'Brentwood', L014: 'Earlsfield', L015: 'Watford', L016: 'Seaford', L017: 'Southend', L018: 'Woking', L019: 'Sidcup', L020: 'Dunstable', L021: 'Bedford', L022: 'Swindon', L023: 'Wisbech', L024: 'Newcastle', L025: 'Shoreham-By-Sea', L026: 'Paulton', L027: 'Exeter', L028: 'Edmonton', L029: 'Abingdon' };

// Build one site record from a month's reports. `full` adds the heavy arrays (unit mix, channels,
// ageing, charge categories) — kept only for the current month to keep the payload light.
// `nextC` (optional) is the FOLLOWING month's raw bundle — only used for the reservationConversions
// next-month-lag match below; undefined is fine everywhere else (same-month-only matching, as before).
function recordFor(code, name, c, full, nextC) {
  const o = c.occupancy || {}, rr = c.rent_roll || {}, mio = c.move_ins_outs || {}, mg = c.management || {};
  const pd = c.past_due || {}, so = c.scheduled_outs || {}, ins = c.insurance_roll || {}, ia = c.insurance_activity || {};
  const lf = c.lead_funnel || {}, mk = c.marketing || {}, me = c.merchandise || {}, fin = c.financial || {}, rc = c.rate_changes || {};
  const res = c.reservations || {};
  const tr = c.true_revenue || {};
  const ra = c.rental_activity || {};
  const disc = c.discounts || {};
  const ss = o.self_storage || {}, offices = (o.unit_types || []).find(t => /office/i.test(t.unit_type)) || {};
  // Per the legacy portal's own tooltip (confirmed 2 Jul 2026): Offices/Indoor Self Storage widgets
  // use Occupancy Statistics for occ/tot counts, but RentRoll for Rent + Occupied Area (rate =
  // Rent/Occupied Area * 12) — same rule the Self Storage rate above already follows. Occupancy
  // Statistics' own per-type rate_per_sqft_ann is NOT used for this rate.
  const rrOffices = (rr.unit_types || []).find(t => /office/i.test(t.unit_type)) || {};
  const occ = o.occupied_units || 0, tot = o.total_units || 0, occA = o.occupied_area || 0, claA = o.cla_area || 0, totA = o.mla_area || o.total_area || 0;
  // "Actual Occupied Unit Rates" (legacy portal tooltip, confirmed 2 Jul 2026) = the sum of
  // OccupancyStatistics' raw `ActualOccupied` column across all unit-type/size rows for the site —
  // already computed by lib/reportMap.js's occupancy parser as `monthly_rent` (its own internal
  // name for the same sum). Kept separate from `rent` (RentRoll's dcRent-based monthly rent) below.
  const occActualRent = o.monthly_rent || 0;
  // Rate (portfolio-wide, all unit types) still comes from RentRoll only — the locked spec (Michael
  // 1 Jul 2026: Σ dcStandardRate ÷ Σ area × 12) is unchanged for this one.
  const rent = rr.monthly_rent || 0;
  const rate = rr.rate_per_sqft_ann || 0;
  // Real Rate — numerator changed 8 Jul 2026 (Michael's hypothesis: "it is true revenue / total
  // area*12", tested read-only via scripts/probe-realrate-formula-variant.js against live SiteLink
  // data for all 25 known-target sites before touching this code, per his explicit "dont change any
  // code unitl we confirm this" instruction). Result: Σ TruePeriod alone (no ThisPeriodAdjustments
  // subtraction) beat Σ(TruePeriod − ThisPeriodAdjustments) in 44 of 50 site/SS-vs-Total comparisons,
  // dropping average absolute error from ~30% to ~22%. Confirmed: TruePeriod already nets out
  // adjustments internally, so subtracting ThisPeriodAdjustments again was double-counting it.
  // Denominator unchanged: RentRoll's TOTAL area INCLUDING VACANT units (rr.total_area_all_units), NOT
  // occupied area like every other rate calc in this file (occupied-area was the mistake in an earlier
  // pass at this fix — landed ~3-4x too high). Total variant sums every True Revenue by_type row; Self
  // Storage variant (below) sums only "Self Storage" row(s) (substring match, same as reportMap.js's
  // own isSS(), in case True Revenue ever labels a row "Indoor Self Storage" too). Falls back to the
  // old dcRent-based figure (reverse-derived into an equivalent numerator) when true_revenue wasn't
  // pulled for this site/month, so portfolio sum-then-divide and Month-on-Month trend lines keep
  // working across mixed-availability months.
  // NOT fully resolved by this change: even with the better formula, ~14 of 25 sites (incl. L004,
  // L008, L020, L022, L023, L025, L027) still show 20-70% error vs legacy target — a separate, larger,
  // not-yet-identified issue (likely per-site total-area correctness or True Revenue coverage
  // completeness) remains open. See task #77 (True Revenue ~2.14x inflation) — if that's confirmed
  // real, this Real Rate inherits it regardless of which numerator formula is used.
  const byType = tr.by_type || [];
  const hasTrueRevenue = byType.length > 0;
  const totalArea = rr.total_area_all_units || 0;
  const realRateFallback = rr.real_rate_per_sqft_ann || 0;
  const trueRevenueNumerator = hasTrueRevenue
    ? byType.reduce((a, r) => a + (r.truePeriod || 0), 0)
    : realRateFallback * totalArea / 12;
  // ANNUALIZE FACTOR — 10 Jul 2026: tried 365/period_days instead of a blind 12 (see
  // scripts/probe-truerevenue-period-granularity.js — confirmed TruePeriod DOES scale ~linearly with
  // elapsed days, not bucketed by month). The math checked out (every site's realRate moved by a
  // uniform ~3.04x, exactly 365/10 / 12 — no bug in the arithmetic), but it made the gap vs Michael's
  // legacy targets MUCH worse (avg error 26% -> 207%). REVERTED, then Michael confirmed directly
  // (10 Jul 2026) legacy's own definition: "month to date, true period revenue for all unit types
  // divided by total area for all units" — no mention of correcting for elapsed days. That CONFIRMS
  // legacy does the same "blind x12 regardless of how many days into the month it is" math this file
  // already had before today's detour — it's not a bug relative to legacy, legacy has the identical
  // property. Formula (numerator = all unit types' TruePeriod, denominator = total area incl. vacant,
  // factor = 12) is now confirmed-correct, not just reverted-as-a-guess. The remaining ~26% avg error
  // is a separate, smaller-magnitude question (True Revenue coverage completeness / normal data
  // timing noise, not a wrong formula) — see task list. period_days/trueRevenuePeriodDays is still
  // computed/carried below in case it's ever useful, but is NOT part of the confirmed formula.
  const trueRevenuePeriodDays = (hasTrueRevenue && tr.period_days) ? tr.period_days : null;
  const annualizeFactor = 12;
  const realRate = totalArea ? R2(trueRevenueNumerator / totalArea * annualizeFactor) : realRateFallback;
  // Self Storage Rate — RentRoll only (Michael, 7 Jul 2026: revert the OccupancyStatistics fallback
  // added 7 Jul 2026; keep RentRoll as the sole source everywhere, including Enfield, even where it
  // disagrees with OccupancyStatistics).
  const ssRate = (rr.self_storage && rr.self_storage.rate_per_sqft_ann) || 0;
  // Self Storage Real Rate — same True Revenue-based numerator as Total Real Rate above (TruePeriod
  // alone, no adjustment subtraction — see comment above), scoped to just the "Self Storage" by_type
  // row(s), divided by Self Storage's TOTAL area (incl. vacant).
  const ssArea = (rr.self_storage && rr.self_storage.total_area_all_units) || 0;
  const ssRealFallback = (rr.self_storage && rr.self_storage.real_rate_per_sqft_ann) || 0;
  const ssTrueRevenueNumerator = hasTrueRevenue
    ? byType.filter((r) => String(r.desc || '').toLowerCase().includes('self storage')).reduce((a, r) => a + (r.truePeriod || 0), 0)
    : ssRealFallback * ssArea / 12;
  // Same annualizeFactor as Total Real Rate above — one true_revenue pull per site/month, so the
  // period length is identical for the SS-scoped and Total figures.
  const ssReal = ssArea ? R2(ssTrueRevenueNumerator / ssArea * annualizeFactor) : ssRealFallback;
  const insured = ins.insured_units || 0;
  const rec = {
    name, code, occ, tot, occPC: tot ? +(occ / tot * 100).toFixed(1) : 0, occA, claA, totA,
    areaPC: claA ? +(occA / claA * 100).toFixed(1) : (totA ? +(occA / totA * 100).toFixed(1) : 0), areaPCmla: o.area_pc_mla || (totA ? +(occA / totA * 100).toFixed(1) : 0), rent, grossOcc: o.gross_occupied || 0, gpot: o.gross_potential || 0,
    rpu: occ ? R2(rent / occ) : 0, rate, realRate,
    // Raw numerator/denominator sums, carried through so buildPayload()'s portfolio totals can
    // re-aggregate by summing these FIRST and dividing once — never by averaging per-site rates.
    rentSum: rr.rent_sum || 0, stdRentSum: rr.std_rent_sum || 0, areaSum: rr.area_sum || 0,
    ssRentSum: (rr.self_storage && rr.self_storage.rent_sum) || 0,
    ssStdRentSum: (rr.self_storage && rr.self_storage.std_rent_sum) || 0,
    ssAreaSum: (rr.self_storage && rr.self_storage.area_sum) || 0,
    // True Revenue-based Real Rate numerators + their TOTAL-area (incl. vacant) denominators — see
    // comment above. Carried through raw, same sum-then-divide-once convention as rentSum/areaSum.
    // areaTotalAll/ssAreaTotalAll are DELIBERATELY separate from areaSum/ssAreaSum above (those are
    // occupied-area only, still correct for Rate) — reusing areaSum here was the bug in the first pass.
    trueRevenueNumerator, ssTrueRevenueNumerator,
    areaTotalAll: totalArea, ssAreaTotalAll: ssArea,
    // Carried through so aggregateTotals()/the portfolio total can annualize with the SAME real
    // period length instead of re-assuming 12 — see annualizeFactor comment above.
    trueRevenuePeriodDays,
    // Offices rent/area sums, for portfolio-level Offices rate re-aggregation (sum-then-divide,
    // same rule as ssRentSum/ssAreaSum above).
    officesRentSum: rrOffices.rent || 0, officesAreaSum: rrOffices.area || 0,
    ssRate, ssReal,
    ss: { occ: ss.occupied_units || 0, tot: ss.total_units || 0, occPC: ss.total_units ? +(ss.occupied_units / ss.total_units * 100).toFixed(1) : 0, occA: ss.occupied_area || 0, rate: ssRate, real: ssReal },
    offices: { occ: offices.occ || 0, tot: offices.tot || 0, occPC: offices.tot ? +(offices.occ / offices.tot * 100).toFixed(1) : 0, rate: rrOffices.rate_per_sqft_ann || 0 },
    autobillRate: rr.autobill_rate || 0, avgStayDays: rr.avg_length_of_stay_days || 0,
    autobillCount: rr.autobill_count || 0, tenantsCount: rr.tenants || 0,   // raw sums for the OLD whole-book autobill % (kept for back-compat, no longer used by the Autobill Conversion widget)
    // Autobill Conversion widget (legacy tooltip, confirmed 2 Jul 2026): "New autobilled customers
    // divided by total new customers" — i.e. scoped to THIS MONTH'S move-ins only, not the whole
    // existing tenant book (autobillCount/tenantsCount above, which is what this file used before).
    // Cross-reference move_ins_outs' move-in TenantIDs against RentRoll's autobill-tenant set.
    // NOTE 9 Jul 2026: this is a single point-in-time cross-reference (RentRoll is always "today",
    // never a true historical snapshot). It's no longer the final value shown on the widget —
    // applyAutobillDailyAverage() below overwrites it with an average across the month's daily
    // samples once any exist for this site+month. Left as-is here so it still stands on its own as a
    // sensible fallback for any month with zero collected samples (i.e. everything before 9 Jul 2026).
    autobillNewCount: (() => {
      const moveInIds = mio.move_in_tenant_ids;
      if (!Array.isArray(moveInIds) || !moveInIds.length) return 0;
      const autobillIds = new Set(rr.autobill_tenant_ids || []);
      return moveInIds.filter((id) => autobillIds.has(id)).length;
    })(),
    autobillNewTotal: (mio.move_in_tenant_ids || []).length,
    // Move-ins & Move-outs widget (legacy portal tooltip, confirmed 2 Jul 2026):
    //   Move-Ins  = ManagementSummary -> Activities -> Move Ins
    //   Move-Outs = ManagementSummary -> Activities -> Move Outs
    //   Net ft²   = MoveInsAndMoveOuts report -> sum area of Move-Ins and Move-Outs, find the
    //               difference — i.e. `mio.net_area` (moved_in_area - moved_out_area), NOT
    //               ManagementSummary's own "Rented Area Increase" line (mg.net_area), which this
    //               file used previously. That was a confirmed bug — different report entirely.
    moveIns: mg.move_ins || 0, moveOuts: mg.move_outs || 0, netArea: mio.net_area || 0, moveOutsYear: mg.move_outs_year || 0,
    // Move-In Rental Rate widget (KPIs page, added 6 Jul 2026 from Michael's uploaded
    // MoveInsAndMoveOuts export): Σ MovedInRentalRate ÷ Σ MovedInArea × 12, same sum-then-divide/
    // annualise convention as every other rate/ft² figure — raw sums carried through so
    // buildPayload()'s portfolio totals re-aggregate correctly (never averaging per-site rates).
    moveInAreaSum: mio.moved_in_area || 0, moveInRateSum: mio.moved_in_rental_rate_sum || 0,
    // moveOutAreaSum ADDED 9 Jul 2026 (Michael: "we currently display just a net sqft number, can you
    // get gross sqft in and out please" — KPI page). mio.moved_in_area already existed (moveInAreaSum
    // above, for the Move-In Rental Rate widget's denominator); moved_out_area was parsed by
    // reportMap.js's move_ins_outs report all along but never surfaced past that point.
    moveOutAreaSum: mio.moved_out_area || 0,
    scheduledOuts: so.scheduled_move_outs || 0, reservations: lf.reservations || 0,
    // reservationsMade: ADDED 6 Jul 2026 to rebuild "Reservations vs Move-outs" as a fully historical
    // widget (Michael's idea) — confirmed via npm run probe:lead-funnel-reservations that
    // lead_funnel's reservation-stage row count genuinely varies by month (unlike ReservationList/
    // ScheduledMoveOuts below, both proven live-only). Paired with `moveOuts` above (ManagementSummary
    // actual completed move-outs, already reliable) this makes the widget "Reservations Made vs
    // Move-outs Completed" for a given month — both real historical flow counts.
    reservationsMade: lf.reservation_stage_count || 0,
    // "Reservations vs Move-outs" KPI widget: activeReservations comes from ReservationList
    // (CallCenterWs.asmx — a different SiteLink service, see lib/sitelink.js's
    // callReservationList()), NOT the `reservations` field above (that one is InquiryTracking's
    // conversion-tracking count, a different metric used by the legacy /api/bootstrap endpoint).
    // Cross-reference against THIS SAME MONTH's occupied RentRoll tenants: a reservation whose
    // TenantID already shows up as a currently-occupied unit has converted to a lease and should
    // not still count as "open", even though its ReservationList row was never formally closed out
    // (confirmed via npm run audit, 2 Jul 2026 — ~51 rows portfolio-wide). This does NOT fully
    // explain the overcount on its own — see lib/reportMap.js's `reservations` parser comment for
    // the larger, still-unresolved QTRentalStatusID question.
    activeReservations: (() => {
      const ids = res.active_tenant_ids;
      if (!Array.isArray(ids)) return res.active_reservations || 0;
      const occupiedIds = new Set(rr.occupied_tenant_ids || []);
      return ids.filter((id) => !occupiedIds.has(id)).length;
    })(),
    // Reserved Scheduled Sqft (KPIs page, added 6 Jul 2026) — ESTIMATE only. ReservationList has no
    // area/size column at all (confirmed via probe:reservation-area); UnitTypeID maps to a broad
    // type, not one exact size (confirmed via probe:unittypeid-map). Best available: reservation
    // count per UnitTypeID (res.active_by_unit_type) × that type's average unit area at this site
    // this month (rr.unit_type_areas). Always reads the CURRENT month's own rr/res data — same
    // "stays live, not overridden to previous month" rule as Rate/Occupancy (this is a point-in-time
    // snapshot, not a calendar-month total) — so a closed month just keeps whatever was last stored
    // while it was still current; there is no way to compute this after the fact for a past month
    // (confirmed, Michael 6 Jul 2026: "it is passed june so june cannot have any live data").
    // Inherits the known ~3x active-reservations overcount (Task #25) until that's fixed.
    reservedSqftEstimate: (() => {
      const areaByType = {}; for (const t of (rr.unit_type_areas || [])) areaByType[t.unit_type_id] = t.avg_area;
      const byType = res.active_by_unit_type || {};
      return Math.round(Object.entries(byType).reduce((a, [id, count]) => a + count * (areaByType[id] || 0), 0));
    })(),
    debtors: {
      // "Delinquent" = balance over 30 days late (R6's own rule). CHANGED 7 Jul 2026: now sourced
      // from ManagementSummary's OWN internal "Unpaid" aging-bucket table (mg.delinquent_30plus_total/
      // _units — see reportMap.js's `management` parser) instead of computing it ourselves from
      // PastDueBalances' raw tenant rows. The legacy portal's tooltip was RIGHT all along ("source:
      // ManagementSummary") — our bug was that lib/sitelink.js's extractRows() only ever returns the
      // SINGLE LARGEST table in a multi-table SOAP response, so ManagementSummary's real Delinquency/
      // Unpaid tables were silently discarded on every pull, ever, and this widget fell back to a
      // hand-rolled DaysLate>30 filter over PastDueBalances instead. Confirmed via a live SiteLink UI
      // export for Gillingham/Jul 2026 that SiteLink's own number (£973.29) does NOT match what that
      // PastDueBalances-based formula computed (£1,059.12) — root cause of an unexplained ~£3k+ gap
      // vs the legacy portal (£28,790 ours vs £22,589 legacy, portfolio-wide, after adjusting for the
      // separate Bedford/Paulton/Abingdon site-scope difference). Falls back to the old PastDueBalances
      // formula for any month pulled BEFORE this fix (mg.delinquent_30plus_total won't exist yet on
      // already-stored rows until re-pulled).
      total: mg.delinquent_30plus_total ?? (pd.total_overdue_30plus ?? (pd.ageing ? Math.round(['31-60', '61-90', '91-120', '121-180', '181-360', '361+'].reduce((a, k) => a + (pd.ageing[k] || 0), 0)) : (pd.total_overdue || 0))),
      accounts: mg.delinquent_30plus_units ?? (pd.accounts_overdue_30plus ?? pd.accounts_overdue ?? 0),
      allOverdue: mg.delinquent_30plus_total ?? (pd.total_overdue_30plus ?? pd.total_overdue ?? 0),
      // Debtor Levels widget: Tenant % = delinquent accounts / Occupied Units; Rent Roll % =
      // delinquent total / Actual Occupied Unit Rates.
      tenantPct: occ ? +((mg.delinquent_30plus_units ?? pd.accounts_overdue_30plus ?? pd.accounts_overdue ?? 0) / occ * 100).toFixed(1) : 0,
      rentRollPct: occActualRent ? +((mg.delinquent_30plus_total ?? pd.total_overdue_30plus ?? pd.total_overdue ?? 0) / occActualRent * 100).toFixed(1) : 0,
    },
    occActualRent,
    insurance: { insured, premium: ins.monthly_premium || 0, penetration: occ ? +(insured / occ * 100).toFixed(1) : 0 },
    insurancePremiumSum: ins.monthly_premium || 0, insuredUnitsSum: insured,   // flat copies for portfolio-level sum-then-divide
    insuranceActivity: { newPolicies: mg.insured_moveins || ia.new_policies || 0, newPremium: ia.new_premium || 0, cancellations: ia.cancellations || 0 },
    // insuredNewCustomers: ADDED 6 Jul 2026 for Insurance Premiums (New Customers)/Insurance
    // Conversion, replacing InsuranceActivity's unreliable `sNewPolicy` flag (confirmed £0.00 output
    // even with nonzero move-ins and a nonzero existing InsuranceRoll book).
    // Two prior cross-reference attempts against move_ins_outs' TenantIDs both failed: `TenantID`
    // doesn't exist on InsuranceRoll at all, and `LedgerID` (assumed to be the same ID space) turned
    // out NOT to overlap with TenantID (confirmed 0 matches after a fresh pull). FIX: InsuranceRoll
    // has its own `dMovedIn` column, so lib/reportMap.js's parser now directly filters active
    // policies whose move-in date falls within the pulled period — no cross-report ID matching
    // needed. See `insured_new_customers` in the insurance_roll parser.
    insuredNewCustomers: ins.insured_new_customers || { count: 0, premiumSum: 0, coverageSum: 0 },
    // Enquiries — CHANGED 7 Jul 2026 (Michael, after comparing our July dashboard against the legacy
    // portal's Marketing page and finding ours at 1,885 vs legacy's 860 for the same month): TOTAL
    // briefly moved to phone_leads + walkin_leads + web_leads (ManagementSummary) to match legacy's
    // own "3 tiles added together" Total. That masked the real bug rather than fixing it: lead_funnel
    // (InquiryTracking)'s old sRentalType="Inquiry" (current-stage) filter was badly miscounting at
    // the channel level (Web ~96%/Phone ~2%/Walk-in ~2% vs legacy's own ~88%/6%/6%), and switching to
    // ManagementSummary just swapped one imperfect source for another (ManagementSummary's own
    // Walk-In counter runs a stable +23-24% over legacy, confirmed across two independent months).
    // REVERTED 8 Jul 2026: root-caused and fixed the actual lead_funnel bug instead (see reportMap.js's
    // lead_funnel parser comment — filtering by dPlaced-in-window rather than current funnel stage).
    // Validated against Michael's uploaded Bicester export (exact per-site match) and then the full
    // 25-site portfolio (exact Phone 54/Walk-in 60, Web within 2.8% of legacy's 887) — now the more
    // accurate source AND the more complete one (lead_funnel's total_enquiries also correctly follows
    // legacy's own tooltip formula: Phone + Walk-Ins + Web + Email).
    enquiries: {
      total: lf.total_enquiries || 0,
      // conversions (Enquiry -> Move-In) — 3 Jul 2026 attempts, all since superseded:
      //   1. iInquiryConvertedToLease flag (original) — frequently 0, wrong milestone anyway.
      //   2. TenantID cross-reference against move_ins_outs — WORSE (0.1% portfolio-wide); confirmed
      //      InquiryTracking's TenantID isn't even the same ID space as RentRoll's/move_ins_outs'.
      //   3. WaitingID — doesn't exist on MoveInsAndMoveOuts or RentRoll at all.
      //   4. Email-hash cross-reference (lead_funnel's inquiry_email_hashes vs move_ins_outs'
      //      move_in_email_hashes) — real signal (158/4408, 3.6%) but a per-lead COHORT match, so it
      //      undercounts for the same structural reasons as the Reservation version: it requires the
      //      exact same email on both an "Inquiry"-stage row and a later move-in row, InquiryTracking
      //      issues a brand-new row per stage transition (no stable per-lead ID to fall back on), and
      //      it only looks at the same month (no lag window).
      // CHANGED 7 Jul 2026 (Michael): switched to a plain PERIOD-RATIO instead of a matched cohort —
      // this month's total move-ins (ManagementSummary, `mg.move_ins`, already reliable) divided by
      // this month's total enquiries. Loses person-level attribution (can't say a move-in came FROM a
      // specific enquiry) but isn't dragged down by email-matching gaps, and both counts are already
      // trusted, independently-verified aggregates — the same "sum first" principle used everywhere
      // else in this file rather than trying to stitch two reports together lead-by-lead.
      conversions: mg.move_ins || 0,
      // reservationConversions — ADDED 6 Jul 2026 for the "Enquiry -> Reservation" widget, which had
      // been silently computing Enquiry -> MOVE-IN instead (see `conversions` above) under a
      // misleading title. Two prior candidates for the real thing both confirmed dead via
      // probe:enquiry-reservation: `iReservationConvertedToLease` (4.0% populated, same broken-flag
      // class as iInquiryConvertedToLease) and WaitingID/TenantID (0% overlap between a lead's own
      // Inquiry-stage and Reservation-stage rows — not even stable within one report). Same email-
      // hash fix as `conversions`, just matched against THIS SAME report's reservation-stage rows
      // instead of move_ins_outs. Same caveat applies: likely an undercount (same-month-only
      // visibility), but real signal instead of a flag reading either near-zero or backwards.
      // EXTENDED 7 Jul 2026 (Michael, revisiting the earlier same-month-only decision after flagging
      // the conversion rate as "still looks low"): also count NEXT-MONTH lag matches — an enquiry
      // made this month often doesn't reach Reservation stage until the following month closes.
      // Confirmed via check:enq-reservation: same-month-only catches 2.7% (109/4004); adding
      // next-month lag brings it to 4.0% (162/4004) — real additional signal, not double-counting
      // (a lead only ever has one Reservation-stage row, so it can only match one of the two sets).
      // `nextC` is undefined for the live/in-progress current month (next month's data doesn't exist
      // yet) — that case naturally falls back to same-month-only matching, same as before.
      reservationConversions: (() => {
        const inquiryHashes = lf.inquiry_email_hashes;
        if (!Array.isArray(inquiryHashes) || !inquiryHashes.length) return lf.reservations || 0;
        const resHashes = new Set(lf.reservation_email_hashes || []);
        const nextResHashes = new Set(((nextC && nextC.lead_funnel) || {}).reservation_email_hashes || []);
        return inquiryHashes.filter((h) => resHashes.has(h) || nextResHashes.has(h)).length;
      })(),
      phone: lf.phone || 0, walkin: lf.walkin || 0, web: lf.web_combined || 0,
      webOnly: lf.web || 0, email: lf.email || 0,
      channels: lf.channels || {},
    },
    // chargeFromFinancial ADDED 6 Jul 2026: confirmed via the legacy portal's own tooltip
    // ("Financial Summary → total of merchandise charges") that Merchandise Sales is NOT sourced
    // from MerchandiseSummary (`me.sales`, dcChargeTotal) at all — it's FinancialSummary's own
    // merchandise charge category. These are two different SiteLink reports and can legitimately
    // disagree (MerchandiseSummary appears to track register/retail sales specifically;
    // FinancialSummary's category is whatever's coded on the tenant's ledger, which is broader/
    // different) — this is very likely why Merchandise Income per New Customer was reading ~£8+
    // higher than the legacy portal (confirmed, Michael 6 Jul 2026).
    // CORRECTED 6 Jul 2026 (same day, follow-up): the category is NOT literally named "Merchandise"
    // on this account's chart of categories — confirmed via npm run check:marketing-fields2 dumping
    // the full category list, which showed physical retail items (Large Box, Padlock, Tape - Roll,
    // Bubblewrap, etc.) filed under category code "POS" (Point of Sale), with zero categories
    // matching /merchandise/i. Filtering on the exact category code "POS" instead. Sourced from
    // `fin.categories` (always parsed, not gated behind `full`) so this is available even on the
    // light previous-month record for the flow-metric override below.
    merchandise: { sales: me.sales || 0, cost: me.cost || 0, margin: me.margin || 0, chargeFromFinancial: R2((fin.categories || []).filter((cat) => cat.category === 'POS').reduce((a, cat) => a + (cat.charge || 0), 0)) },
    revenue: { collected: (fin.total_charge || 0) - (fin.total_credit || 0), charge: fin.total_charge || 0, payment: fin.total_payment || 0, discount: fin.total_discount || 0 },
    rateChanges: { increases: rc.increases || 0, decreases: rc.decreases || 0, avgPct: rc.avg_increase_pct || 0 },
    marketing: { tenants: mk.tenants || 0, commercial: mk.commercial || 0, residential: mk.residential || 0, avgRent: mk.avg_rent || 0 },
    occD: 0, rentD: 0, areaD: 0,
  };
  if (full) {
    rec.vacant = o.vacant_units || 0; rec.unrentable = o.unrentable_units || 0;
    rec.unitTypes = o.unit_types || []; rec.unitMix = o.unit_mix || [];
    rec.customerType = rr.customer_type || null;
    // RECONCILED 9 Jul 2026 (Michael's decision, "do occupancy stats", after the "verify all widgets"
    // sweep): rr.customer_type's business.units+residential.units (RentRoll's own bRented-row count)
    // ran slightly ahead of occ (OccupancyStatistics' occupied_units) at 19/29 sites this period —
    // two different reports, never guaranteed to agree exactly, confirmed via the automated sweep.
    // Michael picked OccupancyStatistics (occ) as the trusted total — matches every other occupancy
    // figure on the portal (Dashboard, KPIs, etc, all sourced from `o`/occ, never from RentRoll's own
    // tenant count). Rather than let the Units by Customer Type table show a total that silently
    // disagrees with Occupied Units everywhere else, scale business/residential units/area/rent
    // proportionally so they sum to occ exactly — this preserves each segment's own units:area:rent
    // ratio (so its rate £/ft² is UNCHANGED by this, only the absolute totals shrink to match occ).
    // business.units rounds normally; residential.units takes the remainder so the two always sum to
    // occ exactly (never off by a rounding unit). No-ops whenever custTot already equals occ (the
    // other 10/29 sites, and any site once/if the two reports agree on their own).
    if (rec.customerType) {
      const biz = rec.customerType.business || { units: 0, area: 0, rent: 0 };
      const res = rec.customerType.residential || { units: 0, area: 0, rent: 0 };
      const custTot = (biz.units || 0) + (res.units || 0);
      if (custTot && custTot !== occ) {
        const scale = occ / custTot;
        const bizUnits = Math.round((biz.units || 0) * scale);
        rec.customerType = {
          business: { units: bizUnits, area: R2((biz.area || 0) * scale), rent: R2((biz.rent || 0) * scale), rate_per_sqft_ann: biz.rate_per_sqft_ann || 0 },
          residential: { units: occ - bizUnits, area: R2((res.area || 0) * scale), rent: R2((res.rent || 0) * scale), rate_per_sqft_ann: res.rate_per_sqft_ann || 0 },
        };
      }
    }
    rec.debtors.ageing = pd.ageing || null;
    rec.revenue.categories = fin.categories || [];
    rec.marketing.sources = mk.sources || [];
    rec.ss.rent = ss.monthly_rent || 0; rec.ss.gpot = ss.gross_potential || 0;
  }
  // True Revenue (custom report 781861, "Daily Pro Rate") — moved OUTSIDE the `if (full)` block 3 Jul
  // 2026: it's a full-calendar-month flow metric (like enquiries/moveIns), so the LIGHT previous-month
  // record needs it too so the override loop below can borrow the last COMPLETE month's figures —
  // matching the legacy portal, which always shows the last complete month for this widget, not the
  // 2-3 days of the in-progress current month.
  // Combine merchandise SKU line items into one "Merchandise" row (Michael, 6 Jul 2026) — True
  // Revenue by Description was listing every individual box/padlock/tape SKU as its own row. True
  // Revenue's own report has no category column of its own (only ChargeDesc/UnitType), so this
  // reuses the SAME POS-category classification already established for Merchandise Sales
  // (fin.categories' sChgCategory === 'POS', see `merchandise.chargeFromFinancial` below) to decide
  // which ChargeDesc labels are merchandise items.
  const posDescs = new Set((fin.categories || []).filter((c) => c.category === 'POS').map((c) => c.desc));
  const mergeByDesc = (rows, matches, mergedLabel) => {
    const out = []; let merged = null;
    for (const r of rows) {
      if (matches(r.desc)) {
        if (!merged) { merged = { ...r, desc: mergedLabel }; out.push(merged); }
        else for (const k of Object.keys(r)) if (k !== 'desc') merged[k] = R2((merged[k] || 0) + r[k]);
      } else out.push(r);
    }
    return out;
  };
  rec.trueRevenueByDesc = mergeByDesc(tr.by_desc || [], (d) => posDescs.has(d), 'Merchandise');
  // Combine electricity usage-tier charges into one "Electricity Charge" row (Michael, 6 Jul 2026) —
  // confirmed via npm run check:true-revenue-merge that SiteLink splits electricity recharges into
  // several separate ChargeDesc rows by usage band ("Electric Charge -100", "Electric Charge 100-149",
  // "Electric Charge 150+", "Electric Charge Metered") plus a legacy-labeled duplicate ("Electricity
  // Charge") — all the same underlying charge type, just billing-tier/label variants, same class of
  // clutter as the merchandise SKU merge above. NOT POS-tagged in FinancialSummary, so this needs its
  // own regex rule rather than reusing posDescs. Chained onto the already-merchandise-merged rows.
  rec.trueRevenueByDesc = mergeByDesc(rec.trueRevenueByDesc, (d) => /^electric/i.test(d), 'Electricity Charge');
  // Same class of clutter, confirmed by Michael (6 Jul 2026) as consistent/genuine duplicates rather
  // than distinct charge types — legacy-vs-current labels or recurring-vs-one-off billing splits of
  // the SAME underlying service, same treatment as Electricity Charge above:
  //   "Postbox Charge" / "MAILBOX"                        -> "Postbox Charge"
  //   "Extended Hours Access" / "Extended Hours One Off"  -> "Extended Hours Access"
  //   "Delivery Fee" / "Delivery Acceptance"               -> "Delivery Fee"
  //   "Service Fee" / "Service Charge"                     -> "Service Fee"
  rec.trueRevenueByDesc = mergeByDesc(rec.trueRevenueByDesc, (d) => /^(postbox charge|mailbox)$/i.test(d), 'Postbox Charge');
  rec.trueRevenueByDesc = mergeByDesc(rec.trueRevenueByDesc, (d) => /^extended hours/i.test(d), 'Extended Hours Access');
  rec.trueRevenueByDesc = mergeByDesc(rec.trueRevenueByDesc, (d) => /^delivery (fee|acceptance)$/i.test(d), 'Delivery Fee');
  rec.trueRevenueByDesc = mergeByDesc(rec.trueRevenueByDesc, (d) => /^service (fee|charge)$/i.test(d), 'Service Fee');
  // Combine Self Storage / Indoor Self Storage into one row for True Revenue by Unit Type (Michael,
  // 6 Jul 2026 — a display simplification for THIS widget only; every other widget, e.g. Occupancy/
  // Rate, keeps them distinct as separate SiteLink unit types, unchanged). Note this is the opposite
  // of the 3 Jul 2026 "match legacy portal's separate Drive Up/DriveUp/Drive up rows" decision — that
  // was about accidental data-entry duplicates; this is a deliberate, explicitly-requested merge of
  // two genuinely distinct-but-related types for readability.
  rec.trueRevenueByType = mergeByDesc(tr.by_type || [], (d) => d === 'Self Storage' || d === 'Indoor Self Storage', 'Self Storage');
  // Rental Activity (Unit Mix Detail page, added 3 Jul 2026) — same reasoning as True Revenue above:
  // MovedIn/MovedOut/Transfers/Net are full-calendar-month flow figures, so this needs to be on the
  // LIGHT previous-month record too, not gated behind `full`, so the override below can borrow June's
  // numbers instead of the in-progress current month's partial data.
  rec.rentalActivityByTypeSize = ra.by_type_size || [];
  // Discount Summary page + Move-in Variance KPI widget (ADDED 9 Jul 2026, Michael's "monthly flow" /
  // "build both" decisions — see lib/reportMap.js's `discounts` comment for the full source
  // investigation). Same full-calendar-month flow metric class as Rental Activity above — kept
  // outside `if (full)` so it's on the light previous-month record too. moveInVarianceCount/Sum are
  // raw (not pre-divided) — aggregateTotals()/mergeSiteAcrossRange() divide once, same
  // sum-then-divide-once rule as every other rate in this file.
  rec.discountPlans = disc.discount_plans || [];
  rec.moveInVarianceCount = disc.move_in_variance_count || 0;
  rec.moveInVarianceSum = disc.move_in_variance_sum || 0;
  rec.moveInVarianceAvg = rec.moveInVarianceCount ? R2(rec.moveInVarianceSum / rec.moveInVarianceCount) : 0;
  // Move-in Variance's whole-book half (management's var_from_std_rate, see reportMap.js) — a live
  // snapshot regardless of month, but kept here (not gated behind `full`) for consistency; it'll just
  // read the same "as of now" value on every month's light record until/unless SiteLink starts
  // supporting true historical "as of" reads for it.
  rec.varFromStdRate = mg.var_from_std_rate || [];
  return rec;
}

// AUTOBILL DAILY AVERAGE (ADDED 9 Jul 2026, Michael's decision after the Autobill Conversion
// investigation): rec.autobillNewCount above is a single point-in-time read — RentRoll has no true
// historical "as of" report (confirmed repeatedly this project), so whatever it said on the one day a
// month happened to close is really just one sample of a number that moves day to day. Confirmed
// legacy has the EXACT same volatility on its own equivalent widget (9 Jul 2026: switching legacy's
// own date filter from Jul-MTD to Jun 2026 moved ITS Bicester reading from 100% to 54%, matching
// neither of Michael's two prior readings — there is no stable target on either side to chase).
// Fix: lib/pull.js now writes one row per site per calendar day to the `autobill_daily` table (see
// supabase/schema.sql) for as long as that site's month is still the live CURRENT month; once the
// month closes/locks, sampling stops (same "closed months are frozen" rule as raw_report). The two
// functions below fetch those samples once per buildPayload()/buildPayloadRange() call and rewrite
// autobillNewCount to whatever count WOULD have produced the AVERAGE daily % against the month's real
// (already-final) move-in total — preserving the sum-then-divide-across-sites convention used
// everywhere else in this file (aggregateTotals, RANGE_SUM_FIELDS), just fed an averaged-across-days
// rate instead of one day's rate. A month with zero samples (everything before 9 Jul 2026, or a gap in
// pull history) silently keeps the old single-point value — there is no way to reconstruct daily
// history that was never captured; every pull before this overwrote the day before it
// (raw_report's unique (site_code,month,report) key retains only the latest).
async function fetchAutobillDailyMap(monthRange) {
  try {
    // FIXED 10 Jul 2026 (pre-go-live audit): was a single unpaginated .select(), the same bug class
    // already fixed once in fetchAllRaw() just below (6 Jul 2026) — Supabase/PostgREST caps an
    // unpaginated select at 1000 rows. This table accumulates ~1 row per site per pull (added 9 Jul
    // 2026, unfiltered call from buildPayload() below), so it crosses that cap within weeks at normal
    // pull cadence, at which point this would silently drop/reorder samples with zero warning and
    // corrupt the Autobill Conversion KPI. Paginated with the same .order('id').range() loop pattern.
    const out = []; const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      let q = admin.from('autobill_daily').select('site_code,month,pct').order('id').range(from, from + PAGE - 1);
      if (monthRange) q = q.gte('month', monthRange.start).lt('month', monthRange.endExclusive);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      out.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    const map = {};
    for (const r of out) {
      if (r.pct == null) continue;
      const mk = String(r.month).slice(0, 7);
      ((map[r.site_code] ??= {})[mk] ??= []).push(r.pct);
    }
    return map;
  } catch (e) {
    // Table not created yet (migration not run) or a transient read error — fall back to every
    // site/month keeping its existing single-point autobillNewCount rather than crash the whole
    // payload build over this one enhancement.
    console.error('[buildPayload] autobill_daily fetch failed (falling back to point-in-time):', e.message);
    return {};
  }
}
function applyAutobillDailyAverage(rec, monthKey, dailyMap) {
  const samples = dailyMap[rec.code] && dailyMap[rec.code][monthKey];
  if (!samples || !samples.length || !rec.autobillNewTotal) return;
  const avgPct = samples.reduce((a, p) => a + p, 0) / samples.length;
  rec.autobillNewCount = Math.round(avgPct / 100 * rec.autobillNewTotal);
}

// Supabase caps a select at 1000 rows; page through so long histories don't silently truncate.
// FIXED 6 Jul 2026: was missing .order() before .range() — Postgres/PostgREST does NOT guarantee a
// stable row order across separate paginated requests without an explicit ORDER BY, so as
// raw_report grew past ~30k rows (after the 96-month backfill), different pull/rebuild runs could
// silently return a different row for the same page window, causing rows to be skipped or
// duplicated between pages. This is very likely what caused Merchandise Sales/Insurance Conversion
// to compute correctly in a hand-rolled single-site test query but come out wrong (£0 for sites that
// definitely had data) from the real full 27-site fetchAllRaw() — and may also explain some of the
// earlier "most sites show 0" Ancillaries symptoms blamed solely on an interrupted pull. Ordering by
// `id` (the table's bigserial primary key) guarantees a stable, deterministic sort so pagination
// can't drop or duplicate rows.
async function fetchAllRaw(monthRange) {
  const out = []; const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = admin.from('raw_report')
      .select('site_code,month,report,data,pulled_at').in('report', ALL_REPORTS).order('id').range(from, from + PAGE - 1);
    // Optional server-side date filter (added 8 Jul 2026, Michael: portal briefly shows correct data
    // then reverts a few seconds later). buildPayload() calls this unfiltered — it genuinely needs
    // full history for `monthly`/`history`. buildPayloadRange() now passes its actual needed range
    // instead of scanning every row ever pulled: that full scan measured ~13-15s and growing with
    // every backfilled month, which was a wide-open window for a concurrent pull/repull write to land
    // mid-scan and produce an inconsistent read (fewer sites / stale sums) — exactly the symptom
    // reported. Narrowing this is the fix: less time scanning = less chance of catching a write
    // in-flight, plus the range view should just load near-instantly now regardless.
    if (monthRange) q = q.gte('month', monthRange.start).lt('month', monthRange.endExclusive);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// Load every stored raw_report row into a {site -> month -> report -> data} index, plus the sorted
// list of months that have real occupancy data. Extracted 6 Jul 2026 alongside aggregateTotals()/
// buildHistory() so buildPayloadRange() (global month/date-range selector) can share the exact same
// de-dupe/pagination-safety logic instead of a second hand-copied implementation. `monthRange`
// (optional, 8 Jul 2026) narrows the underlying fetchAllRaw() scan — see its comment above.
async function buildIndex(monthRange) {
  const { data: sitesRef } = await admin.from('sites').select('code,name');
  const nameOf = Object.fromEntries((sitesRef || []).map(s => [s.code, s.name]));
  for (const c of Object.keys(NAMES)) nameOf[c] = NAMES[c];   // authoritative names (fixes Bedford/Paulton etc.)

  const rows = await fetchAllRaw(monthRange);
  const idx = {}; const chosenAt = {};   // de-dupe: when two raw rows collapse to the same YYYY-MM
  for (const r of rows) {                 // (e.g. legacy end-of-month keys vs canonical -01 keys), keep the
    const mk = String(r.month).slice(0, 7);            // most-recently-pulled one so stale rows can't win.
    const key = `${r.site_code}|${mk}|${r.report}`, at = r.pulled_at || '';
    if (chosenAt[key] != null && !(at > chosenAt[key])) continue;
    chosenAt[key] = at;
    ((idx[r.site_code] ??= {})[mk] ??= {})[r.report] = r.data;
  }

  const monthsSet = new Set();
  for (const code of Object.keys(idx)) for (const mk of Object.keys(idx[code])) if (idx[code][mk].occupancy && idx[code][mk].occupancy.total_units > 0) monthsSet.add(mk);
  const months = [...monthsSet].sort();
  return { idx, nameOf, months };
}

// CHANGED 7 Jul 2026 (Michael, after comparing our July dashboard against the legacy portal's live
// July numbers): Enquiries/Move-ins/Move-outs and the other flow/count metrics below now show the
// CURRENT in-progress month's own real (partial) data, matching the legacy portal, instead of being
// silently overridden with the previous complete month's numbers. The previous approach (borrowing
// the prior month because a partial month "looks like near-zero/garbage") is REVERTED per explicit
// instruction to show real partial numbers even though they'll look low until the month closes.
export async function buildPayload(currentMonth, prevMonth) {
  const cur = ym(currentMonth), prev = ym(prevMonth);
  const { idx, nameOf, months } = await buildIndex();
  const autobillDailyMap = await fetchAutobillDailyMap();   // unfiltered — mirrors buildIndex()'s own full-history call above

  // LIGHT per-site record for every month
  const monthly = {};
  for (let mi = 0; mi < months.length; mi++) {
    const mk = months[mi], nextMk = months[mi + 1];
    monthly[mk] = Object.keys(idx).filter(code => idx[code][mk] && idx[code][mk].occupancy && idx[code][mk].occupancy.total_units > 0)
      .map(code => {
        const rec = recordFor(code, nameOf[code] || code, idx[code][mk], false, nextMk ? idx[code][nextMk] : undefined);
        applyAutobillDailyAverage(rec, mk, autobillDailyMap);
        return rec;
      });
  }
  // MoM deltas vs the previous month in the series
  for (let i = 0; i < months.length; i++) {
    const pm = months[i - 1]; if (!pm) continue;
    const prevByCode = Object.fromEntries(monthly[pm].map(r => [r.code, r]));
    for (const r of monthly[months[i]]) {
      const p = prevByCode[r.code]; if (!p) continue;
      r.occD = +(r.occPC - p.occPC).toFixed(1); r.rentD = r.rent - p.rent; r.areaD = r.occA - p.occA;
    }
  }

  // FULL detail for the current month. No nextC here — the current/live month has no "next month"
  // data yet, so its own reservationConversions falls back to same-month-only; that value gets
  // overwritten by the previous complete month's already-lag-corrected figure a few lines down anyway
  // (s.enquiries = p.enquiries).
  const sites = Object.keys(idx).filter(code => idx[code][cur] && idx[code][cur].occupancy && idx[code][cur].occupancy.total_units > 0)
    .map(code => {
      const rec = recordFor(code, nameOf[code] || code, idx[code][cur], true);
      applyAutobillDailyAverage(rec, cur, autobillDailyMap);
      return rec;
    });
  const prevByCode = monthly[prev] ? Object.fromEntries(monthly[prev].map(r => [r.code, r])) : {};
  for (const s of sites) {
    const p = prevByCode[s.code];
    if (!p) continue;
    s.occD = +(s.occPC - p.occPC).toFixed(1); s.rentD = s.rent - p.rent; s.areaD = s.occA - p.occA;
  }
  // SORTED BY SITE CODE 8 Jul 2026 (Michael: "organize each widget by store, bicester should be first
  // l001 and abington should be last l029, this includes the filter at the top") — was sorted by
  // occPC descending, which made every per-site table AND the top store-filter dropdown (built
  // straight off this same sites[] array in app/portal-v2/page.js's storeOptions) reorder themselves
  // every time occupancy changed, with no stable/predictable position for any given store. Codes are
  // consistently "L" + 3 digits (L001..L029) so a plain string compare sorts them numerically too.
  sites.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
  const totals = aggregateTotals(sites);

  return { generated_at: new Date().toISOString(), current_month: cur, prev_month: prev, months, sites, totals, history: buildHistory(months, monthly), monthly };
}

// Portfolio-wide rollup from a `sites[]` array (any set of full-detail site records — the current
// month's in normal use, or a range-merged set from buildPayloadRange() below). Extracted 6 Jul 2026
// so the global month/date-range selector can reuse the EXACT same sum-then-divide-once rules
// instead of a second hand-copied implementation drifting out of sync over time.
function aggregateTotals(sites) {
  const sum = (k) => sites.reduce((a, s) => a + (s[k] || 0), 0);
  const occA = sum('occA');
  const claA = sum('claA');
  // Portfolio Real Rate annualize factor — REVERTED 10 Jul 2026, see recordFor()'s matching comment:
  // 365/period_days is mathematically correct but moved every site ~3.04x further from Michael's
  // legacy targets (26% -> 207% avg error), meaning legacy's target isn't a properly-annualized
  // current-month-to-date figure. Back to plain 12 until that's confirmed. periodDaysSample kept
  // (computed, unused) so this is a one-line swap once we know what legacy actually represents.
  const periodDaysSample = sites.find((s) => s.trueRevenuePeriodDays)?.trueRevenuePeriodDays;
  const realRateAnnualizeFactor = 12;
  const totals = {
    n: sites.length, occ: sum('occ'), tot: sum('tot'), occA, claA, totA: sum('totA'), rent: sum('rent'), gpot: sum('gpot'), grossOcc: sum('grossOcc'),
    occPC: sum('tot') ? +(sum('occ') / sum('tot') * 100).toFixed(1) : 0, areaPC: sum('totA') ? +(occA / sum('totA') * 100).toFixed(1) : 0,
    // Portfolio "% of CLA" — the single authoritative occupancy-by-area figure. Falls back to
    // areaPC (occA/totA) only if no site reports a CLA area at all, matching the per-site rule
    // in recordFor() above (areaPC there = claA ? occA/claA : occA/totA).
    claPC: claA ? +(occA / claA * 100).toFixed(1) : (sum('totA') ? +(occA / sum('totA') * 100).toFixed(1) : 0),
    // Rate / Real Rate / SS variants: sum the RAW numerator + denominator across sites FIRST, then
    // divide once — per the locked spec, never average already-divided per-site rates.
    // Rate: dcStandardRate-based (unchanged, 8 Jul 2026 rent_roll parser correction).
    // Real Rate: REPLACED 8 Jul 2026 — True Revenue-based (see recordFor()'s trueRevenueNumerator
    // comment). rentSum/stdRentSum are kept as raw fields for reference but no longer feed Real Rate.
    rate: sum('areaSum') ? R2(sum('stdRentSum') / sum('areaSum') * 12) : 0,
    // Real Rate divides by TOTAL area (areaTotalAll, incl. vacant units) — NOT areaSum (occupied-only,
    // still correct for Rate above). Using areaSum here was the bug in the first pass at this fix.
    realRate: sum('areaTotalAll') ? R2(sum('trueRevenueNumerator') / sum('areaTotalAll') * realRateAnnualizeFactor) : 0,
    ssRate: sum('ssAreaSum') ? R2(sum('ssStdRentSum') / sum('ssAreaSum') * 12) : 0,
    ssReal: sum('ssAreaTotalAll') ? R2(sum('ssTrueRevenueNumerator') / sum('ssAreaTotalAll') * realRateAnnualizeFactor) : 0,
    // Indoor Self Storage / Offices occupancy widgets (per legacy portal tooltip, confirmed 2 Jul
    // 2026): occ/tot summed from Occupancy Statistics' per-type counts; rate summed from RentRoll's
    // per-type rent/area, sum-then-divide.
    ssOcc: sites.reduce((a, s) => a + (s.ss ? s.ss.occ : 0), 0), ssTot: sites.reduce((a, s) => a + (s.ss ? s.ss.tot : 0), 0),
    officesOcc: sites.reduce((a, s) => a + (s.offices ? s.offices.occ : 0), 0), officesTot: sites.reduce((a, s) => a + (s.offices ? s.offices.tot : 0), 0),
    officesRate: sum('officesAreaSum') ? R2(sum('officesRentSum') / sum('officesAreaSum') * 12) : 0,
  };
  totals.ssOccPC = totals.ssTot ? +(totals.ssOcc / totals.ssTot * 100).toFixed(1) : 0;
  totals.officesOccPC = totals.officesTot ? +(totals.officesOcc / totals.officesTot * 100).toFixed(1) : 0;
  // Debtor Levels — sum the Delinquency accounts/total and the Occupied Units/Actual Occupied Unit
  // Rates denominators first, then divide once (never average per-site percentages).
  const debtAccounts = sites.reduce((a, s) => a + (s.debtors ? s.debtors.accounts : 0), 0);
  const debtTotal = sites.reduce((a, s) => a + (s.debtors ? s.debtors.allOverdue : 0), 0);
  const occActualRentSum = sum('occActualRent');
  totals.debtorTenantPct = totals.occ ? +(debtAccounts / totals.occ * 100).toFixed(1) : 0;
  totals.debtorRentRollPct = occActualRentSum ? +(debtTotal / occActualRentSum * 100).toFixed(1) : 0;
  totals.debtorTotal = debtTotal;
  // Autobill Conversion — "new autobilled customers / total new customers" (legacy tooltip,
  // confirmed 2 Jul 2026), sum-then-divide across sites. NOT the whole-book autobill rate (kept
  // below as autobillPC_allTenants for reference/back-compat, no longer shown on the widget).
  const autobillNewCountSum = sum('autobillNewCount'), autobillNewTotalSum = sum('autobillNewTotal');
  totals.autobillPC = autobillNewTotalSum ? +(autobillNewCountSum / autobillNewTotalSum * 100).toFixed(1) : 0;
  const autobillCountSum = sum('autobillCount'), tenantsCountSum = sum('tenantsCount');
  totals.autobillPC_allTenants = tenantsCountSum ? +(autobillCountSum / tenantsCountSum * 100).toFixed(1) : 0;
  // Units / Rate per ft² by Customer Type — sum RentRoll's per-site business/residential units,
  // area and rent first, then divide once (customerType is only on the full/current-month `sites`
  // records — see recordFor()'s `if (full)` block).
  const custSum = (seg, k) => sites.reduce((a, s) => a + ((s.customerType && s.customerType[seg] && s.customerType[seg][k]) || 0), 0);
  const bizUnits = custSum('business', 'units'), resUnits = custSum('residential', 'units');
  const bizArea = custSum('business', 'area'), resArea = custSum('residential', 'area');
  const bizRent = custSum('business', 'rent'), resRent = custSum('residential', 'rent');
  const custTotUnits = bizUnits + resUnits;
  totals.customerType = {
    business: { units: bizUnits, pct: custTotUnits ? +(bizUnits / custTotUnits * 100).toFixed(1) : 0, rate: bizArea ? R2(bizRent / bizArea * 12) : 0 },
    residential: { units: resUnits, pct: custTotUnits ? +(resUnits / custTotUnits * 100).toFixed(1) : 0, rate: resArea ? R2(resRent / resArea * 12) : 0 },
  };
  // Reservations vs Move-outs — Reservations from ReservationList (CallCenterWs.asmx), Move-outs
  // from ScheduledMoveOuts (already on `scheduledOuts`). Both are simple portfolio-wide sums.
  // NOTE: reservationsActive/scheduledOuts are both confirmed live-only (see reportMap.js's
  // `reservations`/`scheduled_outs` comments and probe:scheduled-outs-historical).
  // STATUS 7 Jul 2026: back to being the primary source for the "Scheduled Reservations vs Scheduled
  // Move-outs" KPI widget (app/portal-v2/page.js) — reverted from the 6 Jul historical rebuild below
  // after confirming (a) legacy's own equivalent widget is also live-only, so a historical version was
  // never going to be comparable anyway, and (b) activeReservations' occupied-tenant-ID filter (see its
  // definition above) already resolved the old ~3x overcount task #25 was chasing — 438 now vs. the
  // ~446 target, not the buggy 1,420 from before that filter existed.
  totals.reservationsActive = sum('activeReservations');
  totals.scheduledOuts = sum('scheduledOuts');
  totals.reservationsNet = totals.reservationsActive - totals.scheduledOuts;
  // reservationsMade/reservationsMadeNet: the 6 Jul 2026 historical-rebuild metric (reservationsMade
  // from lead_funnel/InquiryTracking's reservation-stage row count, moveOuts from ManagementSummary).
  // No longer used by the KPI widget (see STATUS note above) but left wired up — still genuinely
  // date-scoped per month/range, so kept available for the custom widget builder / any future use that
  // specifically wants "reservations made this month" rather than "reservations open right now".
  totals.reservationsMade = sum('reservationsMade');
  totals.reservationsMadeNet = totals.reservationsMade - sum('moveOuts');
  // Insurance Roll (Ancillaries page) — sum premium/insured/rent/occ first, then divide once.
  const insurancePremiumSum = sum('insurancePremiumSum'), insuredUnitsSum = sum('insuredUnitsSum');
  totals.insurancePremium = insurancePremiumSum;
  totals.insurancePctRoll = totals.rent ? +(insurancePremiumSum / totals.rent * 100).toFixed(1) : 0;
  totals.insurancePctInsured = totals.occ ? +(insuredUnitsSum / totals.occ * 100).toFixed(1) : 0;

  // True Revenue (Financials page) — sum each site's per-ChargeDesc / per-UnitType rows by
  // matching label across sites, current month only (rec.trueRevenueByDesc/ByType are only on the
  // `sites` full-detail records, not `monthly`). Same sum-then-divide-nothing-here rule — these are
  // already £ totals, not rates, so straight addition is correct.
  const sumRevenueGroups = (field) => {
    const g = {};
    for (const s of sites) for (const row of (s[field] || [])) {
      const o = (g[row.desc] ??= { desc: row.desc, invoiced: 0, taxInvoiced: 0, taxAdj: 0, netTax: 0, deferred: 0, deferredPrev: 0, adj: 0, adjPrev: 0, truePeriod: 0 });
      o.invoiced += row.invoiced; o.taxInvoiced += row.taxInvoiced; o.taxAdj += row.taxAdj; o.netTax += row.netTax;
      o.deferred += row.deferred; o.deferredPrev += row.deferredPrev; o.adj += row.adj; o.adjPrev += row.adjPrev; o.truePeriod += row.truePeriod;
    }
    return Object.values(g).map((o) => { for (const k of Object.keys(o)) if (k !== 'desc') o[k] = R2(o[k]); return o; }).sort((a, b) => b.truePeriod - a.truePeriod);
  };
  totals.trueRevenueByDesc = sumRevenueGroups('trueRevenueByDesc');
  totals.trueRevenueByType = sumRevenueGroups('trueRevenueByType');

  // Rental Activity (new "Unit Mix Detail" page) — group every site's per-(type,unitSize) row by
  // that same (type,unitSize) key across the whole portfolio. Counts/areas/£ totals sum directly;
  // rates ($/area, occ%) are RECOMPUTED from the summed numerator/denominator afterward — never
  // averaged from each site's own per-row rate — same rule as every other rollup in this file.
  const rentalActivityRows = (() => {
    const g = {};
    for (const s of sites) for (const row of (s.rentalActivityByTypeSize || [])) {
      const key = `${row.type}|${row.unitSize}`;
      const o = (g[key] ??= {
        type: row.type, unitSize: row.unitSize, area: row.area, standardRate: row.standardRate,
        totalUnits: 0, occupied: 0, vacant: 0, occupiedRent: 0, movedIn: 0, movedOut: 0,
        netTransferred: 0, transfers: 0, net: 0, totalArea: 0, occupiedArea: 0, vacantArea: 0,
        netArea: 0, grossPotential: 0,
      });
      o.totalUnits += row.totalUnits; o.occupied += row.occupied; o.vacant += row.vacant;
      o.occupiedRent += row.occupiedRent; o.movedIn += row.movedIn; o.movedOut += row.movedOut;
      o.netTransferred += row.netTransferred; o.transfers += row.transfers; o.net += row.net;
      o.totalArea += row.totalArea; o.occupiedArea += row.occupiedArea; o.vacantArea += row.vacantArea;
      o.netArea += row.netArea; o.grossPotential += row.grossPotential;
    }
    return Object.values(g).map((o) => ({
      ...o,
      occPct: o.totalUnits ? +(o.occupied / o.totalUnits * 100).toFixed(1) : 0,
      vacPct: o.totalUnits ? +(o.vacant / o.totalUnits * 100).toFixed(1) : 0,
      totalDollarPerArea: o.totalArea ? R2(o.grossPotential / o.totalArea * 12) : 0,
      occupiedDollarPerArea: o.occupiedArea ? R2(o.occupiedRent / o.occupiedArea * 12) : 0,
      occupiedRent: R2(o.occupiedRent), grossPotential: R2(o.grossPotential),
    })).sort((a, b) => a.area - b.area);
  })();
  totals.rentalActivityByTypeSize = rentalActivityRows;

  // Discount Summary (added 9 Jul 2026) — group every site's per-plan row by plan name across the
  // whole portfolio. Units/discount sum directly (a unit belongs to exactly one site — no cross-site
  // double-count risk), same grouping pattern as Rental Activity above.
  const discountPlanRows = (() => {
    const g = {};
    for (const s of sites) for (const row of (s.discountPlans || [])) {
      const o = (g[row.plan] ??= { plan: row.plan, units: 0, discount: 0 });
      o.units += row.units; o.discount += row.discount;
    }
    return Object.values(g).map((o) => ({ ...o, discount: R2(o.discount) })).sort((a, b) => b.units - a.units);
  })();
  totals.discountPlans = discountPlanRows;

  // Move-in Variance vs Standard Rate (added 9 Jul 2026, Michael's "build both" decision).
  // This-period half: sum count + variance across sites first, divide once — never average each
  // site's own already-divided average. Whole-book half (VarFromStdRate): bucket counts summed
  // across sites — a straight count, no division involved. Bucket order preserved via SortID (added
  // to the reportMap.js parser specifically so this doesn't depend on object-key insertion order).
  totals.moveInVarianceCount = sum('moveInVarianceCount');
  const moveInVarianceSumTotal = sum('moveInVarianceSum');
  totals.moveInVarianceAvg = totals.moveInVarianceCount ? R2(moveInVarianceSumTotal / totals.moveInVarianceCount) : 0;
  const varFromStdRateBuckets = (() => {
    const g = {};
    for (const s of sites) for (const b of (s.varFromStdRate || [])) {
      const o = (g[b.bucket] ??= { bucket: b.bucket, count: 0, sortId: b.sortId });
      o.count += b.count || 0;
    }
    return Object.values(g).sort((a, b) => a.sortId - b.sortId);
  })();
  totals.varFromStdRate = varFromStdRateBuckets;
  return totals;
}

// portfolio trend (one point per month) for Month-on-Month. Same rule as totals above: sum the
// raw dcRent/dcStandardRate/area numerators+denominators first, then divide once. Extracted 6 Jul
// 2026 alongside aggregateTotals() — buildPayloadRange() below doesn't need this (a range only ever
// shows one merged "current" snapshot, not its own trend line), but kept as a named function so
// buildPayload() reads top-to-bottom the same as before.
function buildHistory(months, monthly) {
  return months.map((mk) => {
    const recs = monthly[mk]; const s = (k) => recs.reduce((a, r) => a + (r[k] || 0), 0);
    const oa = s('occA'); const ssoa = recs.reduce((a, r) => a + (r.ss ? r.ss.occA : 0), 0);
    // Task #130/#136 (13 Jul 2026, Michael: Marketing Year-on-Year, chosen format = trend chart) —
    // enquiries were never carried into the per-month history point before (only Month-on-Month's six
    // charts read this array, and none of them needed lead_funnel). lead_funnel has ~10 years of
    // backfilled history (see scripts/check-leadfunnel-coverage.js, task #185), so a same-month-last-
    // year lookup is just "read this same array 12 entries back" — no separate query needed. Sum-then-
    // divide for enqConvPct: this is a SINGLE month's own rate (not a merged multi-month range), so
    // reservationConversions/total for THIS month is already correct with no averaging-bug risk (the
    // sum-then-divide RULE in this file is about not averaging already-divided per-month %s together
    // when collapsing several months into one — see mergeRowsAcrossMonths' and aggregateTotals'
    // comments — a single point isn't at risk of that).
    const enqTotal = recs.reduce((a, r) => a + (r.enquiries ? r.enquiries.total : 0), 0);
    const enqReservationConversions = recs.reduce((a, r) => a + (r.enquiries ? r.enquiries.reservationConversions : 0), 0);
    return {
      month: mk, occ: s('occ'), tot: s('tot'), occPC: s('tot') ? +(s('occ') / s('tot') * 100).toFixed(1) : 0, occA: oa, rent: s('rent'), ssOccA: ssoa,
      // SWAPPED 8 Jul 2026 — see aggregateTotals()'s matching note above.
      rate: s('areaSum') ? R2(s('stdRentSum') / s('areaSum') * 12) : 0,
      ssRate: s('ssAreaSum') ? R2(s('ssStdRentSum') / s('ssAreaSum') * 12) : 0,
      revenue: recs.reduce((a, r) => a + (r.revenue ? r.revenue.collected : 0), 0),
      moveIns: s('moveIns'), moveOuts: s('moveOuts'),   // moveOuts added for Customer Churn (trailing 12mo moveOuts / avg occ) once backfill gives >=12 months
      insured: recs.reduce((a, r) => a + (r.insurance ? r.insurance.insured : 0), 0),
      insurancePremium: s('insurancePremiumSum'),   // Month-on-Month "Insurance Roll" trend
      enqTotal, enqReservationConversions,   // Marketing YoY trend (task #136) — total enquiries + reservation-stage conversions, portfolio-wide
      enqPhone: recs.reduce((a, r) => a + (r.enquiries ? r.enquiries.phone : 0), 0),
      enqWeb: recs.reduce((a, r) => a + (r.enquiries ? r.enquiries.web : 0), 0),
      enqWalkin: recs.reduce((a, r) => a + (r.enquiries ? r.enquiries.walkin : 0), 0),
      enqConvPct: enqTotal ? +(enqReservationConversions / enqTotal * 100).toFixed(1) : 0,
    };
  });
}

// Snapshot-style fields (point-in-time headcounts/areas/£ — don't accumulate over a period) are
// AVERAGED across the months in a selected range. Flow-style fields (full-calendar-month totals)
// are SUMMED instead — see FLOW_SUM_FIELDS below. Per Michael, 6 Jul 2026: averaging (not just
// showing the range's last month) was the explicit choice for how Occupancy/Rate/Debtor Levels
// should behave when a multi-month range is selected.
const RANGE_AVG_FIELDS = [
  'occ', 'tot', 'occA', 'claA', 'totA', 'rent', 'grossOcc', 'gpot', 'rpu', 'occActualRent',
  'rentSum', 'stdRentSum', 'areaSum', 'ssRentSum', 'ssStdRentSum', 'ssAreaSum', 'officesRentSum', 'officesAreaSum',
  'trueRevenueNumerator', 'ssTrueRevenueNumerator', 'areaTotalAll', 'ssAreaTotalAll',
  'autobillRate', 'avgStayDays', 'autobillCount', 'tenantsCount',
  'activeReservations', 'reservedSqftEstimate', 'scheduledOuts',
];
// Flow/count metrics for a full calendar month (Enquiries, Move-ins/outs, Merchandise, Insurance new
// customers, Autobill new customers, InquiryTracking's own `reservations` conversion count) — these
// genuinely accumulate over a period, so a 3-month range should show 3 months' worth, not an average
// of 3 monthly totals.
const RANGE_SUM_FIELDS = ['moveIns', 'moveOuts', 'netArea', 'moveOutsYear', 'moveInAreaSum', 'moveOutAreaSum', 'moveInRateSum', 'autobillNewCount', 'autobillNewTotal', 'reservations', 'reservationsMade'];

const avgOf = (recs, get) => { const n = recs.length || 1; return recs.reduce((a, r) => a + (get(r) || 0), 0) / n; };
const sumOf = (recs, get) => recs.reduce((a, r) => a + (get(r) || 0), 0);

// Merge every site's per-(ChargeDesc) or per-(Type,UnitSize) row across the months in range by
// summing (same rule as sumRevenueGroups()/rentalActivityByTypeSize above — these are always flow
// totals, never point-in-time). `keyOf` extracts the grouping key from a row.
// FIXED 8 Jul 2026 (Michael, via screenshot: our True Revenue table's "Jul 2026" totals were ~2.0-
// 2.06x every one of legacy's column totals — Invoiced, Deferred Revenue, True Period, all of them,
// uniformly). Root cause: `const o = (g[k] ??= { ...row })` followed by `if (o !== row)` — a spread
// copy `{...row}` is ALWAYS a new object, so `o !== row` was true even on a key's FIRST row, meaning
// every group's first contributing row got added to its own already-identical copy once — an
// unconditional double-count, not a data or formula issue. For a single selected month (the common
// case, recs.length === 1) this doubled literally every row of trueRevenueByDesc/trueRevenueByType
// (Financials page's True Revenue tables) and rentalActivityByTypeSize (Unit Mix Detail page) —
// confirmed by hand-tracing concrete numbers, not by guessing. For a genuine multi-month range it was
// worse and asymmetric: 2*firstMonth + secondMonth + ... Does NOT affect Real Rate (trueRevenueNumerator
// is a plain averaged scalar via RANGE_AVG_FIELDS/avgOf, never routed through this function). Fixed by
// tracking whether a key is new BEFORE the `??=` assignment, instead of comparing object identity
// after a copy has already been made.
function mergeRowsAcrossMonths(recs, field, keyOf, numericKeys) {
  const g = {};
  for (const rec of recs) for (const row of (rec[field] || [])) {
    const k = keyOf(row);
    const isFirst = !(k in g);
    const o = (g[k] ??= { ...row });
    if (!isFirst) for (const nk of numericKeys) o[nk] = R2((o[nk] || 0) + (row[nk] || 0));
  }
  return Object.values(g);
}

// One merged, full-detail site record for a from/to month range (inclusive) — same shape recordFor()
// returns for a single month, so every existing widget reads it with zero changes.
function mergeSiteAcrossRange(recs) {
  const last = recs[recs.length - 1];
  const rec = JSON.parse(JSON.stringify(last));   // start from the LAST month's record — anything not
  // explicitly re-aggregated below (unitTypes/unitMix/debtors.ageing/revenue.categories/marketing.sources,
  // plus name/code) simply falls back to a last-month snapshot. Known v1 limitation, not yet range-aware.

  for (const k of RANGE_AVG_FIELDS) rec[k] = avgOf(recs, (r) => r[k]);
  for (const k of RANGE_SUM_FIELDS) rec[k] = sumOf(recs, (r) => r[k]);

  rec.ss = {
    occ: avgOf(recs, (r) => r.ss && r.ss.occ), tot: avgOf(recs, (r) => r.ss && r.ss.tot),
    occA: avgOf(recs, (r) => r.ss && r.ss.occA), rate: 0, real: 0,
  };
  rec.offices = { occ: avgOf(recs, (r) => r.offices && r.offices.occ), tot: avgOf(recs, (r) => r.offices && r.offices.tot), rate: 0 };
  rec.debtors = {
    ...rec.debtors,
    total: avgOf(recs, (r) => r.debtors && r.debtors.total), accounts: avgOf(recs, (r) => r.debtors && r.debtors.accounts),
    allOverdue: avgOf(recs, (r) => r.debtors && r.debtors.allOverdue), tenantPct: 0, rentRollPct: 0,
  };
  const insuredAvg = avgOf(recs, (r) => r.insurance && r.insurance.insured), premiumAvg = avgOf(recs, (r) => r.insurance && r.insurance.premium);
  rec.insurance = { insured: insuredAvg, premium: premiumAvg, penetration: 0 };
  rec.insurancePremiumSum = premiumAvg; rec.insuredUnitsSum = insuredAvg;
  rec.insuranceActivity = {
    newPolicies: sumOf(recs, (r) => r.insuranceActivity && r.insuranceActivity.newPolicies),
    newPremium: sumOf(recs, (r) => r.insuranceActivity && r.insuranceActivity.newPremium),
    cancellations: sumOf(recs, (r) => r.insuranceActivity && r.insuranceActivity.cancellations),
  };
  rec.insuredNewCustomers = {
    count: sumOf(recs, (r) => r.insuredNewCustomers && r.insuredNewCustomers.count),
    premiumSum: R2(sumOf(recs, (r) => r.insuredNewCustomers && r.insuredNewCustomers.premiumSum)),
    coverageSum: R2(sumOf(recs, (r) => r.insuredNewCustomers && r.insuredNewCustomers.coverageSum)),
  };
  rec.merchandise = {
    sales: R2(sumOf(recs, (r) => r.merchandise && r.merchandise.sales)), cost: R2(sumOf(recs, (r) => r.merchandise && r.merchandise.cost)),
    margin: R2(sumOf(recs, (r) => r.merchandise && r.merchandise.margin)), chargeFromFinancial: R2(sumOf(recs, (r) => r.merchandise && r.merchandise.chargeFromFinancial)),
  };
  const bizUnits = avgOf(recs, (r) => r.customerType && r.customerType.business && r.customerType.business.units);
  const resUnits = avgOf(recs, (r) => r.customerType && r.customerType.residential && r.customerType.residential.units);
  // area/rent here are point-in-time snapshots (like areaSum/rentSum above), so they're AVERAGED
  // across the range, not summed — matching RANGE_AVG_FIELDS' convention (Michael, 6 Jul 2026).
  const bizArea = avgOf(recs, (r) => r.customerType && r.customerType.business && r.customerType.business.area);
  const resArea = avgOf(recs, (r) => r.customerType && r.customerType.residential && r.customerType.residential.area);
  const bizRent = avgOf(recs, (r) => r.customerType && r.customerType.business && r.customerType.business.rent);
  const resRent = avgOf(recs, (r) => r.customerType && r.customerType.residential && r.customerType.residential.rent);
  // FIXED 7 Jul 2026 (Michael, "rate per ft² by customer type chart shows 0"): this block's per-site
  // `rate` was already correct (confirmed live — e.g. L001 business £30.17, matching the single-month
  // path exactly), but the object never carried `area`/`rent` — only `units`/`pct`/`rate`. Portfolio-
  // level aggregateTotals()/custSum() (below, ~line 463) sums each site's customerType.business/
  // residential .area and .rent to sum-then-divide-once at the portfolio level (never average
  // pre-divided per-site rates, same convention as ssAreaSum/ssRentSum etc.) — with no `area`/`rent`
  // keys present, that sum was always 0 across every site, so the PORTFOLIO total's rate fell back to
  // 0 even though every individual site's own rate was fine. Adding the raw sums back fixes it.
  rec.customerType = {
    business: { units: bizUnits, area: bizArea, rent: bizRent, pct: 0, rate: bizArea ? R2(bizRent / bizArea * 12) : 0 },
    residential: { units: resUnits, area: resArea, rent: resRent, pct: 0, rate: resArea ? R2(resRent / resArea * 12) : 0 },
  };
  rec.enquiries = {
    total: sumOf(recs, (r) => r.enquiries && r.enquiries.total),
    conversions: sumOf(recs, (r) => r.enquiries && r.enquiries.conversions),
    reservationConversions: sumOf(recs, (r) => r.enquiries && r.enquiries.reservationConversions),
    phone: sumOf(recs, (r) => r.enquiries && r.enquiries.phone), walkin: sumOf(recs, (r) => r.enquiries && r.enquiries.walkin), web: sumOf(recs, (r) => r.enquiries && r.enquiries.web),
    webOnly: sumOf(recs, (r) => r.enquiries && r.enquiries.webOnly), email: sumOf(recs, (r) => r.enquiries && r.enquiries.email),
    channels: (() => {
      const g = {};
      for (const r of recs) for (const [label, v] of Object.entries((r.enquiries && r.enquiries.channels) || {})) {
        const o = (g[label] ??= { enquiries: 0, converted: 0 }); o.enquiries += v.enquiries || 0; o.converted += v.converted || 0;
      }
      return g;
    })(),
  };
  rec.trueRevenueByDesc = mergeRowsAcrossMonths(recs, 'trueRevenueByDesc', (r) => r.desc, ['invoiced', 'taxInvoiced', 'taxAdj', 'netTax', 'deferred', 'deferredPrev', 'adj', 'adjPrev', 'truePeriod']);
  rec.trueRevenueByType = mergeRowsAcrossMonths(recs, 'trueRevenueByType', (r) => r.desc, ['invoiced', 'taxInvoiced', 'taxAdj', 'netTax', 'deferred', 'deferredPrev', 'adj', 'adjPrev', 'truePeriod']);
  rec.rentalActivityByTypeSize = mergeRowsAcrossMonths(recs, 'rentalActivityByTypeSize', (r) => `${r.type}|${r.unitSize}`,
    ['totalUnits', 'occupied', 'vacant', 'occupiedRent', 'movedIn', 'movedOut', 'netTransferred', 'transfers', 'net', 'totalArea', 'occupiedArea', 'vacantArea', 'netArea', 'grossPotential']);
  // Discount Summary (added 9 Jul 2026) — sum each plan's units/discount across the range's months,
  // same merge-by-key pattern as trueRevenueByDesc/rentalActivityByTypeSize above.
  rec.discountPlans = mergeRowsAcrossMonths(recs, 'discountPlans', (r) => r.plan, ['units', 'discount']);
  // Move-in Variance vs Standard Rate, this-period half — sum raw count/variance across the range's
  // months first, divide once (never average each month's own already-divided average).
  rec.moveInVarianceCount = sumOf(recs, (r) => r.moveInVarianceCount);
  rec.moveInVarianceSum = R2(sumOf(recs, (r) => r.moveInVarianceSum));
  // varFromStdRate (whole-book half) intentionally NOT re-aggregated here — it's a live "as of now"
  // snapshot regardless of month (see reportMap.js's comment), so it just inherits the last month's
  // value from `rec`'s initial deep-copy at the top of this function, same as unitTypes/debtors.ageing.

  // Recompute every derived rate/percentage from the range-aggregated raw sums, exactly mirroring
  // recordFor()'s own formulas — never trust an averaged/summed already-divided rate.
  rec.rpu = rec.occ ? R2(rec.rent / rec.occ) : 0;
  rec.occPC = rec.tot ? +(rec.occ / rec.tot * 100).toFixed(1) : 0;
  rec.areaPC = rec.claA ? +(rec.occA / rec.claA * 100).toFixed(1) : (rec.totA ? +(rec.occA / rec.totA * 100).toFixed(1) : 0);
  rec.areaPCmla = rec.totA ? +(rec.occA / rec.totA * 100).toFixed(1) : 0;
  // SWAPPED 8 Jul 2026 — see the matching note in aggregateTotals() above / reportMap.js's rent_roll parser.
  rec.rate = rec.areaSum ? R2(rec.stdRentSum / rec.areaSum * 12) : 0;
  // REPLACED 8 Jul 2026 — True Revenue-based, divided by TOTAL area not occupied area (see
  // recordFor()'s trueRevenueNumerator comment for why areaSum/ssAreaSum would be wrong here).
  rec.realRate = rec.areaTotalAll ? R2(rec.trueRevenueNumerator / rec.areaTotalAll * 12) : 0;
  rec.ssRate = rec.ssAreaSum ? R2(rec.ssStdRentSum / rec.ssAreaSum * 12) : 0;
  rec.ssReal = rec.ssAreaTotalAll ? R2(rec.ssTrueRevenueNumerator / rec.ssAreaTotalAll * 12) : 0;
  rec.ss.occPC = rec.ss.tot ? +(rec.ss.occ / rec.ss.tot * 100).toFixed(1) : 0; rec.ss.rate = rec.ssRate; rec.ss.real = rec.ssReal;
  rec.offices.occPC = rec.offices.tot ? +(rec.offices.occ / rec.offices.tot * 100).toFixed(1) : 0;
  rec.offices.rate = rec.officesAreaSum ? R2(rec.officesRentSum / rec.officesAreaSum * 12) : 0;
  rec.debtors.tenantPct = rec.occ ? +(rec.debtors.accounts / rec.occ * 100).toFixed(1) : 0;
  rec.debtors.rentRollPct = rec.occActualRent ? +(rec.debtors.allOverdue / rec.occActualRent * 100).toFixed(1) : 0;
  rec.insurance.penetration = rec.occ ? +(rec.insurance.insured / rec.occ * 100).toFixed(1) : 0;
  const custTot = rec.customerType.business.units + rec.customerType.residential.units;
  rec.customerType.business.pct = custTot ? +(rec.customerType.business.units / custTot * 100).toFixed(1) : 0;
  rec.customerType.residential.pct = custTot ? +(rec.customerType.residential.units / custTot * 100).toFixed(1) : 0;
  rec.moveInVarianceAvg = rec.moveInVarianceCount ? R2(rec.moveInVarianceSum / rec.moveInVarianceCount) : 0;
  rec.occD = 0; rec.rentD = 0; rec.areaD = 0;   // MoM deltas don't apply to a multi-month range
  return rec;
}

// Cheap helper for diagnostics/scripts that just need to know which months have data, without
// paying for a full multi-month buildPayloadRange() aggregation.
export async function listStoredMonths() {
  const { months } = await buildIndex();
  return months;
}

// Global month/date-range selector (Michael, 6 Jul 2026): build a full payload for an ARBITRARY
// from/to month range instead of always the live current month, reading only already-stored
// raw_report data (no SiteLink calls, no writes to portal_payload — this is called live per-request
// from the API route, never persisted). from === to behaves like a single-month view. Returns the
// exact same `sites`/`totals` shape as buildPayload() so no widget needs to change.
export async function buildPayloadRange(fromMonth, toMonth) {
  const from = ym(fromMonth), to = ym(toMonth);
  // Only ask the DB for months this call can possibly use: the selected range, plus one extra
  // calendar month past `to` so the reservationConversions next-month-lag match (below) still has
  // its lookahead data for the last month in range. See fetchAllRaw()'s comment for why this matters.
  const afterTo = new Date(toMonth.getFullYear(), toMonth.getMonth() + 2, 1);
  const monthRange = {
    start: `${fromMonth.getFullYear()}-${String(fromMonth.getMonth() + 1).padStart(2, '0')}-01`,
    endExclusive: `${afterTo.getFullYear()}-${String(afterTo.getMonth() + 1).padStart(2, '0')}-01`,
  };
  const { idx, nameOf, months } = await buildIndex(monthRange);
  const rangeMonths = months.filter((mk) => mk >= from && mk <= to);
  if (!rangeMonths.length) {
    return { generated_at: new Date().toISOString(), current_month: to, prev_month: null, months, sites: [], totals: null, history: [], monthly: {}, range: { from, to, months: rangeMonths } };
  }
  const autobillDailyMap = await fetchAutobillDailyMap(monthRange);

  // REVERTED 7 Jul 2026 (Michael): the current in-progress month now always uses its own real
  // (partial) flow-metric data here too, matching buildPayload()'s default view — no more borrowing
  // the previous complete month's numbers for Enquiries/Move-ins/Move-outs/etc.

  const codes = Object.keys(idx).filter((code) => rangeMonths.some((mk) => idx[code][mk] && idx[code][mk].occupancy && idx[code][mk].occupancy.total_units > 0));
  const sites = codes.map((code) => {
    // nextC for the lag-match uses the GLOBAL month series (not just rangeMonths) so a range's last
    // month still gets a correct lag match against the month right after it, even if that following
    // month falls outside the selected range.
    const recs = rangeMonths.filter((mk) => idx[code][mk] && idx[code][mk].occupancy && idx[code][mk].occupancy.total_units > 0)
      .map((mk) => {
        const nextMk = months[months.indexOf(mk) + 1];
        const rec = recordFor(code, nameOf[code] || code, idx[code][mk], true, nextMk ? idx[code][nextMk] : undefined);
        applyAutobillDailyAverage(rec, mk, autobillDailyMap);
        return rec;
      });
    return recs.length ? mergeSiteAcrossRange(recs) : null;
  }).filter(Boolean);
  // SORTED BY SITE CODE 8 Jul 2026 (Michael: "organize each widget by store, bicester should be first
  // l001 and abington should be last l029, this includes the filter at the top") — was sorted by
  // occPC descending, which made every per-site table AND the top store-filter dropdown (built
  // straight off this same sites[] array in app/portal-v2/page.js's storeOptions) reorder themselves
  // every time occupancy changed, with no stable/predictable position for any given store. Codes are
  // consistently "L" + 3 digits (L001..L029) so a plain string compare sorts them numerically too.
  sites.sort((a, b) => (a.code || '').localeCompare(b.code || ''));

  const totals = aggregateTotals(sites);
  return {
    generated_at: new Date().toISOString(), current_month: to, prev_month: rangeMonths.length >= 2 ? rangeMonths[rangeMonths.length - 2] : null,
    months, sites, totals, history: [], monthly: {}, range: { from, to, months: rangeMonths },
  };
}
