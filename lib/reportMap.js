// Report map — CONFIRMED method names from the SiteLink Reporting API doc.
// NOTE: the doc lists each method's PARAMETERS but not its success COLUMN names ("the DataSet
// will contain the report information"). So the calls are correct now; the column→field mapping
// in parse() is best-effort and gets finalised from the first real DataSet (run
// `npm run test:connection`, which prints the columns). parse() never stores tenant PII —
// only aggregated numbers.
import { callReport, callReservationList, callCustomReport, extractNamedTable } from './sitelink.js';

// emailHash/phoneHash — REMOVED 17 Jul 2026 (task #310). These backed a per-lead cohort-matching
// attempt at Enquiry -> Reservation conversion (email 6 Jul, phone added 17 Jul task #301, then a
// same/previous-month lookback added the same day task #303) and a similar attempt at Enquiry ->
// Move-In (move_ins_outs' moveInEmailHashes, 3 Jul — already unused by buildPayload.js before today).
// Removed once Michael confirmed legacy's real June 2026 rate (19.8%, verified live) fits a plain
// COUNT RATIO (reservation-stage rows ÷ enquiries, same period, no per-lead tracking at all) far
// better than any cohort-matched figure ours produced (low single digits to ~10%) — legacy isn't
// cross-referencing individual leads by contact info here, just dividing two independent aggregates,
// same as the Enquiry -> Move-In tile already did. See buildPayload.js's reservationConversions for
// the new formula. Removing these since nothing reads a *_contacts/*_email_hashes field anymore.
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
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// For date-window checks, trust the SOURCE row's own calendar date (`YYYY-MM-DD` prefix) before
// converting through the host machine's local timezone. SiteLink timestamps often include an
// explicit offset (for example `...-04:00`), and truncating the converted JS Date in the UK can
// silently push late-evening source rows onto the next day.
const sourceDayKey = (v) => {
  const raw = str(v);
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : ymd(d);
};
const inSourceDayWindow = (v, startDate, endDate) => {
  if (!v || !startDate || !endDate) return false;
  const key = sourceDayKey(v);
  if (!key) return false;
  return key >= ymd(startDate) && key <= ymd(endDate);
};
const normalizeDiscountPlan = (value) => {
  const raw = str(value);
  if (!raw) return '(unspecified)';
  const cleaned = raw
    .replace(/~/g, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const lower = cleaned.toLowerCase();
  const pctMatch = lower.match(/(\d+(?:\.\d+)?)\s*%/);
  const durationMatch = lower.match(/(\d+)\s*(?:month|months|mo|mos|mth|mths|week|weeks|wk|wks)\b/);
  const offMatch = /\boff\b/.test(lower);
  const kind = durationMatch
    ? (/(week|wk)/.test(durationMatch[0]) ? 'weeks' : 'months')
    : null;
  if (pctMatch && durationMatch && offMatch) {
    return `${pctMatch[1]}% Off ${durationMatch[1]} ${kind}`;
  }
  return cleaned
    .replace(/\bfor\s+(\d+)\s+months?\b/ig, '$1 months')
    .replace(/\bfor\s+(\d+)\s+weeks?\b/ig, '$1 weeks')
    .replace(/\b(\d+)\s+month\b/ig, '$1 months')
    .replace(/\b(\d+)\s+week\b/ig, '$1 weeks')
    .replace(/\bnon expiring\b/ig, 'Non-Expiring')
    .replace(/\boff\b/ig, 'Off')
    .replace(/\b[a-z]/g, (m) => m.toUpperCase());
};
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
    // ADDED 21 Jul 2026 (Michael: "Can we add economic occupancy into this section please? Example
    // of the table with dropdown plus instructions attached" — his Economic occupancy Tracker.xlsx).
    // Same rounded-area grouping as ssSizes above, but for EVERY unit type (not just Self Storage)
    // and carrying gross_potential/act_occ too — ssSizes only ever tracked occupancy counts/area, not
    // revenue, because nothing before this needed a per-SIZE rate/discount/economic-occupancy figure.
    // Confirmed via the tracker's own Source sheet: it's raw OccupancyStatistics rows (identical
    // column names — UnitType, Area, TotalArea, GrossPotential, ActualOccupied) grouped by exactly
    // Type+Area, so this reuses the SAME already-validated fields as economicOccPct/Real Rate
    // elsewhere in this file rather than introducing a second revenue source.
    const typeSizes = {};
    for (const r of rows) {
      const t = (r.UnitType || 'Other').trim();
      const a = num(r, 'Area');                          // per-unit area for this size
      const o = num(r, 'Occupied'), tu = num(r, 'TotalUnits'), vc = num(r, 'Vacant'), un = num(r, 'Unrentable');
      const go = num(r, 'GrossOccupied'), ao = num(r, 'ActualOccupied'), gp = num(r, 'GrossPotential');
      // PREFER the raw OccupiedArea column when SiteLink provides it, rather than deriving occupied
      // area by multiplying this row's per-unit Area × Occupied count. Michael, 16 Jul 2026: "there
      // is a column in the occupancy stats sheet that is occupied area, you just need to sum that
      // column" — then, same day: "the occupied area is the average of day 10, 20, and the end of
      // the month". So OccupiedArea is SiteLink's OWN mid-month average across those 3 sample dates,
      // not a simple point-in-time snapshot, and NOT necessarily identical to Area × Occupied (which
      // only reflects whatever single moment `Occupied` itself was captured at) — summing the raw
      // column is the only way to get that true 3-sample average; the multiplication beneath it can
      // only approximate it. OccupancyStatistics' own raw rows weren't being read for this field at
      // all before today — only RentalActivity (a sibling report in the same reporting family) was
      // confirmed to expose it directly (OccupiedArea/TotalArea/VacantArea/NetArea, see
      // rental_activity below).
      // Falls back to the Area × Occupied derivation only if the raw field is ever missing from a
      // pull, so this can't regress a working figure — it can only replace an approximation with
      // SiteLink's real, more representative average.
      const rawOccArea = num(r, 'OccupiedArea', 'OccArea');
      const oa = rawOccArea > 0 ? rawOccArea : a * o, cla = a * (tu - un), mla = a * tu;
      occ += o; tot += tu; vac += vc; unrent += un;
      occArea += oa; claArea += cla; mlaArea += mla; gpot += gp; grossOcc += go; actOcc += ao;
      const T = (types[t] ??= { unit_type: t, occ: 0, tot: 0, occ_area: 0, cla_area: 0, mla_area: 0, gross_occ: 0, act_occ: 0, gpot: 0 });
      T.occ += o; T.tot += tu; T.occ_area += oa; T.cla_area += cla; T.mla_area += mla; T.gross_occ += go; T.act_occ += ao; T.gpot += gp;
      // FIXED 16 Jul 2026 (extreme-depth widget-by-widget audit): this used to be `isSS(t) && a > 0`,
      // silently dropping any Self Storage row with a zero/missing per-unit Area (a real, if rare,
      // SiteLink data-quality case — same class as the 0 ft² "INPOST" Parking units already shown
      // honestly elsewhere) from the Unit Mix Occupancy table's bucketing. That made the KPI page's
      // "Unit Mix Occupancy (All Stores)" Total row (12,764 units) silently undercount the true Self
      // Storage total by exactly the count of those zero-area rows (10 units), while its sibling
      // widget "Indoor Self Storage Occupancy — by Store" — built from `types[t]`, which has no such
      // filter — correctly showed 12,774. Both widgets share the same `occ`/`rate`, so the mismatch
      // was invisible unless you compared their Total-row unit counts directly. Removing the `a > 0`
      // guard lets zero-area rows fall into the '0' (R(0)=0) bucket instead of vanishing, so
      // ssSizes always sums to exactly ssTot/ssOcc — the two widgets can no longer disagree.
      if (isSS(t)) { const k = String(R(a)); const S = (ssSizes[k] ??= { area: R(a), occ: 0, tot: 0, occ_area: 0, total_area: 0 }); S.occ += o; S.tot += tu; S.occ_area += oa; S.total_area += mla; }
      // typeSizes: same idea as ssSizes immediately above, generalized to every unit type + revenue —
      // see the declaration comment for why this is a new grouping rather than extending ssSizes.
      { const k = t + '|' + String(R(a)); const Z = (typeSizes[k] ??= { type: t, area: R(a), occ: 0, tot: 0, occ_area: 0, mla_area: 0, gpot: 0, act_occ: 0 }); Z.occ += o; Z.tot += tu; Z.occ_area += oa; Z.mla_area += mla; Z.gpot += gp; Z.act_occ += ao; }
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
      // by_type_size — task #376/377 (Economic Occupancy Detail table, KPIs page). Every unit type,
      // grouped by exact size, carrying enough to derive all 5 of the tracker's metrics client-side:
      // Asking Rent PSF = grossPotential/totalArea×12, In-Place Rent PSF = actualOccupied/occArea×12,
      // In-Place Discount = (In-Place − Asking)/Asking, Occupancy% = occArea/totalArea,
      // Economic Occupancy% = actualOccupied/grossPotential. Raw sums only (no ratios computed here) —
      // buildPayload.js/page.js sum these across whatever site(s) are in scope FIRST, then divide once,
      // same convention as every other rate in this file.
      by_type_size: Object.values(typeSizes)
        .sort((a, b) => (a.type === b.type ? a.area - b.area : a.type.localeCompare(b.type)))
        .map(Z => ({
          type: Z.type, area: Z.area, occ: Z.occ, tot: Z.tot,
          occArea: R(Z.occ_area), totalArea: R(Z.mla_area),
          grossPotential: R(Z.gpot), actualOccupied: R(Z.act_occ),
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
    // unitRows: ADDED 14 Jul 2026 for two District Manager-style widgets (task #174, from Michael's
    // live DM screenshots): "Watchdog — Discounted Units in Fully Occupied Groups" (per-unit standard
    // vs actual rate, cross-referenced against rental_activity's per-(type,size)-group vacancy) and
    // "Unit Groups — Stay & Re-Lease"'s avg-stay-per-group column. RentRoll's per-row data was already
    // being read for the aggregate sums above and then discarded — this keeps the per-unit identity
    // instead. groupKey = type + rounded area, since RentRoll has no separate width/length columns
    // (only combined Area) — approximates rental_activity's true (type,size) grouping closely enough
    // in practice since unit sizes within a facility are standardized (e.g. 5x10=50 sqft). Unit NAME
    // is a storage-unit label, not tenant PII (no tenant name/company kept here).
    // all/ss carry the raw SUMS (not yet divided) so buildPayload.js can re-aggregate correctly
    // across sites/filters by summing these first, rather than averaging already-divided rates.
    const all = { area: 0, rent: 0, stdRent: 0 }, ss = { area: 0, rent: 0, stdRent: 0 };
    const types = {}, cust = { business: { units: 0, area: 0, rent: 0 }, residential: { units: 0, area: 0, rent: 0 } };
    const occupiedTenantIds = [];   // for cross-referencing against ReservationList's "active" rows (see `reservations` below)
    const autobillTenantIds = [];   // for Autobill Conversion's "new autobilled customers" cross-reference (see move_ins_outs above)
    const unitRows = [];
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
      let leaseDays = null;
      if (!isBlankDate(r.dLeaseDate)) {
        const d = (now - new Date(r.dLeaseDate)) / 86400000;
        if (d > 0) { stayDays += d; stayN++; leaseDays = R(d); }
      }
      const areaR = Math.round(a);
      // ledgerId/areaExact ADDED 22 Jul 2026 (task #308) for the new billing-adjusted Rate calc in
      // buildPayload.js — ledgerId to join against the billing_frequency report; areaExact (2dp,
      // unrounded) so that join reproduces the exact-match confirmation from
      // scripts/probe-r6-formula-preview.js rather than accumulating the ~0.5sqft/unit rounding
      // already baked into `area` (Math.round to a whole sqft, used elsewhere for grouping/display).
      unitRows.push({ unit: str(r.sUnit), type: t, area: areaR, areaExact: R2(a), groupKey: `${t}|${areaR}`, stdRate: R2(stdRent), rent: R2(rent), leaseDays, ledgerId: str(r.LedgerID) });
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
      // unit_rows: per-occupied-unit rows (ADDED 14 Jul 2026, task #174/#203) — see comment above `const
      // unitRows = []` for why this exists (Watchdog-Discounted-Units + Unit Groups Stay&Re-Lease
      // widgets). Only exposed on the full/current-month payload record (buildPayload.js gates this,
      // matching the existing unitMix convention) to keep other months' payloads light.
      unit_rows: unitRows,
    };
  }},
  // Billing Frequency (custom report "Custom\Billing Frequency", ReportID 999824) — ADDED 22 Jul 2026
  // (task #308). R6 told Michael billing frequency is "in the Rent Roll report" and confirmed it's
  // real but "not all this information will be available in the front end" — meaning it's read from
  // R6's own warehouse sync of SiteLink's underlying data, not the public SOAP RentRoll call this
  // project uses. A full-session exhaustive search across every column of every report on both WSDLs
  // never found it there (correctly — it was never going to). Found instead by pulling
  // CustomReportListByCorp (SiteLink's catalog of account-specific custom reports beyond the ~60
  // standard ones) and spotting a report literally titled "Custom\Billing Frequency". One row per
  // LedgerID, sBillingFreqDesc a plain string ("28 Days" for 4-weekly billers — confirmed 89% of
  // Bicester's occupied tenants are on this plan, contrary to the initial assumption that 4-weekly
  // billing was rare). Cross-checked against an independent empirical measurement (actual Rent
  // charge-period lengths via ChargesAndPaymentsByLedgerID: ~28-day spans vs ~30-31-day spans) before
  // trusting it. Single small flat table, no multi-table extraction needed (confirmed via
  // scripts/probe-billing-frequency-report.js). Feeds rent_roll's Rate calculation in buildPayload.js
  // — see recordFor()'s matching comment for the full formula and legacy-match confirmation.
  billing_frequency: { customReportId: 999824, dated: true, parse: (rows) => {
    const byLedger = {};
    for (const r of rows) {
      const id = str(r.LedgerID);
      if (id) byLedger[id] = str(r.sBillingFreqDesc);
    }
    return { by_ledger: byLedger };
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
  // WHY startDate/endDate ARE ACCEPTED BUT NEVER USED BELOW (documented 17 Jul 2026, full-portal
  // review — this question was already investigated and closed on 8 Jul as task #95, "ManagementSummary
  // range bug", but the reasoning only lived in 3 probe scripts deleted in the 8 Jul cleanup pass
  // [recoverable via `git show 3fd6767:scripts/probe-rangebug-recheck.js`], not here — adding it now so
  // a future audit doesn't re-flag this blind): unlike lead_funnel/insurance_roll/rate_changes, this
  // report's iDCount/iMCount/iYCount are SiteLink's OWN Day/Month/Year-TO-DATE counters, not raw dated
  // events — iMCount for a call ending on date X is already cumulative from the 1st of that calendar
  // month through X, so there's no independent per-row date to filter by even if we wanted to. The
  // apparent 8 Jul "bug" (summing 30 single-day iMCount reads gave a 12-25x inflated total vs one
  // multi-day call) was the OLD PROBE double-counting that same cumulative total 30 times over, not a
  // real defect. Reading iMCount off ONE call is correct — PROVIDED that call's startDate is aligned to
  // the 1st of the month, which holds for every current call site (lib/pull.js, scripts/backfill.js,
  // repull-report-month.js, repull-report-all-months.js, backfill-rentroll-gaps.js all operate on whole
  // months; buildPayloadRange()'s custom-range picker merges already-stored whole-month records rather
  // than issuing a fresh sub-month live call here). If a future change ever calls ManagementSummary with
  // a non-month-aligned startDate, iMCount would silently read as the WHOLE month instead of the
  // narrower window — that invariant, not a client-side gate, is what keeps this correct.
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
    // var_from_std_rate: ADDED 9 Jul 2026 for the "Move-in Variance vs Standard Rate" KPI widget
    // (Michael's "build both" decision) — whole-book half of it. VarFromStdRate is another table
    // hidden in this same 9-table response: a live, portfolio-wide histogram of every currently-
    // occupied unit bucketed by how far its rent sits from standard rate. Confirmed via a live probe
    // (9 Jul 2026): 5 buckets (<0%, 0-15%, 15-30%, 30-50%, >50%), counts summed to 314 at L001 — sane
    // against ~348 total units there. This is a snapshot regardless of the date range passed in (same
    // "live, not true history" class as RentRoll/OccupancyStatistics), so it's only ever "as of now",
    // not a real per-month historical figure — same caveat as everything else built on a SiteLink
    // report of this kind.
    const varFromStdRate = extractNamedTable(raw, 'VarFromStdRate').map((r) => ({
      bucket: str(r.sVarFromStdRateCat), count: num(r, 'VarFromStdRateCount'), sortId: num(r, 'SortID'),
    }));
    return {
      move_ins: f(/move.?in/i).mo, move_outs: f(/move.?out/i).mo, move_outs_year: f(/move.?out/i).y,
      transfers: f(/transfer/i).mo, net_area: f(/rented area increase/i).mo,
      phone_leads: f(/phone lead/i).mo, web_leads: f(/web lead/i).mo, walkin_leads: f(/walk.?in lead/i).mo,
      leads_converted: f(/leads converted/i).mo, insured_moveins: f(/^insurance$/i).mo,
      delinquent_30plus_total: Math.round(delinquent30Total), delinquent_30plus_units: delinquent30Units,
      var_from_std_rate: varFromStdRate,
    };
  }},
  // MoveInsAndMoveOuts = one row per move event. Net ft² = moved-in area − moved-out area.
  // FIXED 23 Jul 2026 (task #406/#409, Michael: "abingdon shows 0 reservations/move-ins in the daily
  // snapshot" — confirmed real: a genuine 125sqft move-in, Boyles/Casper, 22 Jul). Root cause: `rows`
  // (the arg below) is always extractRows()'s pick (lib/sitelink.js), which can only ever return an
  // ARRAY — but node-soap/xml2js does not array-wrap a repeated element that occurs EXACTLY ONCE, so a
  // genuine single real move event comes through as a bare object, invisible to extractRows() (confirmed
  // live via probe-mio-single-row-fields.js: the real row sat at NewDataSet.UnitMoveInsAndMoveOuts as a
  // plain object with MoveIn:'1', MoveDate, TenantName, MovedInArea etc. — SiteLink's own
  // Totals.iTotalMovedIn independently agreed there was exactly 1). extractNamedTable() (lib/sitelink.js,
  // same date) is now fixed to also recognize that bare-object shape, unlike extractRows() — so prefer
  // it via `raw` whenever raw is available, falling back to the passed-in `rows` otherwise (keeps this
  // safe for any caller that doesn't thread raw through). Reached two ways: reportMap.js's own
  // pullReport() dispatcher below (main historical pipeline — already threads raw through positionally,
  // and the query window itself is unchanged by this fix, only whether a single row within it is seen)
  // and pullSnapshot.js (Daily/Weekly/Quarterly Snapshot — updated same date to derive its own rows via
  // extractNamedTable(mio.raw, …) BEFORE its local MoveDate trim, and deliberately still calls this
  // function with only `rows`, no `raw`, so its trim isn't bypassed by a second raw-based re-derivation
  // here — see that file's own comment).
  move_ins_outs: { method: 'MoveInsAndMoveOuts', dated: true, parse: (rows, startDate, endDate, raw) => {
    const effectiveRows = raw ? extractNamedTable(raw, 'UnitMoveInsAndMoveOuts') : rows;
    const R = Math.round; let mi = 0, mo = 0, inArea = 0, outArea = 0, inRateSum = 0, movedInVarianceSum = 0, movedInStdRateSum = 0; const moveInTenantIds = [];
    // movedInVarianceSum / movedInStdRateSum — ADDED 21 Jul 2026 (Rich's portal review, task #360):
    // fixes "Move-in Variance vs Standard Rate" pulling from the wrong report. This report's own rows
    // already carry MovedInVariance and StandardRate per move-in (confirmed live via Rich's supplied
    // Move_in_Move_out PSF and Variance.xlsx — the "sitelink" sheet is a raw MoveInsAndMoveOuts export
    // with exactly these two column names). Rich's reference workbook's RPSF sheet computes, per
    // store/period, for MoveIn=1 rows only: Total Discount = Σ MovedInVariance ÷ Σ StandardRate, then
    // Actual = Total Discount − 8.33% (a natural, expected variance from monthly vs 4-weekly billing-
    // cycle differences, not a data error — Rich's own words, and the same 8.33%/(13÷12−1) constant
    // independently found in task #308's Bicester rate-annualization probe). Summed raw here (no
    // dedup — the reference workbook's SUMIFS sums every MoveIn=1 row as-is, and unlike Discounts this
    // report is already one row per move event, not one row per charge line), buildPayload.js divides
    // once at the aggregate level, same sum-then-divide-once convention as every other rate in this
    // file. This SUPERSEDES both prior "Move-in Variance" sources for the KPI widget: the Discounts
    // report's dcVariance-based this-period average (still computed below for Discount Summary's own
    // use, just no longer feeds this widget) and ManagementSummary's whole-book VarFromStdRate bucket
    // histogram (kept, relabeled to describe what it actually is — see page.js).
    for (const r of effectiveRows) {
      if (yes(r.MoveIn)) {
        mi++; inArea += num(r, 'MovedInArea');
        // MovedInRentalRate ADDED 6 Jul 2026 for the new "Move-In Rental Rate" KPI widget (Michael's
        // uploaded MoveInsAndMoveOuts export — column 13, "MovedInRentalRate" — divided by area).
        // Summed raw here (numerator); buildPayload.js divides by the summed MovedInArea and
        // annualises ×12, same sum-then-divide convention as every other rate/ft² figure in this file.
        inRateSum += num(r, 'MovedInRentalRate');
        movedInVarianceSum += num(r, 'MovedInVariance');
        movedInStdRateSum += num(r, 'StandardRate');
        if (r.TenantID != null) moveInTenantIds.push(String(r.TenantID));
      }
      if (yes(r.MoveOut)) { mo++; outArea += num(r, 'MovedOutArea'); }
    }
    // move_in_tenant_ids: for Autobill Conversion ("new autobilled customers / total new customers"
    // per the legacy tooltip, confirmed 2 Jul 2026 — a DIFFERENT formula than the whole-book autobill
    // rate this file used before). Confirmed working for Autobill Conversion's cross-reference against
    // RentRoll's autobill_tenant_ids — TenantID DOES work here, it's specifically InquiryTracking's
    // TenantID (a different ID space) that doesn't cross-reference against this report.
    // move_in_email_hashes — REMOVED 17 Jul 2026 (task #310): was already unread by buildPayload.js
    // (the Enquiry -> Move-In fix on 7 Jul moved to a plain move-ins÷enquiries ratio instead), see
    // emailHash's own removal note near the top of this file.
    return { move_ins: mi, move_outs: mo, net_units: mi - mo, moved_in_area: R(inArea), moved_out_area: R(outArea), net_area: R(inArea - outArea), move_in_tenant_ids: moveInTenantIds, moved_in_rental_rate_sum: R2(inRateSum), moved_in_variance_sum: R2(movedInVarianceSum), moved_in_std_rate_sum: R2(movedInStdRateSum) };
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
  // FIXED 16 Jul 2026 (Michael's manual audit: "Scheduled res vs Scheduled move ins was off") —
  // ScheduledMoveOuts, like ReservationList, ignores any date-range parameter and always returns
  // its FULL current list (confirmed live via raw_response: a Jul-scoped pull for Bicester
  // returned rows dated back to 6 May 2026 — over 2 months stale). Unlike ReservationList though,
  // this parser had NO date filter at all — every row, however old, was counted as a "scheduled
  // move-out." Portfolio-wide check (16 Jul 2026): 26 of 262 current rows (~10%) had a dSchedOut
  // already in the past. Now mirrors the reservations parser's forward-looking convention: only
  // count rows whose scheduled move-out date hasn't passed yet. No cancellation/status field
  // exists on this report (confirmed via raw_response — only UnitID/sFName/sLName/LedgerID/
  // TenantID/dSchedOut/sUnitName/attributes), so a past-due dSchedOut is the only signal available
  // that a row is stale/orphaned.
  scheduled_outs: { method: 'ScheduledMoveOuts', dated: true, parse: (rows) => {
    const isBlank = (v) => v === undefined || v === null || v === '' || v === '0001-01-01T00:00:00';
    const now = new Date();
    let upcoming = 0, stale = 0;
    for (const r of rows) {
      const d = isBlank(r.dSchedOut) ? null : new Date(r.dSchedOut);
      if (d && d >= now) upcoming++; else stale++;
    }
    return { scheduled_move_outs: upcoming, scheduled_move_outs_stale: stale, scheduled_move_outs_total: rows.length };
  } },
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
    let newCount = 0, newPremium = 0, newCoverage = 0;
    for (const r of rows) {
      if (!yes(r.iActive)) continue;   // active policies only → penetration ≤ 100%
      insured++; premium += num(r, 'dcPremium'); coverage += num(r, 'dcCoverage');
      if (inSourceDayWindow(r.dMovedIn, startDate, endDate)) { newCount++; newPremium += num(r, 'dcPremium'); newCoverage += num(r, 'dcCoverage'); }
    }
    return {
      insured_units: insured, monthly_premium: R2(premium), total_coverage: R(coverage),
      insured_new_customers: { count: newCount, premiumSum: R2i(newPremium), coverageSum: R2i(newCoverage) },
    };
  }},
  // InsuranceActivity = policy events in period. New policies / cancellations / new-customer premium.
  // FIXED 17 Jul 2026 (full-portal review follow-up, npm run probe:insurance-activity +
  // probe:multitable-discards): two compounding bugs, found via live evidence at L001 —
  // rowCount/newPol/cancelled all read EXACTLY equal (349/349/349 Jun, 244/244/244 Jul), i.e. every
  // single row was being counted as BOTH a new policy AND a cancellation, which is a "whole book
  // cancels every month" impossibility, not a real cancellation rate.
  //   1. This is a MULTI-TABLE SOAP response (same class as ManagementSummary/True Revenue,
  //      confirmed via probe:multitable-discards) — two tables, `Insur_InsuranceActivity` (has
  //      sNewPolicy/sCancelledPolicy/bCancelled/dcPremium — what this parser actually needs) and
  //      `Insur_InsuranceActivityAcc` (a per-account payment ledger with NONE of those columns).
  //      extractRows() picks whichever is numerically bigger for that specific site/month — which
  //      flips unpredictably (confirmed: L029/Jun had Acc at 196 rows > Activity's 33), so some
  //      sites/months silently read the WRONG table (every sNewPolicy/etc read undefined → parser
  //      quietly returns all zeros) while others happen to get the right one. Switched to
  //      extractNamedTable(raw, 'Insur_InsuranceActivity') so it's selected by NAME, not size —
  //      same fix pattern already used for management's Unpaid/VarFromStdRate and true_revenue's
  //      Table1.
  //   2. EVEN when the right table was picked, `str(r.sNewPolicy)` / `str(r.sCancelledPolicy)` are
  //      broken checks — str() is a pure stringify (String(v ?? '').trim()), so a SiteLink Y/N-style
  //      string field reads as a non-empty, therefore TRUTHY, string even when its value is "N". That
  //      explains the exact rowCount-for-rowCount match: every row with ANY value in these columns
  //      (Y or N) counted as both new and cancelled. Switched both to yes() — the proper Y/N-semantic
  //      helper already used correctly for bCancelled right next to it, and throughout this file for
  //      every other Y/N-string SiteLink field.
  // NOT YET CONFIRMED (flagging rather than guessing): whether Insur_InsuranceActivity's rows are
  // already trimmed to the requested [startDate,endDate] window server-side, or — like
  // InquiryTracking before its dPlaced fix — return a wider working set that would need a client-side
  // filter on dActivity (or dMovedIn/dPaidThru, both also present on this table). Re-run
  // npm run probe:insurance-activity after this deploys and compare row counts across a couple of
  // different months before treating the date-window question as closed.
  insurance_activity: { method: 'InsuranceActivity', dated: true, parse: (rows, startDate, endDate, raw) => {
    let newPol = 0, cancelled = 0, newPrem = 0;
    const activityRows = extractNamedTable(raw, 'Insur_InsuranceActivity');
    for (const r of activityRows) {
      if (yes(r.sNewPolicy)) { newPol++; newPrem += num(r, 'dcPremium'); }
      if (yes(r.sCancelledPolicy) || yes(r.bCancelled)) cancelled++;
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
  // FIXED 20 Jul 2026 (task #325, same failure class as insurance_activity/management/true_revenue):
  // InquiryTracking's SOAP response is MULTI-table (Summary/Activity/Employees/Marketing/InquirySource),
  // but this parser used to receive `rows` from callReport()'s extractRows(), which only ever keeps
  // whichever table is numerically LARGEST — and "Marketing" (a per-marketing-SOURCE aggregate table,
  // columns SiteID/iTotal/Column1/iConverted/sMarketingDesc, no per-row date at all) has a fixed 15
  // rows portfolio-wide, while "Activity" (the real per-inquiry-event table this parser actually needs,
  // with dPlaced/sInquiryType/sRentalType/TenantID) varies month to month — so whichever one happened to
  // have MORE rows that month won essentially at random. Confirmed via
  // npm run probe:leadfunnel-tables checking all 2059 stored (site,month) pairs: 6 genuine cases where
  // Marketing was kept despite Activity (with a working dPlaced) existing for that exact site/month —
  // L005/2021-04, L017/2023-11, L021/2024-10, L025/2025-12, L026/2025-12, and L029/2026-06 (that last
  // one only a month old at the time this was found). Those site/months would have silently computed
  // Enquiries/Reservations from Marketing's aggregate rows instead, which have no dPlaced field to gate
  // on at all. Fix: use extractNamedTable(raw, 'Activity') instead of extractRows()'s size-based pick,
  // same pattern as the other 3 fixes.
  // NOTE — a separate, much larger-LOOKING but NOT a bug: the same probe also found 995 site/months
  // where dPlaced isn't on ANY table at all. Checked the actual column dumps rather than trusting that
  // number blind (a probe bug already burned us once today) — every one of the ~15 sampled is from
  // 2020-2021, and Activity's OWN column list for that era has no dPlaced (just dLease and others) —
  // some sites/months from that period don't even have an Activity table, only Summary/Marketing/
  // InquirySource. This is SiteLink's own report schema evolving over time (dPlaced was added to this
  // report at some point after 2021), not an extraction bug — switching to extractNamedTable('Activity')
  // doesn't and can't fix genuinely-absent historical data; those old months will keep reading as zero
  // via this path exactly as before, no regression, no false fix.
  lead_funnel: { method: 'InquiryTracking', dated: true, parse: (rows, startDate, endDate, raw) => {
    // Compares calendar DATES only (ignoring time-of-day) so a closed month's endDate — which
    // pull.js sets to midnight of the last day, not 23:59:59 — doesn't silently clip that day's
    // later inquiries. dPlaced confirmed present and correctly parseable on live SOAP rows via
    // probe:enquiries-dplaced (exact portfolio-wide match against legacy).
    const activityRows = extractNamedTable(raw, 'Activity');
    const isPlacedInWindow = (r) => inSourceDayWindow(r.dPlaced, startDate, endDate);
    const isReservationStage = (r) => str(r.sRentalType).toLowerCase() === 'reservation';
    const channels = {}; let phone = 0, walkin = 0, web = 0, email = 0, other = 0, conv = 0, res = 0, biz = 0;
    // TenantID / email-hash / phone-hash cohort-matching (3-17 Jul 2026, several iterations — see git
    // history around task #301/#303) — REMOVED 17 Jul 2026 (task #310). All of them were trying to
    // trace an individual lead from their enquiry-stage row to a later reservation-stage row (by
    // TenantID, then email, then email+phone, then with a same/previous-month lookback window) to
    // build a per-lead-cohort conversion rate. Michael pinned down legacy's real June 2026 portfolio
    // rate at 19.8% (confirmed live) — nowhere near any cohort-matched figure we produced (low single
    // digits to ~10%). Later frozen-raw-response rechecks (23 Jul 2026, probe-reservation-reparse-
    // check.js) confirmed our own stored June ratio is ~14.4-14.5% on the same plain COUNT RATIO
    // definition below, not the older 23.9% note some earlier comments recorded. The key conclusion
    // that survives both checks is methodological, not the exact percentage: legacy isn't tracking
    // individual leads here at all — just dividing two independent aggregates, same as the Enquiry ->
    // Move-In tile already does. reservationStageCount below (unchanged, added 6 Jul for the
    // "Reservations vs Move-outs" widget) is now ALSO the numerator for Enquiry -> Reservation — see
    // buildPayload.js's reservationConversions.
    // reservationStageCount: ADDED 6 Jul 2026 for the "Reservations vs Move-outs" widget rebuild
    // (Michael's idea) — InquiryTracking is `dated: true` and confirmed via
    // npm run probe:lead-funnel-reservations to give genuinely different, plausible counts per
    // month (unlike ReservationList, which has no date param and is always relative to today, or
    // ScheduledMoveOuts, which takes a date param but returns an identical count regardless of it).
    // This is just a plain row count of isReservationStage(r) for the requested period — a real
    // historical "new reservations made this month" flow metric, sourced from the same report that
    // already correctly powers Enquiries per-month.
    // BUG FIX 17 Jul 2026 (task #308→ reopened by Michael's live check: July MTD read 28.8% here vs a
    // legacy target of ~12.6%, a much bigger miss than June's 23.3%-vs-19.8%): this counter was NOT
    // gated by isPlacedInWindow at all — it counted every isReservationStage(r) row anywhere in `rows`,
    // full stop. That's the exact same failure mode already root-caused for Enquiries itself (see the
    // big comment above this parser, 8 Jul 2026): InquiryTracking's raw rows are NOT already trimmed to
    // the requested window — SiteLink returns rows for a wider working set, and the ENQUIRY counts only
    // look right because they're explicitly filtered down via dPlaced. reservationStageCount had no such
    // filter, so it was silently summing in reservation-stage rows placed outside the requested window
    // too. A fixed-size leak like that barely shows on a full closed month (June: leak ÷ ~30 days of
    // enquiries is a small % move) but massively distorts a partial in-progress month (July 1-17: the
    // same-size leak ÷ a much smaller 17-day enquiry denominator) — exactly the pattern Michael is
    // seeing. Fix: gate it by isPlacedInWindow(r) too, same as every other counter below, so it only
    // counts reservation-stage rows actually dated inside the requested window.
    let reservationStageCount = 0;
    const inquirySourceRows = extractNamedTable(raw, 'InquirySource');
    let inquirySourceTotal = 0, inquirySourceConverted = 0;
    const inquirySourceChannels = {};
    for (const r of activityRows) {
      const placedInWindow = isPlacedInWindow(r);
      if (placedInWindow && isReservationStage(r)) reservationStageCount++;
      if (!placedInWindow) continue;
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
      if (yes(r.iReservationConvertedToLease) || /reserv/i.test(str(r.sCallType))) res++;   // kept for back-compat only — confirmed unreliable, unused (see reservation_stage_count)
      if (yes(r.bCommercial)) biz++;
    }
    for (const r of inquirySourceRows) {
      const label = str(r.sInquiryType) || 'Unknown';
      const total = num(r, 'iTotal');
      const converted = num(r, 'iConverted');
      inquirySourceTotal += total;
      inquirySourceConverted += converted;
      const o = (inquirySourceChannels[label] ??= { enquiries: 0, converted: 0 });
      o.enquiries += total;
      o.converted += converted;
    }
    return {
      phone, walkin, web, email, other,
      web_combined: web + email,               // spec's displayed "Web" tile (Web Count + Email Count)
      total_enquiries: phone + walkin + web + email,   // spec's Total — the 4 raw counts, "other" excluded
      conversions: conv, reservations: res, business_enquiries: biz, channels,
      reservation_stage_count: reservationStageCount,
      inquiry_source_total: inquirySourceTotal,
      inquiry_source_converted: inquirySourceConverted,
      inquiry_source_channels: inquirySourceChannels,
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
  // FIXED 16 Jul 2026 (Michael, external verification against real SiteLink exports: "Rate Increases
  // by Store = 834 for a 348-unit store... not credible") — confirmed live via stored raw_response:
  // SiteLink ignores the start/end date range on this report, same as RentRoll/OccupancyStatistics —
  // a call scoped to June 2026 for Bicester returned 878 rows total, including one with
  // dLRateFrom: "2025-01-21" (a year and a half outside the requested window). The parser had no
  // client-side date check at all, so it was counting every rate change in the site's ENTIRE history
  // as if it happened "this month". Each row carries its own effective date on dLRateFrom — filter to
  // rows whose dLRateFrom falls in the period actually being pulled for, same inWindow() pattern as
  // insurance_roll's dMovedIn filter above.
  rate_changes: { method: 'TenantRentChangeHistory', dated: true, parse: (rows, startDate, endDate) => {
    let increases = 0, decreases = 0, sumPct = 0, n = 0;
    for (const r of rows) {
      if (!inSourceDayWindow(r.dLRateFrom, startDate, endDate)) continue;
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
  // enum meanings, and live testing found status/type codes don't cleanly separate "still open"
  // reservations beyond the cancelled/future-date filter above — this is the best-effort
  // interpretation until SiteLink support confirms the exact status codes.
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
  // SiteLink support or an on-screen label to fix this properly. Current count (~1413) only has
  // the two CONFIRMED-good fixes below applied.
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
    // activeByType — ADDED 6 Jul 2026 for Reserved Scheduled Sqft (see rent_roll's unit_type_areas
    // comment). CHANGED 21 Jul 2026 (Rich's portal review, task #359 — "Is reserved sqft working?"):
    // was a plain per-type COUNT, which meant buildPayload.js's reservedSqftEstimate couldn't apply
    // the SAME already-converted-to-tenant exclusion that activeReservations gets (cross-referencing
    // against RentRoll's occupied_tenant_ids — a reservation that already converted to a lease but
    // whose ReservationList row was never formally closed out, ~51 rows portfolio-wide per that
    // comment). Now a per-type ARRAY of tenant IDs instead of a count, so buildPayload.js can filter
    // each type's list the same way before counting. Note: the OLDER, larger "~3x overcount" (Task
    // #25, QTRentalTypeID) was NEVER actually inherited by this field the way a stale comment in
    // buildPayload.js claimed — activeByType is populated below, AFTER the QTRentalTypeID===2 filter
    // (b) already ran, so it was always built from the same corrected population as active_reservations.
    const activeByType = {};
    for (const r of rows) {
      const isCancelled = !isBlank(r.dCancelled);
      const needed = isBlank(r.dNeeded) ? null : new Date(r.dNeeded);
      if (isCancelled) { cancelled++; continue; }
      if (!(needed && needed > now)) continue;
      if (!isBlank(r.QTCancellationTypeID) && Number(r.QTCancellationTypeID) !== 0) { cancelTypeSet++; continue; }   // (a)
      if (Number(r.QTRentalTypeID) !== 2) { excludedNotReservationType++; continue; }   // (b) FIXED 6 Jul 2026 — Task #25
      active++; activeTenantIds.push(String(r.TenantID));
      const utid = str(r.UnitTypeID);
      if (utid) (activeByType[utid] ??= []).push(String(r.TenantID));
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
  true_revenue: { customReportId: 781861, dated: true, parse: (rows, startDate, endDate, raw) => {
    const R2v = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    // FIXED 15 Jul 2026 (Michael's Phase 3 side-by-side spot check found the Financials page's "True
    // Revenue — Unit Types" table running substantially low vs legacy): same bug class as the
    // ManagementSummary/Delinquency fix above — extractRows() keeps only the SINGLE LARGEST table in
    // a multi-table SOAP response, discarding the rest. Custom report 781861 actually returns THREE
    // tables (confirmed live via scripts/probe-truerevenue-coverage.js's Check #1): `Table` (17
    // rows/site-summary), `Table1` (36 rows — exactly one row per (ChargeDesc, UnitType) combination,
    // SiteLink's OWN pre-aggregate — this matches this parser's design comment below to the letter),
    // and `Table2` (1853+ rows — one row per individual charge/day-prorated transaction line, NOT one
    // row per combination). extractRows() was keeping `Table2` (by far the largest) and silently
    // discarding `Table1`, so `groupBy()` below was summing per-transaction/per-day-prorated rows
    // instead of SiteLink's own already-correct per-combination rollup — plausible double-counting
    // wherever a single charge is broken across multiple daily-prorate line items within Table2, which
    // this custom report's own name ("...Daily Prorate") suggests is exactly what it does. Switching
    // to `Table1` via extractNamedTable() (rather than the `rows` argument, which is still whatever
    // extractRows() happened to keep) fixes this without touching lib/pull.js — pullReport() already
    // passes `raw` as parse()'s 4th argument to every report, same as `management` above.
    const trRows = extractNamedTable(raw, 'Table1');
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
      for (const r of trRows) {
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
    // period_days ADDED 10 Jul 2026 — CONFIRMED via scripts/probe-truerevenue-period-granularity.js
    // that TruePeriod scales ~linearly with the elapsed days in [startDate,endDate] (10d window was
    // 31.0% of a complete 30-day month's total, vs 33.3% expected for pure day-proration): TruePeriod
    // is NOT a month-bucketed figure that ignores the exact end date, it's a real period sum. Real
    // Rate (buildPayload.js) used to always x12 this as if it were exactly one month — correct for a
    // complete month, a ~3x understatement for the in-progress current month (e.g. July 1-10). Michael
    // (10 Jul 2026): keep showing the live current month, but annualise correctly — 365/period_days
    // instead of a blind 12. Carried here (not computed in buildPayload.js) since start/end are only
    // available at parse time.
    const period_days = (startDate && endDate) ? Math.round((endDate - startDate) / 86400000) + 1 : null;
    return { by_desc: groupBy('ChargeDesc'), by_type: groupBy('UnitType'), period_days };
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
  // Discounts = one row per active discounted CHARGE LINE within the period (confirmed 9 Jul 2026 via
  // live probes — NOT a summary, a genuine per-tenant/per-charge report). "DiscountSummary" is not
  // a callable API method, and UnitStatus itself also is not — though a separate UnitsInformation*
  // family was confirmed on CallCenterWs on 21 Jul 2026 and may eventually cover some unit-level
  // use cases once its returned columns are verified.
  // This report drives two different widgets:
  //   1. Discount Summary page — which plans are in use, by how many customers, how much £ discount.
  //      Grouped by sConcessionPlan. Counts are DEDUPLICATED by unit: a unit on a ~28-day billing
  //      cycle can generate 2 charge rows inside one calendar month (confirmed live — G019/S047A/
  //      G015/L004 each had 2 rows, different ChargeIDs, ~4 weeks apart — genuine separate billing
  //      events, not a bug), so a unit billed twice in the window isn't counted twice as a customer.
  //      £ totals are NOT deduplicated — every charge line's discount genuinely happened, summed as-is.
  //      Michael chose this "monthly flow" definition over a right-now snapshot (2nd AskUserQuestion,
  //      9 Jul 2026): a snapshot can't be scheduled/pulled automatically and would share RentRoll/
  //      OccupancyStatistics' "live only, not true history" problem; a date-ranged flow metric gives a
  //      real, reproducible number for any past month, same as every other monthly widget here.
  //   2. Move-in Variance vs Standard Rate (this-period half — the whole-book half is management's
  //      var_from_std_rate above). Every row already carries dMovedIn (the tenant's real move-in
  //      date), dcStdRateAtMoveIn, and dcVariance (SiteLink's own precomputed variance) — filtering to
  //      dMovedIn within the period being pulled for gives "for people who moved in THIS month, how
  //      did their rate compare to standard", no join against a separate report needed. Restricted to
  //      sChgDesc === "Rent" rows: a lease's non-rent charge lines (e.g. "Service Fee") carry the same
  //      dcStdRateAtMoveIn/dcVariance duplicated across every row for that lease, but Rent is the
  //      unambiguous one to key off. Deduplicated by unit for the same billing-cycle-overlap reason as
  //      above — variance is a lease property, shouldn't be double-weighted from a billing overlap.
  //      Returns raw sum + count (not a pre-divided average) — buildPayload.js divides once at the
  //      aggregate level, same sum-then-divide-once convention as every other rate in this file.
  // PII: sName/sCompany/sBy (tenant/staff names) exist on every row — read here only to compute
  // aggregates, never stored, same rule as every other report in this file.
  discounts: { method: 'Discounts', dated: true, parse: (rows, startDate, endDate) => {
    const byPlan = {};
    // FIXED 21 Jul 2026 (task #396, portal audit — "verify Discount Summary double-counting"):
    // byPlan's Set() is scoped PER PLAN, so a unit that carries discounted charge lines under two
    // different plans this month (e.g. it switched plans mid-month) correctly counts as 1 in EACH
    // plan's own row — that's right, it really is on both plans. But the Discount Summary page's
    // top-line "Units on a Discount Plan" stat card was getting its number by summing these already-
    // per-plan-deduped counts (planRows.reduce((a,r)=>a+r.units,0) in page.js), which double-counts
    // any unit spanning >1 plan even though its own tooltip claims "deduplicated by sUnitName".
    // allUnits is a SEPARATE, portfolio-plan-agnostic Set built from every row regardless of which
    // plan it's under, giving this site's true distinct-unit count — buildPayload.js sums this
    // across sites (safe, a unit belongs to exactly one site) into the real top-line total instead.
    const allUnits = new Set();
    for (const r of rows) {
      const plan = normalizeDiscountPlan(r.sConcessionPlan);
      const p = (byPlan[plan] ??= { units: new Set(), discountSum: 0 });
      const unit = str(r.sUnitName);
      p.units.add(unit);
      allUnits.add(unit);
      p.discountSum += num(r, 'dcDiscount');
    }
    const discountPlans = Object.entries(byPlan)
      .map(([plan, p]) => ({ plan, units: p.units.size, discount: R2(p.discountSum) }))
      .sort((a, b) => b.units - a.units);

    const seenUnits = new Set(); let moveInVarianceCount = 0, moveInVarianceSum = 0;
    for (const r of rows) {
      // FIXED 10 Jul 2026 (pre-go-live audit, defensive hardening): was an exact-case === 'Rent' match,
      // inconsistent with this codebase's own established defensive pattern for charge-description
      // matching elsewhere (buildPayload.js's Self Storage revenue match uses .toLowerCase().includes).
      // Not confirmed live-broken, but if SiteLink ever returns different casing this widget would
      // silently read 0/0 for that site/month with no log — cheap to close off now.
      if (str(r.sChgDesc).toLowerCase() !== 'rent' || !r.dMovedIn || !startDate || !endDate) continue;
      if (!inSourceDayWindow(r.dMovedIn, startDate, endDate)) continue;
      const unit = str(r.sUnitName);
      if (seenUnits.has(unit)) continue;
      seenUnits.add(unit);
      moveInVarianceCount++; moveInVarianceSum += num(r, 'dcVariance');
    }
    return {
      discount_plans: discountPlans,
      discount_units_total: allUnits.size,
      move_in_variance_count: moveInVarianceCount,
      move_in_variance_sum: R2(moveInVarianceSum),
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
