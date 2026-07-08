// Report map — CONFIRMED method names from the SiteLink Reporting API doc.
// NOTE: the doc lists each method's PARAMETERS but not its success COLUMN names ("the DataSet
// will contain the report information"). So the calls are correct now; the column→field mapping
// in parse() is best-effort and gets finalised from the first real DataSet (run
// `npm run test:connection`, which prints the columns). parse() never stores tenant PII —
// only aggregated numbers.
import { callReport, callReservationList, callCustomReport, extractNamedTable } from './sitelink.js';
import { createHash } from 'crypto';

// One-way hash for cross-referencing by email WITHOUT ever storing the actual address anywhere
// (raw_report/portal_payload rows are persisted to Supabase — real email addresses must never land
// there). Lowercased + trimmed first so the same address always hashes identically regardless of
// casing/whitespace differences between reports. Returns null for blank emails (never hash '').
const emailHash = (v) => {
  const e = String(v ?? '').trim().toLowerCase();
  if (!e) return null;
  return createHash('sha256').update(e).digest('hex');
};

const num = (row, ...keys) => {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== '') {
      const n = Number(String(row[k]).replace(/[£,%\s]/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
};
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));   // SiteLink bit fields: "1"/"true"
const str = (v) => String(v ?? '').trim();
// Proper round-half-up to 2dp. Plain `.toFixed(2)` uses the number's raw binary floating-point
// representation, which for values like 28.005 is actually stored as 28.00499999999999... —
// so `.toFixed(2)` silently rounds DOWN to "28.00" instead of the mathematically correct "28.01".
// Nudging by Number.EPSILON before rounding corrects this without affecting any value that was
// already exact. Confirmed 2 Jul 2026 (Michael): rent/rate figures were consistently rounding
// down instead of to-nearest-hundredth — this was the cause.
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// key -> { method (confirmed), dated, parse(rows) -> aggregated no-PII object }
export const REPORTS = {
  // OccupancyStatistics returns one row PER UnitType×UnitSize per site. Confirmed columns:
  // UnitType, Area (per-unit sqft), TotalArea, Occupied, TotalUnits, StandardRate, GrossPotential,
  // GrossOccupied (std rate × occupied), ActualOccupied (actual billed rent of occupied units).
  // RATE METHOD (verified against the live portal): "Self Storage Rate" and "Total Rate" are the
  // simple UNWEIGHTED AVERAGE of each occupied unit-SIZE's £/ft² (ActualOccupied/Occupied / Area ×12),
  // NOT area-weighted. SS = Indoor Self Storage unit type only. Confirmed: Bicester SS £29.74 /
  // Total £28.46, Gillingham SS £32.09. (Area-weighted gave £28.08 — wrong.)
  // RATE METHODS (locked 17 Jun 2026 against the live portal, area-weighted):
  //   "Rate per ft²"      (asking)  = Σ GrossOccupied  ÷ Σ occupied_area × 12   [standard rent of occupied units]
  //   "Real Rate per ft²" (actual)  = Σ ActualOccupied ÷ Σ occupied_area × 12   [billed rent, net of concessions]
  // SS = "Indoor Self Storage" unit type only; Total = all unit types.
  // Verified Bicester (L001, May): Real SS £27.69≈live £27.53, Real Total £26.81≈£26.48 (<1%).
  // Asking reads ~2-3% above R6 (their exact asking-rate formula is private WordPress PHP); occupancy/
  // units/area/unit-mix tie out exactly. Per-unit-SIZE rows kept for the Unit Mix Occupancy table.
  occupancy: { method: 'OccupancyStatistics', dated: true, parse: (rows) => {
    const isSS = (t) => /self.?storage/i.test(t || '');
    const R = Math.round;
    const rate = (g, ar) => ar ? R2((g / ar) * 12) : 0;     // monthly £ → annual £/ft²
    let occ = 0, tot = 0, vac = 0, unrent = 0, occArea = 0, claArea = 0, mlaArea = 0, gpot = 0, grossOcc = 0, actOcc = 0;
    const types = {};      // per unit type
    const ssSizes = {};    // Indoor Self Storage grouped by rounded area (drives the Unit Mix table)
    for (const r of rows) {
      const t = (r.UnitType || 'Other').trim();
      const a = num(r, 'Area');                          // per-unit area for this size
      const o = num(r, 'Occupied'), tu = num(r, 'TotalUnits'), vc = num(r, 'Vacant'), un = num(r, 'Unrentable');
      const go = num(r, 'GrossOccupied'), ao = num(r, 'ActualOccupied'), gp = num(r, 'GrossPotential');
      const oa = a * o, cla = a * (tu - un), mla = a * tu;
      occ += o; tot += tu; vac += vc; unrent += un;
      occArea += oa; claArea += cla; mlaArea += mla; gpot += gp; grossOcc += go; actOcc += ao;
      const T = (types[t] ??= { unit_type: t, occ: 0, tot: 0, occ_area: 0, cla_area: 0, mla_area: 0, gross_occ: 0, act_occ: 0, gpot: 0 });
      T.occ += o; T.tot += tu; T.occ_area += oa; T.cla_area += cla; T.mla_area += mla; T.gross_occ += go; T.act_occ += ao; T.gpot += gp;
      if (isSS(t) && a > 0) { const k = String(R(a)); const S = (ssSizes[k] ??= { area: R(a), occ: 0, tot: 0, occ_area: 0, total_area: 0 }); S.occ += o; S.tot += tu; S.occ_area += oa; S.total_area += mla; }
    }
    let ssOcc = 0, ssTot = 0, ssOA = 0, ssCLA = 0, ssMLA = 0, ssGO = 0, ssAO = 0, ssGP = 0;
    for (const t of Object.keys(types)) if (isSS(t)) { const T = types[t]; ssOcc += T.occ; ssTot += T.tot; ssOA += T.occ_area; ssCLA += T.cla_area; ssMLA += T.mla_area; ssGO += T.gross_occ; ssAO += T.act_occ; ssGP += T.gpot; }
    return {
      occupied_units: occ, total_units: tot, vacant_units: vac, unrentable_units: unrent,
      occupied_area: R(occArea), cla_area: R(claArea), mla_area: R(mlaArea), total_area: R(mlaArea),
      gross_potential: R(gpot), gross_occupied: R(grossOcc), monthly_rent: R(actOcc),   // monthly_rent = actual billed
      rate_per_sqft_ann: rate(grossOcc, occArea),            // Total asking rate  (live "Rate per ft²" → Total)
      real_rate_per_sqft_ann: rate(actOcc, occArea),         // Total real rate    (live "Real Rate" → Total)
      self_storage_rate_ann: rate(ssGO, ssOA),               // SS asking rate     (live "Self Storage Rate")
      self_storage_real_rate_ann: rate(ssAO, ssOA),          // SS real rate       (live "Real Rate" → SS)
      total_rate_ann: rate(grossOcc, occArea),               // alias of asking-Total (back-compat)
      occ_pc: tot ? +(occ / tot * 100).toFixed(1) : 0,
      area_pc_cla: claArea ? +(occArea / claArea * 100).toFixed(1) : 0,   // % of Current Lettable Area
      area_pc_mla: mlaArea ? +(occArea / mlaArea * 100).toFixed(1) : 0,   // % of Maximum Lettable Area
      self_storage: {
        occupied_units: ssOcc, total_units: ssTot, occupied_area: R(ssOA), cla_area: R(ssCLA), total_area: R(ssMLA),
        gross_occupied: R(ssGO), monthly_rent: R(ssAO), gross_potential: R(ssGP),
        occ_pc: ssTot ? +(ssOcc / ssTot * 100).toFixed(1) : 0,
        rate_per_sqft_ann: rate(ssGO, ssOA), real_rate_per_sqft_ann: rate(ssAO, ssOA),
      },
      unit_types: Object.values(types).map(T => ({
        unit_type: T.unit_type, occ: T.occ, tot: T.tot, occ_area: R(T.occ_area), total_area: R(T.mla_area),
        gross_potential: R(T.gpot), monthly_rent: R(T.act_occ),
        occ_pc: T.tot ? +(T.occ / T.tot * 100).toFixed(1) : 0,
        rate_per_sqft_ann: rate(T.gross_occ, T.occ_area), real_rate_per_sqft_ann: rate(T.act_occ, T.occ_area),
      })),
      unit_mix: Object.values(ssSizes).sort((a, b) => a.area - b.area).map(S => ({
        area: S.area, occ: S.occ, tot: S.tot, occ_area: R(S.occ_area), total_area: R(S.total_area),
        occ_pc: S.tot ? +(S.occ / S.tot * 100).toFixed(1) : 0,
      })),
    };
  }},
  // RentRoll = per-unit. THIS IS THE SINGLE AUTHORITATIVE SOURCE for Rate/ft², Self Storage
  // Rate/ft², Real Rate/ft², and Self Storage Real Rate/ft² — per the locked spec (Michael,
  // 1 Jul 2026, field mapping SWAPPED 8 Jul 2026 — see the swap note further down for the exact
  // reasoning). No other file may recompute these; buildPayload.js reads the fields below as-is.
  //   Rate per Sq Ft (with concessions)      = (Σ dcStandardRate  ÷ Σ Area Rented) × 12
  //   Self Storage Rate per Sq Ft             = same, rows where sTypeName = "Self Storage" only
  //   Real Rate per Sq Ft (no concession)     = (Σ dcRent           ÷ Σ Area Rented) × 12
  //   Self Storage Real Rate per Sq Ft        = same, rows where sTypeName = "Self Storage" only
  // (The standard-rent field is `dcStandardRate` — the actual SiteLink RentRoll column confirmed
  // against a live export; there is no `dcStandardRent` column.)
  // Aggregate numerator + denominator first, THEN divide — never average per-unit rates. Only
  // occupied ("Rented") units count, matching "Area Rented" in the spec. No billing-frequency
  // adjustment, no receipts-based blending — this superseded an earlier ×13/12 heuristic that
  // is no longer authoritative.
  rent_roll: { method: 'RentRoll', dated: true, parse: (rows) => {
    const R = Math.round;
    // Site data uses "Indoor Self Storage" (not a bare "Self Storage") for this unit type —
    // confirmed via live RentRoll dump for Bicester (L001). Match on substring so both this
    // and any literal "Self Storage" naming are captured; "Drive Up" is a separate type and
    // is intentionally excluded (matches the portal's distinct "Indoor Self Storage" widget).
    const isSS = (t) => str(t).toLowerCase().includes('self storage');
    const isBlankDate = (v) => v === undefined || v === null || v === '' || v === '0001-01-01T00:00:00';
    const now = new Date();
    let tenants = 0, autobill = 0, stayDays = 0, stayN = 0;
    // all/ss carry the raw SUMS (not yet divided) so buildPayload.js can re-aggregate correctly
    // across sites/filters by summing these first, rather than averaging already-divided rates.
    const all = { area: 0, rent: 0, stdRent: 0 }, ss = { area: 0, rent: 0, stdRent: 0 };
    const types = {}, cust = { business: { units: 0, area: 0, rent: 0 }, residential: { units: 0, area: 0, rent: 0 } };
    const occupiedTenantIds = [];   // for cross-referencing against ReservationList's "active" rows (see `reservations` below)
    const autobillTenantIds = [];   // for Autobill Conversion's "new autobilled customers" cross-reference (see move_ins_outs above)
    // typeIdAreas: ADDED 6 Jul 2026 for "Reserved Scheduled Sqft" (KPIs page) — ReservationList only
    // gives a raw UnitTypeID per reservation, no area/size at all (confirmed via
    // probe:reservation-area — no size/area column exists on that report). UnitTypeID maps to a
    // broad TYPE, not one exact size (confirmed via probe:unittypeid-map — e.g. "Indoor Self
    // Storage" spans 35/50/150 sqft units under the same ID), so this can only ever be an ESTIMATE:
    // average area per UnitTypeID across ALL units of that type at the site (rented or not, for a
    // representative "typical size"), used in buildPayload.js as reservationCount × avgArea.
    const typeIdAreas = {};
    // Total area across ALL units (rented + vacant) — needed for the True Revenue-based Real Rate
    // formula (legacy's own tooltip, confirmed 8 Jul 2026 via probe-truerate-tooltip.js/
    // probe-rate-both-formulas.js: "TruePeriod ... divided by TOTAL area", NOT occupied area like
    // every other rate calc in this file). Kept separate from all.area/ss.area below, which are
    // occupied-only and still feed Rate/the old Real Rate fallback.
    let totalAreaAllUnits = 0, ssTotalAreaAllUnits = 0;
    for (const r of rows) {
      const utid = str(r.UnitTypeID);
      if (utid) { const o = (typeIdAreas[utid] ??= { area: 0, count: 0 }); o.area += num(r, 'Area', 'Area1'); o.count++; }
      const areaAll = num(r, 'Area', 'Area1'), typeAll = str(r.sTypeName) || 'Other';
      totalAreaAllUnits += areaAll;
      if (isSS(typeAll)) ssTotalAreaAllUnits += areaAll;
      if (!yes(r.bRented)) continue;                       // occupied ("Area Rented") units only
      tenants++;
      occupiedTenantIds.push(String(r.TenantID));
      // FIXED 8 Jul 2026: was reading `dcStandardRate` — RentRoll actually has TWO separate,
      // similarly-named columns (confirmed via Michael's uploaded July RentRoll export AND his own
      // pre-existing realrate_rentroll.py script, verified against the live portal back in May 2026:
      // "Rate per ft2/yr = (Σ dcStdRate / area) × 12", landing within pennies of the portal — SS
      // 29.68 vs 29.74, Total 28.43 vs 28.46). `dcStdRate` tracks the site's CURRENT standard rate for
      // that unit type; `dcStandardRate` appears to be a per-tenant value that can go stale for long
      // tenancies (e.g. Bicester OFF3, a 6-year tenant: dcStdRate 1307.6917 vs dcStandardRate
      // 1307.6900 — close but not identical, and portfolio-wide dcStdRate lands at £28.65 vs legacy's
      // £28.50 while dcStandardRate lands at £26.91 — dcStdRate is the verified-correct one).
      const a = num(r, 'Area', 'Area1'), rent = num(r, 'dcRent'), stdRent = num(r, 'dcStdRate'), t = str(r.sTypeName) || 'Other';
      all.area += a; all.rent += rent; all.stdRent += stdRent;
      if ([1, 2].includes(num(r, 'iAutoBillType'))) { autobill++; autobillTenantIds.push(String(r.TenantID)); }
      (types[t] ??= { units: 0, area: 0, rent: 0 }); types[t].units++; types[t].area += a; types[t].rent += rent;
      if (isSS(t)) { ss.area += a; ss.rent += rent; ss.stdRent += stdRent; }
      const biz = yes(r.bCorporate) || yes(r.bCommercial) || str(r.sCompany) !== '';
      const c = biz ? cust.business : cust.residential; c.units++; c.area += a; c.rent += rent;
      // Avg Length of Stay (CORRECTED 3 Jul 2026, confirmed via npm run probe:avg-stay): previously
      // used `iAnnivDays`, which turned out to be a monthly anniversary-billing countdown (only
      // populated on ~12% of occupied rows, range 1-30 days) — NOT total tenancy duration, and
      // nowhere close to matching the legacy portal's example of 480 days. `dLeaseDate` (lease/
      // move-in date) is the right field: days occupied = today − dLeaseDate, matching the legacy
      // tooltip's "Total Days Occupied / Ledger Count Occupied".
      if (!isBlankDate(r.dLeaseDate)) {
        const d = (now - new Date(r.dLeaseDate)) / 86400000;
        if (d > 0) { stayDays += d; stayN++; }
      }
    }
    const rate = (numer, a) => a ? R2((numer / a) * 12) : 0;
    const seg = (o) => ({ units: o.units, area: R(o.area), rent: R(o.rent), rate_per_sqft_ann: rate(o.rent, o.area) });
    return {
      tenants, occupied_area: R(all.area), monthly_rent: R(all.rent), occupied_tenant_ids: occupiedTenantIds, autobill_tenant_ids: autobillTenantIds,
      // SWAPPED 8 Jul 2026 (Michael, direct correction — "Rent > with concessions > dcstandardrate;
      // Real rent > no concession > dcrent"): the 1 Jul spec had these backwards. dcRent is the
      // tenant's actual currently-billed amount (can run ABOVE dcStandardRate for long-tenured units
      // after years of periodic increases — confirmed via a live RentRoll row, Bicester OFF3: dcRent
      // £1,615 vs dcStandardRate £1,307.69, 6-year tenant), so dcRent is the "no concession" REAL
      // figure; dcStandardRate is "Rate" (with concessions). NOTE: this swap alone barely moves either
      // number in aggregate (the two sums are ~0.3% apart portfolio-wide), so it does NOT explain the
      // full Real Rate gap vs legacy (£6.88 target, we're still landing ~£27) — see task #87, still
      // chasing a separate, much larger gap via the True Revenue "TruePeriod" field ÷ TOTAL (not
      // occupied) area, per legacy's own tooltip text.
      rate_per_sqft_ann: rate(all.stdRent, all.area),           // Total Rate (with concessions = dcStandardRate)
      real_rate_per_sqft_ann: rate(all.rent, all.area),         // Total Real Rate (no concession = dcRent)
      // raw sums, for portfolio/filter-level re-aggregation without averaging rates. NOTE: these keys
      // still honestly reflect their SOURCE field (rent_sum = Σ dcRent, std_rent_sum = Σ dcStandardRate)
      // — buildPayload.js's rate/realRate rollups swap which one they read, matching the swap above.
      rent_sum: R(all.rent), std_rent_sum: R(all.stdRent), area_sum: R(all.area),
      total_area_all_units: R(totalAreaAllUnits),
      self_storage: {
        occupied_area: R(ss.area), monthly_rent: R(ss.rent),
        rate_per_sqft_ann: rate(ss.stdRent, ss.area),           // Self Storage Rate (with concessions)
        real_rate_per_sqft_ann: rate(ss.rent, ss.area),         // Self Storage Real Rate (no concession) — fallback only, see buildPayload.js
        rent_sum: R(ss.rent), std_rent_sum: R(ss.stdRent), area_sum: R(ss.area),
        total_area_all_units: R(ssTotalAreaAllUnits),
      },
      autobill_rate: tenants ? +(autobill / tenants).toFixed(4) : 0,
      autobill_count: autobill,   // raw count, for portfolio-level sum-then-divide (never average per-site rates)
      avg_length_of_stay_days: stayN ? R(stayDays / stayN) : 0,
      customer_type: { business: seg(cust.business), residential: seg(cust.residential) },
      unit_types: Object.entries(types).map(([t, o]) => ({ unit_type: t, units: o.units, area: R(o.area), rent: R(o.rent), rate_per_sqft_ann: rate(o.rent, o.area) })),
      unit_type_areas: Object.entries(typeIdAreas).map(([id, o]) => ({ unit_type_id: id, avg_area: o.count ? R2(o.area / o.count) : 0 })),
    };
  }},
  // ManagementSummary = labelled monthly activity counts — the source R6 uses for move-ins/outs, net
  // area, leads BY CHANNEL (already internal-filtered), conversions, and insured move-ins. Counts only.
  // delinquent_30plus_total/_units — ADDED 7 Jul 2026: ManagementSummary is a MULTI-table SOAP
  // response (9 tables — Receipts/Concessions/Discounts/Delinquency/Unpaid/RentLastChanged/
  // VarFromStdRate/UnitActivity/Alerts), but `rows` here (from callReport()'s extractRows()) only
  // ever contains the SINGLE LARGEST one (UnitActivity, used for move_ins/move_outs/leads above) —
  // extractRows() picks "biggest table", which silently discards the other 8. The "Unpaid" table is
  // SiteLink's OWN internal AR-ageing breakdown (buckets: 0-10/11-30/31-60/61-90/91-120/121-180/
  // 181-360/>360 days, each with a £ total `dcDlqntTot` and account count `iDelUnits`) — confirmed
  // via a live SiteLink UI export for Gillingham/Jul 2026 that summing every bucket EXCEPT 0-10/11-30
  // gives SiteLink's own "30+ days delinquent" total (£973.29), which does NOT match what our old
  // Debtor Levels formula computed from PastDueBalances' raw tenant rows (£1,059.12) — this is now
  // the authoritative source instead (see buildPayload.js's `debtors` block).
  management: { method: 'ManagementSummary', dated: true, parse: (rows, startDate, endDate, raw) => {
    const m = {};
    for (const r of rows) { const k = str(r.sDesc); if (k) m[k] = { d: num(r, 'iDCount'), mo: num(r, 'iMCount'), y: num(r, 'iYCount') }; }
    const f = (re) => { for (const k of Object.keys(m)) if (re.test(k)) return m[k]; return { d: 0, mo: 0, y: 0 }; };
    let delinquent30Total = 0, delinquent30Units = 0;
    for (const r of extractNamedTable(raw, 'Unpaid')) {
      const bucket = str(r.Period);
      if (bucket === '0-10' || bucket === '11-30') continue;   // "delinquent" = 30+ days (R6's own rule)
      delinquent30Total += num(r, 'dcDlqntTot'); delinquent30Units += num(r, 'iDelUnits');
    }
    return {
      move_ins: f(/move.?in/i).mo, move_outs: f(/move.?out/i).mo, move_outs_year: f(/move.?out/i).y,
      transfers: f(/transfer/i).mo, net_area: f(/rented area increase/i).mo,
      phone_leads: f(/phone lead/i).mo, web_leads: f(/web lead/i).mo, walkin_leads: f(/walk.?in lead/i).mo,
      leads_converted: f(/leads converted/i).mo, insured_moveins: f(/^insurance$/i).mo,
      delinquent_30plus_total: Math.round(delinquent30Total), delinquent_30plus_units: delinquent30Units,
    };
  }},
  // MoveInsAndMoveOuts = one row per move event. Net ft² = moved-in area − moved-out area.
  move_ins_outs: { method: 'MoveInsAndMoveOuts', dated: true, parse: (rows) => {
    const R = Math.round; let mi = 0, mo = 0, inArea = 0, outArea = 0, inRateSum = 0; const moveInTenantIds = [];
    // moveInEmailHashes: ADDED 3 Jul 2026 for the Enquiries Converted % fix (see lead_funnel's
    // inquiry_email_hashes comment) — SHA-256 hashed immediately, raw email never stored.
    const moveInEmailHashes = [];
    for (const r of rows) {
      if (yes(r.MoveIn)) {
        mi++; inArea += num(r, 'MovedInArea');
        // MovedInRentalRate ADDED 6 Jul 2026 for the new "Move-In Rental Rate" KPI widget (Michael's
        // uploaded MoveInsAndMoveOuts export — column 13, "MovedInRentalRate" — divided by area).
        // Summed raw here (numerator); buildPayload.js divides by the summed MovedInArea and
        // annualises ×12, same sum-then-divide convention as every other rate/ft² figure in this file.
        inRateSum += num(r, 'MovedInRentalRate');
        if (r.TenantID != null) moveInTenantIds.push(String(r.TenantID));
        const eh = emailHash(r.sEmail);
        if (eh) moveInEmailHashes.push(eh);
      }
      if (yes(r.MoveOut)) { mo++; outArea += num(r, 'MovedOutArea'); }
    }
    // move_in_tenant_ids: for Autobill Conversion ("new autobilled customers / total new customers"
    // per the legacy tooltip, confirmed 2 Jul 2026 — a DIFFERENT formula than the whole-book autobill
    // rate this file used before). Confirmed working for Autobill Conversion's cross-reference against
    // RentRoll's autobill_tenant_ids — TenantID DOES work here, it's specifically InquiryTracking's
    // TenantID (a different ID space) that doesn't cross-reference against this report.
    return { move_ins: mi, move_outs: mo, net_units: mi - mo, moved_in_area: R(inArea), moved_out_area: R(outArea), net_area: R(inArea - outArea), move_in_tenant_ids: moveInTenantIds, move_in_email_hashes: moveInEmailHashes, moved_in_rental_rate_sum: R2(inRateSum) };
  }},
  // PastDueBalances = per-tenant balances. Aggregate total + ageing buckets by DaysLate. No PII.
  // CONFIRMED BUG (2 Jul 2026): `total_overdue`/`accounts_overdue` previously included the "1-30
  // days" bucket — i.e. tenants who are simply mid-grace-period on this month's rent, not actually
  // delinquent. buildPayload.js's `debtors.total` field already correctly excluded 1-30 ("R6: debt
  // OVER 30 days only"), but `tenantPct`/`rentRollPct` (the Debtor Levels widget's own % figures)
  // were built from these RAW totals, silently including that same 1-30 pool — which is typically
  // most of a portfolio's outstanding balance at any given moment, so it inflated the Debtor Levels
  // percentages by a large, inconsistent margin. Now exposing separate 30+-days-only totals so
  // EVERY debtor/delinquency figure in the app can use the same "over 30 days" definition.
  past_due: { method: 'PastDueBalances', dated: true, parse: (rows) => {
    const R = Math.round; let total = 0, n = 0, total30 = 0, n30 = 0;
    const buckets = { '1-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '121-180': 0, '181-360': 0, '361+': 0 };
    for (const r of rows) {
      const bal = num(r, 'ChargeBalance') || (num(r, 'RentBal') + num(r, 'LateFeeBal') + num(r, 'POSBal') + num(r, 'OtherChargesBal') + num(r, 'TaxesBal'));
      if (bal <= 0) continue; total += bal; n++;
      const d = num(r, 'DaysLate');
      const b = d <= 30 ? '1-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : d <= 120 ? '91-120' : d <= 180 ? '121-180' : d <= 360 ? '181-360' : '361+';
      buckets[b] += bal;
      if (d > 30) { total30 += bal; n30++; }   // "Delinquent" = over 30 days late (R6's own rule)
    }
    const ageing = {}; for (const k of Object.keys(buckets)) ageing[k] = R(buckets[k]);
    return { total_overdue: R(total), accounts_overdue: n, total_overdue_30plus: R(total30), accounts_overdue_30plus: n30, ageing };
  }},
  scheduled_outs: { method: 'ScheduledMoveOuts', dated: true, parse: (rows) => ({ scheduled_move_outs: rows.length }) },
  // InsuranceRoll = per insured unit. Insured = active policy with a premium. No PII.
  insurance_roll: { method: 'InsuranceRoll', dated: true, parse: (rows, startDate, endDate) => {
    const R = Math.round; let insured = 0, premium = 0, coverage = 0;
    // insured_tenants / insuredNewCustomers: ADDED 6 Jul 2026 for the Insurance Premiums (New
    // Customers) fix — InsuranceRoll is the full existing book, not new-customers-only. Originally
    // tried cross-referencing against move_ins_outs' move-in TenantIDs via `r.TenantID`, then via
    // `r.LedgerID` (assuming it was the same ID space) — BOTH confirmed dead ends: InsuranceRoll has
    // no TenantID column at all (confirmed via probe:insurance-roll-columns), and LedgerID does NOT
    // overlap with TenantID/MoveInsAndMoveOuts' tenant IDs (confirmed via check-merch-insurance-live:
    // 0 overlap even after a fresh pull). This replaces InsuranceActivity's `sNewPolicy` flag as the
    // original source too, which appears unreliable/rarely populated (same class of broken flag as
    // iInquiryConvertedToLease and QTRentalStatusID elsewhere in this pipeline).
    // FIX 6 Jul 2026 (third attempt, working): InsuranceRoll has its own `dMovedIn` column — the
    // tenant's move-in date — right on the report, so no cross-report ID matching is needed at all.
    // A policy counts as a "new customer" if it's active AND its dMovedIn falls within the period
    // being pulled for (the same startDate/endDate this report itself was called with).
    const R2i = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const inWindow = (v) => {
      if (!v || !startDate || !endDate) return false;
      const d = new Date(v);
      return !isNaN(d) && d >= startDate && d <= endDate;
    };
    let newCount = 0, newPremium = 0, newCoverage = 0;
    for (const r of rows) {
      if (!yes(r.iActive)) continue;   // active policies only → penetration ≤ 100%
      insured++; premium += num(r, 'dcPremium'); coverage += num(r, 'dcCoverage');
      if (inWindow(r.dMovedIn)) { newCount++; newPremium += num(r, 'dcPremium'); newCoverage += num(r, 'dcCoverage'); }
    }
    return {
      insured_units: insured, monthly_premium: R2(premium), total_coverage: R(coverage),
      insured_new_customers: { count: newCount, premiumSum: R2i(newPremium), coverageSum: R2i(newCoverage) },
    };
  }},
  // InsuranceActivity = policy events in period. New policies / cancellations / new-customer premium.
  insurance_activity: { method: 'InsuranceActivity', dated: true, parse: (rows) => {
    let newPol = 0, cancelled = 0, newPrem = 0;
    for (const r of rows) {
      if (str(r.sNewPolicy)) { newPol++; newPrem += num(r, 'dcPremium'); }
      if (str(r.sCancelledPolicy) || yes(r.bCancelled)) cancelled++;
    }
    return { new_policies: newPol, cancellations: cancelled, new_premium: R2(newPrem) };
  }},
  // InquiryTracking = one row per FUNNEL-STAGE EVENT, not one row per enquiry — confirmed 2 Jul
  // 2026 (npm run probe:enquiries-rentaltype): `sRentalType`/`QTRentalTypeID` marks which stage a
  // row represents ("Inquiry"=1, "Reservation"=2, "Move In"=3), and the SAME lead gets a NEW row
  // each time they progress a stage. Originally filtered to sRentalType="Inquiry" (CURRENT stage),
  // which took a real Bicester example from 192 rows down to 148 against a legacy target of 122 —
  // better than counting everything, but still a ~20% gap, and BADLY skewed at the channel level
  // portfolio-wide (Web ~96%, Phone/Walk-in ~2% each, vs legacy's own ~88%/6%/6%).
  // ROOT CAUSE FOUND 8 Jul 2026, via Michael's uploaded Bicester InquiryTracking export: filtering by
  // CURRENT STAGE conflates "sitting unprogressed in Inquiry status" with "originated this period" —
  // an old lead from months ago that's still stuck in Inquiry status (never progressed, never
  // cancelled) gets swept into whatever window it's next touched in, while a walk-in/phone lead that
  // quickly progresses to Reservation/Move-In falls OUT of an Inquiry-only filter even though it
  // genuinely originated this period. Web leads sit unworked longest (hence over-represented);
  // phone/walk-in get worked fast (hence under-represented). FIX: filter by `dPlaced` (when the row
  // was actually placed) falling inside the requested window, regardless of current stage. Validated
  // against Bicester's own Jul 2026 legacy target — EXACT match on Phone (2) and Walk-in (2), Web
  // close (25 vs 21) — then against the full 25-site portfolio target (Phone 54, Walk-in 60, Web
  // 887): EXACT match on Phone (54) and Walk-in (60), Web within 2.8% (862). Night-and-day better
  // than the old stage filter, which gave Phone 41, Walk-in 28, Web 1512 on the same data.
  // THIS IS THE AUTHORITATIVE SOURCE for the Enquiries TOTAL — per the locked spec (Michael,
  // 1 Jul 2026). `sInquiryType` IS the "Last Page -> Origination" field (confirmed via npm run
  // probe:enquiries — values are exactly Phone / WalkIn / Web / EMail, nothing else).
  //   Phone    = count where sInquiryType = "Phone"
  //   Walk-ins = count where sInquiryType = "WalkIn"
  //   Web      = count where sInquiryType = "Web"  (raw, for individual display)
  //   Email    = count where sInquiryType = "EMail" (raw, for individual display)
  //   webCombined = Web + Email                     (spec's displayed "Web" tile — confirmed again via
  //                                                   legacy's own tooltip: "Web Count + Email Count")
  //   total       = Phone + WalkIn + Web + Email     (sum of the four raw counts)
  // REVERTED 8 Jul 2026: buildPayload.js now sources Phone/Walk-in/Web/Total from THIS (fixed) parser
  // again, not ManagementSummary — see buildPayload.js's own comment for the 7 Jul / 8 Jul history.
  lead_funnel: { method: 'InquiryTracking', dated: true, parse: (rows, startDate, endDate) => {
    // Compares calendar DATES only (ignoring time-of-day) so a closed month's endDate — which
    // pull.js sets to midnight of the last day, not 23:59:59 — doesn't silently clip that day's
    // later inquiries. dPlaced confirmed present and correctly parseable on live SOAP rows via
    // probe:enquiries-dplaced (exact portfolio-wide match against legacy).
    const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const isPlacedInWindow = (r) => {
      if (!r.dPlaced) return false;
      const d = new Date(r.dPlaced);
      if (Number.isNaN(d.getTime())) return false;
      const day = dayOnly(d);
      if (startDate && day < dayOnly(startDate)) return false;
      if (endDate && day > dayOnly(endDate)) return false;
      return true;
    };
    const isReservationStage = (r) => str(r.sRentalType).toLowerCase() === 'reservation';
    const channels = {}; let phone = 0, walkin = 0, web = 0, email = 0, other = 0, conv = 0, res = 0, biz = 0;
    // inquiryTenantIds: ADDED 3 Jul 2026, then CONFIRMED DEAD via probe:inquiry-vs-rentroll-tenantid
    // (0.3% overlap even against RentRoll's own known-reliable occupied-tenant list) — InquiryTracking's
    // TenantID is not the same ID space as RentRoll's, so it can't cross-reference against move-ins.
    // Kept only as a last-resort fallback (see buildPayload.js).
    // inquiryEmailHashes: THE ACTUAL FIX, added 3 Jul 2026 after TenantID and WaitingID (doesn't exist
    // on MoveInsAndMoveOuts) both failed. sEmail is a real-world identifier stable across a person's
    // whole journey regardless of internal ID space — confirmed via probe:enquiries-email-match (158
    // matches / 4408 = 3.6%, vs TenantID's ~0.1-0.8%). Hashed (SHA-256) immediately, never the raw
    // address, so no PII ever reaches the stored raw_report/portal_payload rows in Supabase.
    const inquiryTenantIds = [];
    const inquiryEmailHashes = [];
    // reservationEmailHashes: ADDED 6 Jul 2026 for the Enquiry -> Reservation fix — confirmed via
    // probe:enquiry-reservation that BOTH previous candidates are dead: `iReservationConvertedToLease`
    // is barely populated (4.0%, same broken-flag class as iInquiryConvertedToLease), and WaitingID/
    // TenantID is not even stable across a single lead's OWN stage progression within this same
    // report (0 overlap between 1,341 Inquiry-stage IDs and 369 Reservation-stage IDs — each stage
    // transition apparently gets a fresh ID). Same fix as Enquiry -> Move-In: email is a real-world
    // identifier stable across a person's journey regardless of internal ID churn. Hashed (SHA-256)
    // immediately, same PII-safety rule as inquiryEmailHashes above.
    const reservationEmailHashes = [];
    // reservationStageCount: ADDED 6 Jul 2026 for the "Reservations vs Move-outs" widget rebuild
    // (Michael's idea) — InquiryTracking is `dated: true` and confirmed via
    // npm run probe:lead-funnel-reservations to give genuinely different, plausible counts per
    // month (unlike ReservationList, which has no date param and is always relative to today, or
    // ScheduledMoveOuts, which takes a date param but returns an identical count regardless of it).
    // This is just a plain row count of isReservationStage(r) for the requested period — a real
    // historical "new reservations made this month" flow metric, sourced from the same report that
    // already correctly powers Enquiries per-month.
    let reservationStageCount = 0;
    for (const r of rows) {
      if (isReservationStage(r)) { reservationStageCount++; const eh = emailHash(r.sEmail); if (eh) reservationEmailHashes.push(eh); }
      if (!isPlacedInWindow(r)) continue;
      const c = str(r.sInquiryType);
      const k = c.toLowerCase();
      if (k === 'phone') phone++;
      else if (k === 'walkin') walkin++;
      else if (k === 'web') web++;
      else if (k === 'email') email++;
      else other++;
      const label = c || 'Other';
      (channels[label] ??= { enquiries: 0, converted: 0 }); channels[label].enquiries++;
      if (yes(r.iInquiryConvertedToLease)) { conv++; channels[label].converted++; }
      if (yes(r.iReservationConvertedToLease) || /reserv/i.test(str(r.sCallType))) res++;   // kept for back-compat only — confirmed unreliable, no longer used (see reservationEmailHashes above)
      if (yes(r.bCommercial)) biz++;
      if (r.TenantID != null) inquiryTenantIds.push(String(r.TenantID));
      const eh = emailHash(r.sEmail);
      if (eh) inquiryEmailHashes.push(eh);
    }
    return {
      phone, walkin, web, email, other,
      web_combined: web + email,               // spec's displayed "Web" tile (Web Count + Email Count)
      total_enquiries: phone + walkin + web + email,   // spec's Total — the 4 raw counts, "other" excluded
      conversions: conv, reservations: res, business_enquiries: biz, channels,
      inquiry_tenant_ids: inquiryTenantIds,
      inquiry_email_hashes: inquiryEmailHashes,
      reservation_email_hashes: reservationEmailHashes,
      reservation_stage_count: reservationStageCount,
    };
  }},
  // MarketingSummary = tenants/avg-rent by marketing source (commercial vs residential).
  marketing: { method: 'MarketingSummary', dated: true, parse: (rows) => {
    let tenTot = 0, comNum = 0, resNum = 0, comRentW = 0, resRentW = 0; const sources = [];
    for (const r of rows) {
      const tt = num(r, 'TenTot'), cn = num(r, 'TenComNum'), rn = num(r, 'TenResNum'), car = num(r, 'TenComAvgRent'), rar = num(r, 'TenResAvgRent');
      tenTot += tt; comNum += cn; resNum += rn; comRentW += cn * car; resRentW += rn * rar;
      sources.push({ source: str(r.sMarketingDesc), tenants: tt, commercial: cn, residential: rn, com_avg_rent: R2(car), res_avg_rent: R2(rar), moveins: num(r, 'MTot') });
    }
    const allN = comNum + resNum;
    return { tenants: tenTot, commercial: comNum, residential: resNum, avg_rent: allN ? R2((comRentW + resRentW) / allN) : 0, sources };
  }},
  merchandise: { method: 'MerchandiseSummary', dated: true, parse: (rows) => {
    const R = Math.round; let sold = 0, charge = 0, cost = 0;
    for (const r of rows) { sold += num(r, 'dcSold'); charge += num(r, 'dcChargeTotal'); cost += num(r, 'dcCostTotal'); }
    return { units_sold: R(sold), sales: R2(charge), cost: R2(cost), margin: R2(charge - cost) };
  }},
  // FinancialSummary = charges/payments/discounts/credits by charge category (drives Revenue).
  financial: { method: 'FinancialSummary', dated: true, parse: (rows) => {
    const R = Math.round; let charge = 0, payment = 0, discount = 0, credit = 0; const categories = [];
    for (const r of rows) {
      const ch = num(r, 'Charge'), pay = num(r, 'Payment'), disc = num(r, 'Discount'), cr = num(r, 'Credit');
      charge += ch; payment += pay; discount += disc; credit += cr;
      if (ch || pay || disc || cr) categories.push({ category: str(r.sChgCategory), desc: str(r.sChgDesc), charge: R2(ch), payment: R2(pay), discount: R2(disc), credit: R2(cr) });
    }
    return { total_charge: R(charge), total_payment: R(payment), total_discount: R(discount), total_credit: R(credit), categories };
  }},
  // TenantRentChangeHistory = rate changes in period. Increases count + avg % uplift.
  rate_changes: { method: 'TenantRentChangeHistory', dated: true, parse: (rows) => {
    let increases = 0, decreases = 0, sumPct = 0, n = 0;
    for (const r of rows) {
      const o = num(r, 'dcOldRate'), nw = num(r, 'dcNewRate'); if (!o && !nw) continue;
      if (nw > o) { increases++; if (o) { sumPct += (nw - o) / o * 100; n++; } } else if (nw < o) decreases++;
    }
    return { increases, decreases, avg_increase_pct: n ? +(sumPct / n).toFixed(1) : 0 };
  }},
  // True Revenue (custom report #781861): NOT exposed by the Reporting API — no run-report-by-ID
  // method exists. Derive from `financial` (FinancialSummary) or keep that widget manual.

  // ReservationList lives on CallCenterWs.asmx — a DIFFERENT SiteLink service from every other
  // report above (all on ReportingWs.asmx) — see lib/sitelink.js's callReservationList(). Confirmed
  // 2 Jul 2026: no date-range param exists (just iGlobalWaitingNum=0 for "all"); it returns the
  // account's LIVE waiting list, which drops a row once converted to a tenant (moved in) — so "not
  // moved in" is inherent to what this call returns, we don't need to filter for it ourselves.
  // Legacy portal tooltip's exact filter: "Converted To RSV and Needed is not cancelled, is not
  // moved in, is in the future." We interpret this as: dCancelled is blank (not cancelled) AND
  // dNeeded is a future date. NOTE: SiteLink doesn't document QTRentalStatusID/QTRentalTypeID's
  // enum meanings, and a live probe (probe-reservationlist2.js, 2 Jul 2026) found status/type codes
  // don't cleanly separate "still open" reservations beyond the cancelled/future-date filter above —
  // this is the best-effort interpretation until SiteLink support confirms the exact status codes.
  // AUDIT (2 Jul 2026, npm run audit): confirmed the dCancelled-blank + future-dNeeded filter alone
  // overcounts ~3x vs the legacy portal (1502 vs ~446 portfolio-wide). Two concrete, self-contained
  // fixes applied here: (a) exclude rows where QTCancellationTypeID is SET despite dCancelled being
  // blank — a real SiteLink data-entry quirk (some cancellation paths set the type code but never
  // populate the cancel date), confirmed on 38 rows portfolio-wide; (b) return each "active" row's
  // TenantID so buildPayload.js can additionally exclude any that are already an occupied RentRoll
  // tenant (converted but the reservation record was never formally closed) — confirmed on 51 rows.
  // QTRentalStatusID=3 (2 Jul 2026): TESTED AND REVERTED. Treating status 3 as "resolved/cancelled"
  // (based on it being 89.5% of Bicester's full reservation history, plus a lifecycle report showing
  // ~83% eventual cancellation) looked like a reasonable hypothesis, but a live pull with that filter
  // applied dropped the portfolio count to 200 — well UNDER the ~446 target (previously 1,414, well
  // OVER target). Overshoot flipped to undershoot, which means status 3 is NOT simply "resolved" —
  // it's most likely just SiteLink's generic default/common status, unrelated to whether a
  // reservation is genuinely still open. Reverted; still need the actual status code meaning from
  // SiteLink support or an on-screen label (see SiteLink_Reservation_Status_Request.md) to fix this
  // properly. Current count (~1413) only has the two CONFIRMED-good fixes below applied.
  // FIXED 6 Jul 2026 (Task #25): found the real cause of the ~3x overcount via
  // npm run probe:reservations-qtrentaltype. ReservationList's QTRentalTypeID marks the FUNNEL STAGE
  // of a waiting-list row, exactly like InquiryTracking's identically-named field (confirmed
  // independently from Michael's uploaded InquiryTracking export, which spells out 1=Inquiry,
  // 2=Reservation, 3=Move In): 1=Inquiry-level waiting-list entry, 2=genuine Reservation, 3=Move-In.
  // The old parser was counting ALL THREE types as "reservations". Isolating QTRentalTypeID===2 on
  // top of the two previously-confirmed exclusions took the portfolio count from 1,412 to 439 —
  // a near-exact match for the ~446 legacy target (the small remainder is very likely just same-day
  // timing drift between when the target screenshot was taken and when this was pulled).
  reservations: { ccws: true, dated: false, parse: (rows) => {
    const isBlank = (v) => v === undefined || v === null || v === '' || v === '0001-01-01T00:00:00';
    const now = new Date();
    let active = 0, cancelled = 0, cancelTypeSet = 0, excludedNotReservationType = 0; const activeTenantIds = [];
    const activeByType = {};   // ADDED 6 Jul 2026 for Reserved Scheduled Sqft — see rent_roll's unit_type_areas comment
    for (const r of rows) {
      const isCancelled = !isBlank(r.dCancelled);
      const needed = isBlank(r.dNeeded) ? null : new Date(r.dNeeded);
      if (isCancelled) { cancelled++; continue; }
      if (!(needed && needed > now)) continue;
      if (!isBlank(r.QTCancellationTypeID) && Number(r.QTCancellationTypeID) !== 0) { cancelTypeSet++; continue; }   // (a)
      if (Number(r.QTRentalTypeID) !== 2) { excludedNotReservationType++; continue; }   // (b) FIXED 6 Jul 2026 — Task #25
      active++; activeTenantIds.push(String(r.TenantID));
      const utid = str(r.UnitTypeID);
      if (utid) activeByType[utid] = (activeByType[utid] || 0) + 1;
    }
    return { active_reservations: active, cancelled_reservations: cancelled, total_waiting_list: rows.length, excluded_cancel_type_set: cancelTypeSet, excluded_not_reservation_type: excludedNotReservationType, active_tenant_ids: activeTenantIds, active_by_unit_type: activeByType };
  }},
  // True Revenue (custom report "Financial \ True Revenue Report - Daily Prorate", ReportID
  // 781861 — what Michael calls "Daily Pro Rate"). CustomReportByReportID is NOT in SiteLink's
  // documented Reporting API, but confirmed working 2 Jul 2026 via an earlier version of this
  // project's own scripts (true_revenue.py / sitelink_test.py) — see lib/sitelink.js's
  // callCustomReport() comment. One row per (ChargeDesc, UnitType) combination; sum the 9 revenue
  // columns per ChargeDesc (drives the "True Revenue" table) AND per UnitType (drives "True
  // Revenue — Unit Types") — same raw rows, two different groupings, exactly like the legacy
  // portal's two tables.
  true_revenue: { customReportId: 781861, dated: true, parse: (rows) => {
    const R2v = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    // CORRECTED 8 Jul 2026: the 8 Jul "FIXED" note that used to be here (renaming
    // 'Tax1AdjustmentsThisPeriod' to 'ThisPeriodTax1Adjustments') was the wrong theory — that raw
    // column genuinely exists (confirmed via a live dump) but a full rebuild+restart still showed
    // £0 throughout, so it isn't the real source. Cross-checked legacy's own "Tax Adj" figures
    // against its OTHER columns on the same screenshot instead of guessing another raw column name:
    // Rent £69,664.60 Tax Invoiced − £60,629.13 Net Tax = £9,035.47, exactly legacy's Tax Adj for
    // that row. Same exact match (to the penny) on StoreProtect, Combi Padlock, Late Fee, Insurance,
    // Insufficient Notice Fee, Extended Hours Access, and Bin Charge — 8 for 8. "Tax Adj" is a
    // DERIVED figure (Tax Invoiced minus Net Tax), not a raw SiteLink column at all — 'taxAdj' is
    // now computed the same way, below, instead of summing a raw column. Does not affect Real Rate
    // (unrelated fields: 'truePeriod'/'adj').
    const cols = ['InvoicedThisPeriod', 'InvoicedTax1ThisPeriod', 'NetTax1ThisPeriod', 'DeferredRevenue', 'PriorPeriodDeferred', 'ThisPeriodAdjustments', 'PriorPeriodAdjustments', 'TruePeriod'];
    const outKeys = ['invoiced', 'taxInvoiced', 'netTax', 'deferred', 'deferredPrev', 'adj', 'adjPrev', 'truePeriod'];
    // NOTE (3 Jul 2026): briefly tried normalizing/merging near-duplicate labels here (e.g. "Drive
    // Up" / "DriveUp" / "Drive up") assuming they were a SiteLink data-entry inconsistency — REVERTED
    // after Michael shared the legacy portal's own True Revenue Unit Types screenshot, which shows
    // all three as SEPARATE rows too. They're apparently genuinely distinct categories in SiteLink
    // (or at least the legacy portal treats them as such), so grouping must match legacy exactly:
    // group by the raw, unmodified label. The earlier "many missing unit types" complaint was
    // actually just pagination (pageSize was 8 for a ~14-row table) — fixed by raising pageSize below.
    const groupBy = (field) => {
      const g = {};
      for (const r of rows) {
        const k = str(r[field]) || 'Other';
        const o = (g[k] ??= Object.fromEntries([...outKeys, 'taxAdj'].map((k2) => [k2, 0])));
        cols.forEach((c, i) => { o[outKeys[i]] += num(r, c); });
      }
      for (const k of Object.keys(g)) {
        // taxAdj DERIVED (see comment above), computed before rounding so it rounds like every
        // other field instead of rounding twice.
        g[k].taxAdj = g[k].taxInvoiced - g[k].netTax;
        for (const k2 of [...outKeys, 'taxAdj']) g[k][k2] = R2v(g[k][k2]);
      }
      return Object.entries(g).map(([desc, vals]) => ({ desc, ...vals }));
    };
    return { by_desc: groupBy('ChargeDesc'), by_type: groupBy('UnitType') };
  }},
  // RentalActivity = one row per UnitType×UnitSize per site — CONFIRMED 3 Jul 2026 as a genuine,
  // directly-callable SOAP method (npm run probe:rental-activity-report) separate from
  // OccupancyStatistics. Same UnitType×UnitSize grain as OccupancyStatistics, but ALSO carries
  // movement/turnover columns (MovedIn/MovedOut/Transfers/NetTransferred/Net) that OccupancyStatistics
  // does not expose (checked directly — only OccupancyStatistics' own Vacant field overlaps). Drives
  // the new "Unit Mix Detail" page (Unit Size Breakdown, Vacant Units by Size, Rate Realization Gap,
  // Turnover by Unit Size, Gross Potential vs Actual Revenue, Transfer flow). Flow-type columns
  // (MovedIn/MovedOut/Transfers/Net) are for a full calendar month like Enquiries/Move-ins, so this
  // report is in lib/pull.js's TWO_MONTH set and buildPayload.js overrides it to the previous
  // complete month. Kept at the report's own natural per-(type,size) grain — no aggregation here;
  // buildPayload.js sums across sites for portfolio rollups (sum-then-divide, never averaging rates).
  rental_activity: { method: 'RentalActivity', dated: true, parse: (rows) => {
    const R2v = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    return {
      by_type_size: rows.map((r) => ({
        type: str(r.Type) || 'Other',
        width: num(r, 'dcWidth'), length: num(r, 'dcLength'), unitSize: str(r.UnitSize),
        area: num(r, 'Area'),
        standardRate: R2v(num(r, 'StandardRate')),
        totalUnits: num(r, 'TotalUnits'), occupied: num(r, 'Occupied'), vacant: num(r, 'Vacant'),
        occupiedRent: R2v(num(r, 'OccupiedRent')),
        movedIn: num(r, 'MovedIn'), movedOut: num(r, 'MovedOut'),
        netTransferred: num(r, 'NetTransferred'), transfers: num(r, 'Transfers'), net: num(r, 'Net'),
        occPct: num(r, 'PercentOccupied'), vacPct: num(r, 'PercentVacant'),
        totalArea: num(r, 'TotalArea'), occupiedArea: num(r, 'OccupiedArea'),
        totalDollarPerArea: R2v(num(r, 'TotalDollarPerArea')), occupiedDollarPerArea: R2v(num(r, 'OccupiedDollarPerArea')),
        grossPotential: R2v(num(r, 'GrossPotential')), vacantArea: num(r, 'VacantArea'), netArea: num(r, 'NetArea'),
        lastChange: r.dLastChange || null,
      })),
    };
  }},
};

export async function pullReport(key, loc, startDate, endDate) {
  const r = REPORTS[key];
  if (!r) throw new Error('Unknown report: ' + key);
  const { rows, raw } = r.ccws
    ? await callReservationList(loc)   // CallCenterWs.asmx — different service, no date range param
    : r.customReportId
      ? await callCustomReport(r.customReportId, loc, startDate, endDate)
      : await callReport(r.method, loc, r.dated ? startDate : null, r.dated ? endDate : null);
  // startDate/endDate passed through to parse() — ADDED 6 Jul 2026 for insurance_roll's dMovedIn
  // window filter (see REPORTS.insurance_roll above). `raw` (the untouched multi-table SOAP response)
  // ADDED 7 Jul 2026 for management's delinquent_30plus_total/_units (see its own comment — needs a
  // table extractRows() doesn't surface). Every other parser's signature is (rows) => {...} and
  // simply ignores the extra args, so this is a safe, additive change.
  // `raw` ALSO now returned to the caller (7 Jul 2026, raw-storage change) so pull.js/repull-*.js can
  // persist it to raw_report.raw_response — see schema.sql's comment and scripts/reparse-report.js.
  return { data: r.parse(rows, startDate, endDate, raw), rowcount: rows.length, raw };
}
