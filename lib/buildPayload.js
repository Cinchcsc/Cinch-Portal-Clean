// Assemble the single JSON document the portal reads (portal_payload.payload).
// Emits: `sites` (full detail for the current month), `monthly` (LIGHT per-site record for EVERY
// stored month — powers date-range / compare / multi-store), `history` (portfolio trend per month),
// `totals`, and `months`. No tenant PII — only the aggregated objects from reportMap.parse().
import { admin } from './supabaseAdmin.js';
import { computeRewoundOccupiedArea } from './rewindOccupiedArea.js';
import { REPORTS } from './reportMap.js';
import { formatLocalYmd, lastCompleteDay, reportingCurrentMonthStart, reportingPreviousMonthStart } from './reportingPeriod.js';
import { extractNamedTable, extractRows } from './sitelink.js';
import { retryOnStatementTimeout } from './supabaseRetry.js';

// Bump this ONLY when a code change materially alters persisted historical/monthly payload semantics
// and the stored singleton therefore needs a real full-history rebuild rather than the normal cheap
// "fresh current month merged into stored history" daily refresh path.
export const PORTAL_PAYLOAD_BUILD_VERSION = '2026-08-03-debtors-alloverdue-v2';

const monthParts = (d) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
const ym = (d) => {
  const { year, month } = monthParts(d);
  return `${year}-${String(month).padStart(2, '0')}`;
};
const monthStartFromDate = (d) => {
  const { year, month } = monthParts(d);
  return new Date(year, month - 1, 1);
};
const timestampMs = (value) => {
  const ms = value ? new Date(value).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
};
const timestampIso = (value) => {
  const ms = timestampMs(value);
  return ms ? new Date(ms).toISOString() : null;
};
// nextMonthKey: ADDED 24 Jul 2026 (task #308/#404/#405) — used to gate the Real Rate rewind below to
// exactly the case it's valid for (rewinding INTO the month immediately before "current", using
// current's own live-so-far data — see lib/rewindOccupiedArea.js's file comment for why this can't
// safely extend further back than one month with the data pull.js already collects).
const nextMonthKey = (mk) => { const [y, m] = mk.split('-').map(Number); return ym(new Date(y, m, 1)); };
// Round-half-up to 2dp — see identical comment/fix in lib/reportMap.js. Plain `.toFixed(2)` can
// round DOWN on values whose binary float representation sits just under the true .xx5 boundary
// (e.g. 28.005 stored as 28.00499999999999...). Applied everywhere a rate/rent £ figure is rounded.
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
// Normalize channel labels consistently with reportMap's Activity parser so punctuation/spacing
// variants like "Walk-in", "Walk In", and "walkin" can't split one logical channel across
// different parts of the pipeline.
const inquiryChannelKey = (label) => String(label ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
const isVisibleMarketingChannel = (label) => {
  const k = inquiryChannelKey(label);
  return k === 'phone' || k === 'walkin' || k === 'web';
};
const NON_AREA_PRICED_RENTAL_ACTIVITY_TYPES = new Set(['Parking', 'Mailbox']);
const ZERO_DEBT_AGEING = { '0-10': 0, '11-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '121-180': 0, '181-360': 0, '361+': 0 };
function normalizeRentalActivityRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => {
    if (!row || typeof row !== 'object') return false;
    const type = String(row.type || '').trim();
    if (NON_AREA_PRICED_RENTAL_ACTIVITY_TYPES.has(type)) return true;
    const area = Number(row.area) || 0;
    const totalArea = Number(row.totalArea) || 0;
    const occupiedArea = Number(row.occupiedArea) || 0;
    const vacantArea = Number(row.vacantArea) || 0;
    return area > 0 || totalArea > 0 || occupiedArea > 0 || vacantArea > 0;
  });
}
const visibleMarketingLeadBase = (enquiries) => {
  if (!enquiries) return 0;
  const allChannelRows = Object.entries(enquiries.channels || {});
  const visibleChannelRows = allChannelRows.filter(([label]) => isVisibleMarketingChannel(label));
  if (visibleChannelRows.length) {
    return visibleChannelRows.reduce((sum, [, row]) => sum + (Number(row?.enquiries) || 0), 0);
  }
  if (allChannelRows.length) return 0;
  return (Number(enquiries.phone) || 0) + (Number(enquiries.walkin) || 0) + (Number(enquiries.webOnly ?? enquiries.web) || 0);
};
const visibleMarketingLeadConverted = (enquiries) => {
  if (!enquiries) return 0;
  const allChannelRows = Object.entries(enquiries.channels || {});
  const visibleChannelRows = allChannelRows.filter(([label]) => isVisibleMarketingChannel(label));
  if (visibleChannelRows.length) {
    return visibleChannelRows.reduce((sum, [, row]) => sum + (Number(row?.converted) || 0), 0);
  }
  if (allChannelRows.length) return 0;
  return Number(enquiries.reservationConversions) || 0;
};
// FIXED 13 Jul 2026 (tooltip-audit side-finding): 'discounts' was pulled and stored by lib/pull.js
// (DEFAULT_REPORTS includes it, added 9 Jul 2026 for the Discount Summary page + Move-in Variance
// KPI widget) but was missing here — fetchAllRaw()'s `.in('report', ALL_REPORTS)` filter silently
// dropped every discounts row on read-back, so disc.discount_plans was always [] and the whole
// Discount Summary page had been showing mock data in production since it was built, with no visual
// indicator (the page's own `live` flags all correctly derive from dsRows, they just never had
// anything to read). Move-in Variance vs Standard Rate (KPIs page) reads a DIFFERENT report
// (ManagementSummary's VarFromStdRate) and was unaffected.
// billing_frequency ADDED 22 Jul 2026 (task #308) — see recordFor()'s matching comment. Added here
// AND to lib/pull.js's DEFAULT_REPORTS at the same time, specifically to avoid repeating the exact
// 'discounts' silent-drop bug described above (pulled/stored but never read back because only ONE of
// the two arrays got updated).
const ALL_REPORTS = ['occupancy', 'rent_roll', 'management', 'move_ins_outs', 'past_due', 'scheduled_outs',
  'insurance_roll', 'insurance_activity', 'lead_funnel', 'marketing', 'merchandise', 'financial', 'rate_changes',
  'reservations', 'true_revenue', 'rental_activity', 'discounts', 'billing_frequency'];
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
export const PORTAL_SITE_CODES = Object.freeze(Object.keys(NAMES).sort());
export const PORTAL_SITE_NAME_BY_CODE = Object.freeze({ ...NAMES });

function monthKeyBounds(monthKey) {
  const [y, m] = String(monthKey || '').slice(0, 7).split('-').map(Number);
  if (!y || !m) return null;
  const start = new Date(y, m - 1, 1);
  const realCurrentMonth = ym(reportingCurrentMonthStart());
  const end = monthKey === realCurrentMonth ? lastCompleteDay(new Date()) : new Date(y, m, 0);
  return { start, end };
}

function normalizeLeadFunnelRow(data, rawResponse, monthKey, options = {}) {
  const parsed = typeof data === 'string' ? JSON.parse(data) : (data || {});
  const isCurrentMonth = monthKey === ym(reportingCurrentMonthStart());
  const forceReparse = !!options.forceReparse;
  const channels = parsed.channels && typeof parsed.channels === 'object' ? parsed.channels : {};
  const visibleChannels = Object.entries(channels).filter(([label]) => isVisibleMarketingChannel(label));
  const channelDerived = visibleChannels.length
    ? visibleChannels.reduce((acc, [label, row]) => {
        const key = inquiryChannelKey(label);
        const count = Number(row?.enquiries) || 0;
        const converted = Number(row?.converted) || 0;
        if (key === 'phone') acc.phone += count;
        else if (key === 'walkin') acc.walkin += count;
        else if (key === 'web') acc.web += count;
        acc.visibleTotal += count;
        acc.visibleConverted += converted;
        return acc;
      }, { phone: 0, walkin: 0, web: 0, visibleTotal: 0, visibleConverted: 0 })
    : {
        phone: Number(parsed.phone) || 0,
        walkin: Number(parsed.walkin) || 0,
        web: Number(parsed.webOnly ?? parsed.web) || 0,
        visibleTotal: Number(parsed.total) || ((Number(parsed.phone) || 0) + (Number(parsed.walkin) || 0) + (Number(parsed.webOnly ?? parsed.web) || 0)),
        visibleConverted: Number(parsed.reservationConversions) || 0,
      };
  const missingDirectCounts = parsed.phone == null && parsed.walkin == null && parsed.web == null && parsed.webOnly == null;
  const missingReservationStageCount = parsed.reservation_stage_count == null;
  const missingReservationMadeVisible = parsed.reservation_made_visible == null;
  if (rawResponse && (forceReparse || isCurrentMonth || missingDirectCounts || missingReservationStageCount || missingReservationMadeVisible)) {
    const bounds = monthKeyBounds(monthKey);
    if (bounds) {
      const reparsed = REPORTS.lead_funnel.parse([], bounds.start, bounds.end, rawResponse);
      return {
        ...parsed,
        ...reparsed,
        channels: reparsed.channels || parsed.channels || {},
      };
    }
  }
  return {
    ...parsed,
    // Treat the per-channel breakdown as the source of truth whenever it exists. Older/stale parsed
    // payloads can carry zeroed top-level phone/web/walkin fields alongside correct `channels`
    // counts, which makes visible enquiry counts contradict conversion %s unless we rehydrate them.
    phone: visibleChannels.length ? channelDerived.phone : (missingDirectCounts ? channelDerived.phone : (Number(parsed.phone) || 0)),
    walkin: visibleChannels.length ? channelDerived.walkin : (missingDirectCounts ? channelDerived.walkin : (Number(parsed.walkin) || 0)),
    web: visibleChannels.length ? channelDerived.web : (missingDirectCounts ? channelDerived.web : (Number(parsed.web) || 0)),
    webOnly: visibleChannels.length
      ? channelDerived.web
      : (parsed.webOnly != null ? (Number(parsed.webOnly) || 0) : (missingDirectCounts ? channelDerived.web : (Number(parsed.web) || 0))),
    total: visibleChannels.length ? channelDerived.visibleTotal : ((Number(parsed.total) || 0) || channelDerived.visibleTotal),
    reservationConversions: visibleChannels.length ? channelDerived.visibleConverted : (Number(parsed.reservationConversions) || 0),
    reservationConversionBase: visibleChannels.length
      ? channelDerived.visibleTotal
      : (parsed.reservationConversionBase ?? Number(parsed.total) ?? channelDerived.visibleTotal),
    reservation_stage_count: parsed.reservation_stage_count ?? parsed.reservations ?? 0,
    reservation_made_visible: parsed.reservation_made_visible ?? parsed.reservation_stage_count ?? parsed.reservations ?? 0,
    channels,
  };
}

function leadFunnelNeedsRawReparse(data) {
  const parsed = typeof data === 'string' ? JSON.parse(data) : (data || {});
  return (
    parsed.phone == null &&
    parsed.walkin == null &&
    parsed.web == null &&
    parsed.webOnly == null
  ) || parsed.reservation_stage_count == null || parsed.reservation_made_visible == null;
}

function normalizeManagementRow(data, rawResponse, monthKey) {
  const parsed = typeof data === 'string' ? JSON.parse(data) : (data || {});
  const ageing = parsed.delinquent_ageing;
  const needsAgeing =
    !ageing ||
    ['0-10', '11-30', '31-60', '61-90', '91-120', '121-180', '181-360', '361+'].some((key) => ageing[key] == null);
  if (!rawResponse || !needsAgeing) return parsed;
  const bounds = monthKeyBounds(monthKey);
  if (!bounds) return parsed;
  const reparsed = REPORTS.management.parse(extractNamedTable(rawResponse, 'UnitActivity'), bounds.start, bounds.end, rawResponse);
  return {
    ...parsed,
    delinquent_30plus_total: reparsed.delinquent_30plus_total ?? parsed.delinquent_30plus_total ?? 0,
    delinquent_30plus_units: reparsed.delinquent_30plus_units ?? parsed.delinquent_30plus_units ?? 0,
    delinquent_ageing: reparsed.delinquent_ageing || parsed.delinquent_ageing || null,
    var_from_std_rate: (parsed.var_from_std_rate && parsed.var_from_std_rate.length) ? parsed.var_from_std_rate : (reparsed.var_from_std_rate || []),
  };
}

function managementNeedsRawReparse(data) {
  const parsed = typeof data === 'string' ? JSON.parse(data) : (data || {});
  const ageing = parsed.delinquent_ageing;
  return (
    !ageing ||
    ['0-10', '11-30', '31-60', '61-90', '91-120', '121-180', '181-360', '361+'].some((key) => ageing[key] == null)
  );
}

function latestRawRowsByKey(rows) {
  const out = new Map();
  for (const row of rows || []) {
    const key = `${row.site_code}|${String(row.month).slice(0, 7)}|${row.report}`;
    const prev = out.get(key);
    const atMs = timestampMs(row.pulled_at);
    if (!prev || atMs > timestampMs(prev.pulled_at)) out.set(key, row);
  }
  return out;
}

function hasUsableRawResponse(rawMap, key) {
  return !!(rawMap && rawMap.has(key) && rawMap.get(key));
}

function validateRequiredRawCoverage(latestRows, checks) {
  const missing = [];
  for (const row of latestRows.values()) {
    const mk = String(row.month).slice(0, 7);
    for (const check of checks) {
      if (row.report !== check.report) continue;
      if (check.needsRaw && !check.needsRaw(row, mk)) continue;
      const key = `${row.site_code}|${mk}`;
      if (hasUsableRawResponse(check.rawMap, key)) continue;
      missing.push({
        report: row.report,
        site_code: row.site_code,
        month: mk,
      });
      if (missing.length >= 12) break;
    }
    if (missing.length >= 12) break;
  }
  if (!missing.length) return;
  const detail = missing.map((row) => `${row.report} ${row.site_code} ${row.month}`).join(', ');
  throw new Error(`required raw_response coverage missing for live payload rebuild: ${detail}${missing.length >= 12 ? ', ...' : ''}`);
}

function zeroPreOperationalInventory(rec) {
  rec.occ = 0;
  rec.tot = 0;
  rec.occPC = 0;
  rec.occA = 0;
  rec.claA = 0;
  rec.totA = 0;
  rec.areaPC = 0;
  rec.areaPCmla = 0;
  rec.grossOcc = 0;
  rec.gpot = 0;
  rec.economicOccPct = 0;
  rec.rpu = 0;
  rec.rate = 0;
  rec.realRate = 0;
  rec.rentSum = 0;
  rec.stdRentSum = 0;
  rec.areaSum = 0;
  rec.ssRentSum = 0;
  rec.ssStdRentSum = 0;
  rec.ssAreaSum = 0;
  rec.adjRentSum = 0;
  rec.ssAdjRentSum = 0;
  rec.officesRentSum = 0;
  rec.officesAreaSum = 0;
  rec.ssRate = 0;
  rec.ssReal = 0;
  rec.ss = { occ: 0, tot: 0, occPC: 0, occA: 0, rate: 0, real: 0, rent: 0, gpot: 0 };
  rec.offices = { occ: 0, tot: 0, occPC: 0, rate: 0 };
  rec.occActualRent = 0;
  rec.unitTypes = [];
  rec.unitMix = [];
  rec.vacant = 0;
  rec.unrentable = 0;
  rec.scheduledOuts = 0;
  if (rec.customerType) {
    rec.customerType = {
      business: { units: 0, area: 0, rent: 0, pct: 0, rate: 0 },
      residential: { units: 0, area: 0, rent: 0, pct: 0, rate: 0 },
    };
  }
}

// Build one site record from a month's reports. `full` adds the heavy arrays (unit mix, channels,
// ageing, charge categories) — kept only for the current month to keep the payload light.
// REMOVED 17 Jul 2026 (task #310): used to take a 5th `prevC`/`nextC` cross-month argument to support
// email/phone cohort-matching for reservationConversions (6-17 Jul, several iterations — see git
// history around task #301/#303). That whole approach is gone — see reservationConversions below for
// why — so no cross-month data is needed here any more.
// currentMonthData — ADDED 24 Jul 2026 (task #308/#404/#405): the CURRENT calendar month's own report
// bundle (idx[code][cur], i.e. the same shape as `c` but for "now" instead of whichever month this
// call is building). Only meaningful — and only ever passed — when `c` itself is the month
// immediately before current; see the Real Rate section below and each call site's nextMonthKey()
// gate. `null` for every other call (the current month's own record, older historical months, or
// call sites that don't need it) — recordFor() falls back to the pre-24-Jul formula whenever it's
// absent, so nothing about this is a breaking change.
function recordFor(code, name, c, full, useBillingAdjustedRate = false, currentMonthData = null) {
  const o = c.occupancy || {}, rr = c.rent_roll || {}, mio = c.move_ins_outs || {}, mg = c.management || {};
  const pd = c.past_due || {}, so = c.scheduled_outs || {}, ins = c.insurance_roll || {}, ia = c.insurance_activity || {};
  const lf = c.lead_funnel || {}, mk = c.marketing || {}, me = c.merchandise || {}, fin = c.financial || {}, rc = c.rate_changes || {};
  const res = c.reservations || {};
  const tr = c.true_revenue || {};
  const ra = c.rental_activity || {};
  const disc = c.discounts || {};
  const bf = c.billing_frequency || {};
  const visibleMoveIns = (mio.visible_move_ins ?? mg.move_ins) || 0;
  const visibleMoveOuts = (mio.visible_move_outs ?? mg.move_outs) || 0;
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
  // Rate (portfolio-wide, all unit types) — REPLACED 22 Jul 2026 (task #308) with R6's authoritative,
  // exactly-confirmed formula: Σ(dcRent × billingAdjustment) ÷ Σ area × 12, where billingAdjustment =
  // 1.0833 for tenants on a 28-day billing cycle (else 1) — LIVE-VERIFIED to hit legacy's Bicester
  // screenshot to the penny (Self Storage £29.87, Total £28.44; see
  // scripts/probe-r6-formula-preview.js). This ALSO resolves the long-standing dcRent-vs-dcStdRate
  // ambiguity in favor of dcRent — the OLD spec below (Michael, 1 Jul 2026: Σ dcStandardRate ÷ Σ area
  // × 12) is SUPERSEDED, not just refined; dcRent billing-adjusted is what legacy's figure actually
  // is, not "dcStdRate, coincidentally close." billing_frequency (custom report 999824, keyed by
  // LedgerID — see reportMap.js) isn't backfilled for any month before today, so this falls back to
  // the OLD dcStdRate-based sum whenever it's missing for a site/month — same fallback convention as
  // Real Rate's realRateFallback below — so historical months/Month-on-Month/portfolio totals don't
  // silently jump for periods this new data doesn't cover yet.
  const isSelfStorageUnit = (t) => String(t || '').toLowerCase().includes('self storage');
  const bfByLedger = bf.by_ledger || {};
  const hasBillingFreq = Object.keys(bfByLedger).length > 0;
  const unitRowsForRate = rr.unit_rows || [];
  const canAdjustRate = useBillingAdjustedRate && hasBillingFreq && unitRowsForRate.length > 0;
  // FIXED 23 Jul 2026 (task #308) — was only special-casing 28-day billers (x1.0833), silently
  // treating every OTHER non-monthly cycle as if it were monthly (factor 1). Michael sent real,
  // SiteLink-filtered RentRoll exports for Bicester/July, one per billing_frequency.sBillingFreqDesc
  // bucket (28 Day/Annual/Daily/Monthly/Quarterly/Semi Annual/Weekly) — confirmed a clean, disjoint
  // partition of all 318 occupied units (0 overlap, union = 318, area/dcRent sums match the unfiltered
  // file exactly). That data proves Bicester genuinely has non-monthly, non-28-day tenants sitting
  // right now at factor=1: 2 Annual (dcRent is a WHOLE YEAR's rent in one line, needs x1/12 so the
  // formula's blanket x12 later doesn't multiply it by 12x too much) and 1 Quarterly (needs x4/12).
  // Both were being overstated 12x and 3x respectively before this fix — small in isolation (3 of 318
  // tenants here), real money, and other sites may have a bigger share. Factor converts "dcRent per
  // that tenant's own cycle" into a monthly-equivalent, since every call site here still annualizes
  // with a flat x12 afterwards (cycles/year ÷ 12): daily 365/12, weekly 52/12, 28-day 13/12 (unchanged,
  // R6-confirmed), monthly 1, quarterly 4/12, semi-annual 2/12, annual 1/12. "Semi" checked before the
  // generic "annual" match so "Semi Annual" doesn't fall into the Annual bucket.
  const billingFactor = (freqDesc) => {
    const d = String(freqDesc || '').toLowerCase();
    if (/28|four.?week/.test(d)) return 13 / 12;
    if (/semi/.test(d)) return 2 / 12;
    if (/annual|year/.test(d)) return 1 / 12;
    if (/quarter/.test(d)) return 4 / 12;
    if (/week/.test(d)) return 52 / 12;
    if (/day/.test(d)) return 365 / 12;
    return 1; // monthly, or no billing_frequency match — unchanged, pre-fix behaviour
  };
  const billingAdjustedRentSum = (filterFn) => {
    let numer = 0;
    for (const u of unitRowsForRate) {
      if (!filterFn(u)) continue;
      numer += (u.rent || 0) * billingFactor(bfByLedger[u.ledgerId]);
    }
    return numer;
  };
  const adjRentSum = canAdjustRate ? R2(billingAdjustedRentSum(() => true)) : (rr.std_rent_sum || 0);
  const ssAdjRentSum = canAdjustRate ? R2(billingAdjustedRentSum((u) => isSelfStorageUnit(u.type))) : ((rr.self_storage && rr.self_storage.std_rent_sum) || 0);
  const rent = rr.monthly_rent || 0;
  const rate = (rr.area_sum || 0) ? R2(adjRentSum / rr.area_sum * 12) : 0;
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
  // SUPERSEDED for the TOTAL figure only, 24 Jul 2026 (task #308/#404/#405). The "~14 of 25 sites still
  // 20-70% off" gap noted above turned out to be BOTH the numerator and denominator above, not a
  // separate not-yet-identified issue — root-caused via a full day's live probing against all 25 of
  // Michael's legacy-confirmed June targets (scripts/probe-realrate-rentroll-vs-truerevenue-basis.js
  // onward, then probe-realrate-rewound-area-all-sites.js and probe-realrate-unit-inventory-
  // stability.js for the denominator half):
  //   - Numerator: summing EVERY True Revenue charge type (rent + StoreProtect + fees + everything
  //     else, tr.by_type) was never actually tested against occupied area in a clean pairing before —
  //     the "occupied area was a mistake" note above came from pairing occupied area with this SAME
  //     all-charges numerator, a combination that genuinely is worse. Filtering to just the "Rent"
  //     ChargeDesc (tr.by_desc — SiteLink's own per-ChargeDesc pre-aggregate, not tr.by_type's
  //     per-UnitType one) removes every ancillary charge's noise from the numerator.
  //   - Denominator: the frozen month-end rent_roll snapshot's own occupied area is routinely off by a
  //     few hundred sqft (task #404 — historical snapshots were captured via a single bulk backfill,
  //     not at each month's true close). Rewinding today's live occupied area back to the target
  //     month-end via MoveInsAndMoveOuts' real dated net-move events (computeRewoundOccupiedArea(),
  //     lib/rewindOccupiedArea.js) corrects this, with a guard that falls back to the frozen figure at
  //     any site whose TOTAL unit inventory has shifted more than ordinary noise since the snapshot — a
  //     real property expansion/reconfiguration, not a data error (see that file's Enfield example:
  //     78.5% inventory growth, correctly excluded from the rewind).
  // Together: avg|gap| £0.51 vs Michael's June targets, 24/25 sites within £1 — down from the ~26% avg
  // error the all-charges/total-area formula below was still carrying. Both fixes fall back cleanly to
  // the pre-24-Jul formula (byType.reduce/totalArea) whenever the newer inputs aren't available — an
  // older month before True Revenue's by_desc field existed, or no current-month sample to rewind
  // from (buildPayloadRange()'s multi-month ranges, or the in-progress current month's own record,
  // which has no "later" data to rewind with — see each recordFor() call site's currentMonthData
  // comment) — so historical/Month-on-Month/portfolio-total figures keep working exactly as before
  // wherever the new data isn't available yet.
  // NOT yet extended to Self Storage's ssReal below (still the pre-24-Jul all-charges/total-area
  // formula) — move_ins_outs doesn't currently split moves by unit type, so the rewind can't be scoped
  // to Self Storage alone yet. Revisit if Self Storage-specific Real Rate accuracy becomes the next
  // priority.
  const byType = tr.by_type || [];
  const byDesc = tr.by_desc || [];
  const byTypeDesc = tr.by_type_desc || [];
  const hasTrueRevenue = byType.length > 0;
  const totalArea = rr.total_area_all_units || 0;
  const realRateFallback = rr.real_rate_per_sqft_ann || 0;
  const trueRevenueNumerator = hasTrueRevenue
    ? byType.reduce((a, r) => a + (r.truePeriod || 0), 0)
    : realRateFallback * totalArea / 12;
  // rentDescRow: SiteLink's own "Rent" ChargeDesc row (case-insensitive match — by_desc preserves
  // SiteLink's raw label, "Rent" has been consistent everywhere it's been observed, but matching
  // loosely costs nothing and guards against a stray casing difference at some site).
  const rentDescRow = byDesc.find((r) => String(r.desc || '').toLowerCase() === 'rent');
  const hasRentOnlyTruePeriod = !!rentDescRow;
  // rewound: only attempted once a Rent-only figure actually exists to pair it with (no point
  // computing a better denominator for a numerator that's about to fall back anyway) AND the caller
  // supplied currentMonthData (see this function's own param comment + each call site).
  const rewound = (hasRentOnlyTruePeriod && currentMonthData)
    ? computeRewoundOccupiedArea({
        frozenRentRoll: rr,
        currentRentRoll: currentMonthData.rent_roll,
        currentMoveInsOuts: currentMonthData.move_ins_outs,
      })
    : null;
  // rentTruePeriod/realRateArea: the ACTUAL numerator/denominator this site's realRate below is
  // computed from, always populated (falling back component-by-component exactly like realRate itself
  // does) so portfolio/range aggregation elsewhere can sum-then-divide these two fields uniformly and
  // get a result consistent with whatever formula each individual site/month actually used — same
  // "carry the raw components through" convention as adjRentSum/areaSum above.
  const rentTruePeriod = hasRentOnlyTruePeriod ? (rentDescRow.truePeriod || 0) : trueRevenueNumerator;
  const realRateArea = rewound ? rewound.area : totalArea;
  const realRateAreaSource = rewound ? rewound.source : 'frozen (pre-24-Jul formula — no current-month sample or no Rent-only True Revenue figure)';
  // ANNUALIZE FACTOR — 10 Jul 2026: tried 365/period_days instead of a blind 12 (see
  // scripts/probe-truerevenue-period-granularity.js — confirmed TruePeriod DOES scale ~linearly with
  // elapsed days, not bucketed by month). The math checked out (every site's realRate moved by a
  // uniform ~3.04x, exactly 365/10 / 12 — no bug in the arithmetic), but it made the gap vs Michael's
  // legacy targets MUCH worse (avg error 26% -> 207%). REVERTED, then Michael confirmed directly
  // (10 Jul 2026) legacy's own definition: "month to date, true period revenue for all unit types
  // divided by total area for all units" — no mention of correcting for elapsed days. That CONFIRMS
  // legacy does the same "blind x12 regardless of how many days into the month it is" math this file
  // already had before today's detour — it's not a bug relative to legacy, legacy has the identical
  // property. period_days/trueRevenuePeriodDays is still computed/carried below in case it's ever
  // useful, but is NOT part of the confirmed formula.
  const trueRevenuePeriodDays = (hasTrueRevenue && tr.period_days) ? tr.period_days : null;
  const annualizeFactor = 12;
  const realRate = realRateArea ? R2(rentTruePeriod / realRateArea * annualizeFactor) : realRateFallback;
  // Self Storage Rate — RentRoll only (Michael, 7 Jul 2026: revert the OccupancyStatistics fallback
  // added 7 Jul 2026; keep RentRoll as the sole source everywhere, including Enfield, even where it
  // disagrees with OccupancyStatistics). Formula REPLACED 22 Jul 2026 (task #308) same as Total Rate
  // above — ssAdjRentSum (billing-adjusted dcRent, Self Storage rows only) ÷ Self Storage's occupied
  // area sum × 12, falling back to the old dcStdRate-based sum when billing_frequency isn't available.
  const ssRate = ((rr.self_storage && rr.self_storage.area_sum) || 0) ? R2(ssAdjRentSum / rr.self_storage.area_sum * 12) : 0;
  // Self Storage Real Rate — SUPERSEDED for the numerator+denominator BASIS 24 Jul 2026 (task #308
  // follow-up, Michael: "self storage is the same rate but you [need to] put a filter on the type to
  // only be self storage not everything"). Same two changes as Total Real Rate above, scoped to Self
  // Storage specifically:
  //   - Numerator: Self Storage's own "Rent" ChargeDesc line (tr.by_type_desc — reportMap.js's raw
  //     Table1 grain, one row per ChargeDesc×UnitType combination already, no new SOAP call needed),
  //     not every charge type Self Storage carries (StoreProtect, fees, etc.) — same noise Total
  //     Real Rate's fix removed.
  //   - Denominator: Self Storage's OCCUPIED area (rr.self_storage.area_sum), not its TOTAL area incl.
  //     vacant (rr.self_storage.total_area_all_units) — matching Total Real Rate's occupied-area
  //     basis, which is what actually validated against Michael's June targets (see comment above).
  // NOT yet extended to the REWIND itself (today's live area rolled back to month-end via
  // MoveInsAndMoveOuts) — that report doesn't currently expose a per-row unit type (not established
  // either way — nobody's actually checked; would need a live probe), so there's no confirmed way to
  // isolate "Self Storage's net moves" from move_ins_outs' portfolio-wide net_area. Self Storage's
  // occupied-area denominator below is therefore always the FROZEN month-end figure, never rewound —
  // a smaller improvement than Total Real Rate got, not the full parallel fix. Revisit (write that
  // probe) if Self Storage Real Rate accuracy needs to close further.
  const ssTotalArea = (rr.self_storage && rr.self_storage.total_area_all_units) || 0;
  const ssOccArea = (rr.self_storage && rr.self_storage.area_sum) || 0;
  const ssRealFallback = (rr.self_storage && rr.self_storage.real_rate_per_sqft_ann) || 0;
  const ssTrueRevenueNumerator = hasTrueRevenue
    ? byType.filter((r) => String(r.desc || '').toLowerCase().includes('self storage')).reduce((a, r) => a + (r.truePeriod || 0), 0)
    : ssRealFallback * ssTotalArea / 12;
  // ssRentDescRows — same case-insensitive "self storage" substring match as ssTrueRevenueNumerator
  // above (already proven against this exact report's UnitType labels), further filtered to the
  // "Rent" ChargeDesc — mirrors rentDescRow above, just crossed with type too. Checks row EXISTENCE
  // (.length), not whether the summed truePeriod is truthy — a real £0 Self Storage Rent period must
  // still be trusted as £0, not silently treated as "missing" and pushed onto the fallback below (the
  // same truthy-vs-existence distinction Codex's 24 Jul channel-fallback fix applied elsewhere today).
  const ssRentDescRows = byTypeDesc.filter((r) => String(r.type || '').toLowerCase().includes('self storage') && String(r.desc || '').toLowerCase() === 'rent');
  const hasSSRentOnlyTruePeriod = ssRentDescRows.length > 0;
  const ssRentTruePeriod = hasSSRentOnlyTruePeriod
    ? ssRentDescRows.reduce((a, r) => a + (r.truePeriod || 0), 0)
    : ssTrueRevenueNumerator;
  const ssRealArea = hasSSRentOnlyTruePeriod ? (ssOccArea || ssTotalArea) : ssTotalArea;
  // Same annualizeFactor as Total Real Rate above — one true_revenue pull per site/month, so the
  // period length is identical for the SS-scoped and Total figures.
  const ssReal = ssRealArea ? R2(ssRentTruePeriod / ssRealArea * annualizeFactor) : ssRealFallback;
  const insured = ins.insured_units || 0;
  const rec = {
    name, code, occ, tot, occPC: tot ? +(occ / tot * 100).toFixed(1) : 0, occA, claA, totA,
    areaPC: claA ? +(occA / claA * 100).toFixed(1) : (totA ? +(occA / totA * 100).toFixed(1) : 0), areaPCmla: o.area_pc_mla || (totA ? +(occA / totA * 100).toFixed(1) : 0), rent, grossOcc: o.gross_occupied || 0, gpot: o.gross_potential || 0,
    // Economic Occupancy (task #356) — see aggregateTotals()'s matching comment for the formula/
    // source. Per-site here so the KPIs page's Occupancy by Store table can show it alongside
    // areaPCmla/occPC without any extra client-side computation.
    economicOccPct: (o.gross_potential || 0) ? +((o.monthly_rent || 0) / o.gross_potential * 100).toFixed(1) : 0,
    rpu: occ ? R2(rent / occ) : 0, rate, realRate,
    // Raw numerator/denominator sums, carried through so buildPayload()'s portfolio totals can
    // re-aggregate by summing these FIRST and dividing once — never by averaging per-site rates.
    rentSum: rr.rent_sum || 0, stdRentSum: rr.std_rent_sum || 0, areaSum: rr.area_sum || 0,
    ssRentSum: (rr.self_storage && rr.self_storage.rent_sum) || 0,
    ssStdRentSum: (rr.self_storage && rr.self_storage.std_rent_sum) || 0,
    ssAreaSum: (rr.self_storage && rr.self_storage.area_sum) || 0,
    // adjRentSum/ssAdjRentSum ADDED 22 Jul 2026 (task #308) — the new billing-adjusted Rate numerator
    // (see comment above rate/ssRate). Carried through raw so aggregateTotals()/buildHistory()/the
    // range-merge function can re-aggregate Rate by summing these FIRST and dividing once, same
    // sum-then-divide-once convention as stdRentSum/areaSum above — those two now feed Rate only as
    // the pre-billing-frequency-data fallback, adjRentSum/ssAdjRentSum are the primary source.
    adjRentSum, ssAdjRentSum,
    // True Revenue-based Real Rate numerators + their TOTAL-area (incl. vacant) denominators — see
    // comment above. Carried through raw, same sum-then-divide-once convention as rentSum/areaSum.
    // areaTotalAll/ssAreaTotalAll are DELIBERATELY separate from areaSum/ssAreaSum above (those are
    // occupied-area only, still correct for Rate) — reusing areaSum here was the bug in the first pass.
    trueRevenueNumerator, ssTrueRevenueNumerator,
    areaTotalAll: totalArea, ssAreaTotalAll: ssTotalArea,
    // rentTruePeriod/realRateArea ADDED 24 Jul 2026 (task #308/#404/#405) — the ACTUAL numerator/
    // denominator this site's realRate above was computed from (Rent-only True Revenue ÷ rewound-or-
    // frozen occupied area, falling back component-by-component to the pre-24-Jul all-charges/total-
    // area figures whenever the newer inputs aren't available — see recordFor()'s own comment).
    // Carried through raw, same sum-then-divide-once convention as trueRevenueNumerator/areaTotalAll
    // above, which THIS supersedes for realRate specifically (kept alongside, not replacing, in case
    // anything else ever wants the old all-charges/total-area figures for reference).
    // realRateAreaSource is NOT meant for arithmetic — just a debug/transparency string (e.g. an
    // admin-only tooltip) showing which basis a given site/month actually used.
    rentTruePeriod, realRateArea, realRateAreaSource,
    // ssRentTruePeriod/ssRealArea ADDED 24 Jul 2026 (task #308 follow-up) — Self Storage's own
    // version of rentTruePeriod/realRateArea above (Self-Storage-scoped Rent-only ÷ Self Storage's
    // occupied area, falling back component-by-component to the pre-24-Jul all-charges/total-area
    // figures whenever the newer input isn't available — see ssReal's own comment). NOT rewound (see
    // that comment) — always the frozen month-end occupied area, unlike realRateArea which prefers
    // the rewound figure when available.
    ssRentTruePeriod, ssRealArea,
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
    stayDaysSum: rr.stay_days_sum || 0, stayCount: rr.stay_count || 0, stayRentSum: rr.stay_rent_sum || 0,
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
    autobillNewCountExact: (() => {
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
    // The portal freezes the visible current month at the last complete day. ManagementSummary's
    // month-to-date counters can include the in-progress current day, so when a current-month
    // move_ins_outs row has been reparsed and trimmed to the completed-day boundary above, prefer
    // those explicit visible counts here; otherwise keep the long-established ManagementSummary
    // source for closed months/history.
    moveIns: visibleMoveIns,
    moveOuts: visibleMoveOuts,
    netArea: mio.net_area || 0,
    moveOutsYear: mg.move_outs_year || 0,
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
    reservationsMade: lf.reservation_made_visible ?? lf.reservation_stage_count ?? 0,
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
    // occupiedIds — shared by activeReservations and reservedSqftEstimate below: a reservation whose
    // TenantID already shows up as a currently-occupied RentRoll tenant has converted to a lease and
    // shouldn't still count as "open", even though its ReservationList row was never formally closed
    // out (confirmed via npm run audit, 2 Jul 2026 — ~51 rows portfolio-wide).
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
    // FIXED 21 Jul 2026 (Rich's portal review, task #359 — "Is reserved sqft working?"): the ~3x
    // active-reservations overcount (Task #25) was NEVER actually inherited here — a previous comment
    // claiming otherwise was stale; lib/reportMap.js's activeByType is built from the same already-
    // QTRentalTypeID-filtered loop as active_reservations, so that part was always correct. What WAS
    // genuinely missing: the occupiedIds cross-reference exclusion above (activeReservations gets it,
    // this didn't) — active_by_unit_type is now a per-type ARRAY of tenant IDs (was a plain count),
    // so it can share the exact same filter here instead of double-counting already-converted tenants.
    reservedSqftEstimate: (() => {
      const areaByType = {}; for (const t of (rr.unit_type_areas || [])) areaByType[t.unit_type_id] = t.avg_area;
      const byType = res.active_by_unit_type || {};
      const occupiedIds = new Set(rr.occupied_tenant_ids || []);
      return Math.round(Object.entries(byType).reduce((a, [id, tenantIds]) => {
        const count = Array.isArray(tenantIds) ? tenantIds.filter((tid) => !occupiedIds.has(tid)).length : (tenantIds || 0);
        return a + count * (areaByType[id] || 0);
      }, 0));
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
      // "allOverdue" is the broad/raw any-age bucket. Once debtor ageing was switched to the
      // ManagementSummary "Unpaid" table, keeping this on PastDueBalances made the custom-widget
      // "All Overdue" field contradict the very 0-10/11-30/30+ buckets it sat beside. Prefer the
      // same ManagementSummary bucket sum whenever that ageing breakdown exists, then fall back to
      // PastDueBalances for older rows that predate the multi-table parser fix.
      allOverdue: mg.delinquent_ageing
        ? ['0-10', '11-30', '31-60', '61-90', '91-120', '121-180', '181-360', '361+']
            .reduce((sum, key) => sum + (mg.delinquent_ageing[key] || 0), 0)
        : (pd.ageing
            ? ['1-30', '31-60', '61-90', '91-120', '121-180', '181-360', '361+']
                .reduce((sum, key) => sum + (pd.ageing[key] || 0), 0)
            : (pd.total_overdue ?? (mg.delinquent_30plus_total ?? (pd.total_overdue_30plus ?? 0)))),
      // Debtor Levels widget: Tenant % = delinquent accounts / Occupied Units; Rent Roll % =
      // delinquent total / Actual Occupied Unit Rates.
      tenantPct: occ ? +((mg.delinquent_30plus_units ?? pd.accounts_overdue_30plus ?? pd.accounts_overdue ?? 0) / occ * 100).toFixed(1) : 0,
      rentRollPct: occActualRent ? +((mg.delinquent_30plus_total ?? pd.total_overdue_30plus ?? pd.total_overdue ?? 0) / occActualRent * 100).toFixed(1) : 0,
    },
    occActualRent,
    insurance: { insured, premium: ins.monthly_premium || 0, penetration: occ ? +(insured / occ * 100).toFixed(1) : 0 },
    insurancePremiumSum: ins.monthly_premium || 0, insuredUnitsSum: insured,   // flat copies for portfolio-level sum-then-divide
    // Keep the raw policy-activity fields on the direct InsuranceActivity source when available.
    // ManagementSummary's "Insurance" activity count is a broader/less reliable activity signal and
    // should only backfill genuinely older rows where the policy-event parser wasn't stored yet.
    insuranceActivity: { newPolicies: ia.new_policies ?? mg.insured_moveins ?? 0, newPremium: ia.new_premium || 0, cancellations: ia.cancellations || 0 },
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
    // 25-site portfolio (exact Phone 54/Walk-in 60, Web within 2.8% of legacy's 887). Corrected
    // again 24 Jul 2026 after a live side-by-side check against the deployed legacy Marketing page:
    // the legacy page's displayed "Web" and "Total Enquiries" counts do NOT include Email rows
    // (for example Bicester Jul 2026 reads Phone 6 + Web 75 + Walk-ins 8 = Total 89, while our new
    // page had been showing 93 by folding in 4 Email rows). Keep Email available as its own raw
    // field for the widget builder, but align the displayed Marketing counts with the live legacy
    // behaviour by excluding Email from `web` and `total`.
    enquiries: {
      total: (lf.phone || 0) + (lf.walkin || 0) + (lf.web || 0),
      // conversions (Enquiry -> Move-In) — CHANGED 7 Jul 2026 (Michael): plain PERIOD-RATIO — this
      // month's total move-ins (ManagementSummary, `mg.move_ins`, already reliable) divided by this
      // month's total enquiries (page.js does the division). Several per-lead cross-reference attempts
      // before that (TenantID, WaitingID, email-hash) all confirmed dead or just an undercount — see
      // git history around 3-7 Jul 2026 if reviving one of those is ever worth revisiting.
      conversions: visibleMoveIns,
      // reservationConversions (Enquiry -> Reservation) — corrected again 24 Jul 2026 after a live
      // store-by-store comparison against the deployed legacy Marketing page. Legacy's displayed
      // conversion % follows the visible Phone/Web/Walk-in rows themselves: e.g. Bicester Jul 2026
      // shows Phone 6 @ 50%, Web 75 @ 12%, Walk-ins 8 @ 50%, Total 89 @ 18% — and 18% is exactly the
      // weighted result of those 3 visible channels ((3 + 9 + 4) / 89), not InquirySource's much
      // larger aggregate base. So keep the raw InquirySource fields on lf for future analysis, but
      // expose the Marketing widget's displayed numerator/base from Activity-table channel counts
      // excluding Email, matching the live legacy page the user cross-checks against.
      reservationConversions: visibleMarketingLeadConverted({ phone: lf.phone, walkin: lf.walkin, web: lf.web, webOnly: lf.web, email: lf.email, channels: lf.channels || {} }),
      reservationConversionBase: visibleMarketingLeadBase({ phone: lf.phone, walkin: lf.walkin, web: lf.web, webOnly: lf.web, email: lf.email, channels: lf.channels || {} }),
      phone: lf.phone || 0, walkin: lf.walkin || 0, web: lf.web || 0,
      webOnly: lf.web || 0, email: lf.email || 0,
      // Keep channel-level enquiry counts on the Activity-table source that matches the live/legacy
      // July store counts. InquirySource's aggregate per-channel table is still carried on the raw
      // parsed object for future reverse-engineering, but swapping it in here inflated Phone/Walk-in
      // counts in live payloads (for example L003 Phone 8 -> 12) without proving the legacy widget's
      // true Converted% formula.
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
    // Keep the raw credit total alongside collected/charge/payment/discount. The legacy bootstrap
    // adapter and any downstream consumer that wants "credits issued" should read the same stored
    // FinancialSummary field rather than quietly falling back to 0 because the property is absent.
    revenue: {
      collected: (fin.total_charge || 0) - (fin.total_credit || 0),
      charge: fin.total_charge || 0,
      payment: fin.total_payment || 0,
      credit: fin.total_credit || 0,
      discount: fin.total_discount || 0,
      // Keep raw FinancialSummary category rows for downstream consumers like the legacy bootstrap
      // adapter, which derives rent/insurance receipts and rent net revenue from this breakdown.
      categories: fin.categories || [],
    },
    rateChanges: { increases: rc.increases || 0, decreases: rc.decreases || 0, avgPct: rc.avg_increase_pct || 0 },
    marketing: { tenants: mk.tenants || 0, commercial: mk.commercial || 0, residential: mk.residential || 0, avgRent: mk.avg_rent || 0 },
    occD: 0, rentD: 0, areaD: 0,
  };
  // Keep these on both the light monthly history rows and the full current-month rows. The legacy
  // bootstrap adapter reads historical months from `payload.monthly`, not just `payload.sites`, and
  // derives several legacy fields from these nested breakdowns (receipts by category, debtor ageing,
  // unit type / unit size summaries). When they lived only behind `full`, historical legacy months
  // silently flattened those sections to zero/empty despite the raw report data being present.
  rec.unitTypes = o.unit_types || [];
  rec.unitMix = o.unit_mix || [];
  rec.debtors.ageing = mg.delinquent_ageing
    ? {
        '0-10': mg.delinquent_ageing['0-10'] || 0,
        '11-30': mg.delinquent_ageing['11-30'] || 0,
        '31-60': mg.delinquent_ageing['31-60'] || 0,
        '61-90': mg.delinquent_ageing['61-90'] || 0,
        '91-120': mg.delinquent_ageing['91-120'] || 0,
        '121-180': mg.delinquent_ageing['121-180'] || 0,
        '181-360': mg.delinquent_ageing['181-360'] || 0,
        '361+': mg.delinquent_ageing['361+'] || 0,
      }
    : (pd.ageing || null);
  if (!rec.debtors.ageing && (Number(rec.debtors.allOverdue) || 0) === 0) {
    rec.debtors.ageing = { ...ZERO_DEBT_AGEING };
  }
  rec.revenue.categories = fin.categories || [];
  rec.marketing.sources = mk.sources || [];
  if (full) {
    rec.vacant = o.vacant_units || 0; rec.unrentable = o.unrentable_units || 0;
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
    rec.ss.rent = ss.monthly_rent || 0; rec.ss.gpot = ss.gross_potential || 0;
    // unitRows (ADDED 14 Jul 2026, task #174/#203): per-occupied-unit rows from rent_roll's new
    // unit_rows array — feeds the "Watchdog - Discounted Units in Fully Occupied Groups" and "Unit
    // Groups - Stay & Re-Lease" District Manager-style widgets. Gated behind `full` same as unitMix
    // above, since it's a per-unit array (can be large) only needed for the current/full month view.
    rec.unitRows = rr.unit_rows || [];
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
  // Production audit hardening (28 Jul 2026): RentalActivity can include impossible zero-area rows
  // for area-priced types (for example `0x0` Indoor Self Storage / Office / Enterprise groups). They
  // pollute Unit Mix Detail counts and type rollups without representing real rentable square
  // footage. Keep genuinely non-area-priced categories like Parking/Mailbox, but drop zero-area rows
  // for the area-priced types here so every downstream widget sees the same cleaned dataset.
  rec.rentalActivityByTypeSize = normalizeRentalActivityRows(ra.by_type_size);
  // Economic Occupancy Detail table (KPIs page, task #376/377, Michael's Economic occupancy
  // Tracker.xlsx: "Can we add economic occupancy into this section please? Example of the table
  // with dropdown plus instructions attached"). Same reasoning as rentalActivityByTypeSize just
  // above — kept OUTSIDE `if (full)` so it's on the light previous-month AND every historical
  // `monthly[mk]` record too, since the new table needs a real prior-period comparison for its MoM%
  // columns, not just the current month. Raw per-(type,size) sums only (occ/tot/occArea/totalArea/
  // grossPotential/actualOccupied) — page.js sums across whichever site(s) the store filter selects,
  // then derives Asking/In-Place Rent PSF, In-Place Discount, Occupancy%, Economic Occupancy% from
  // those sums, same sum-then-divide-once convention as everything else here.
  rec.occByTypeSize = o.by_type_size || [];
  // Discount Summary page + Move-in Variance KPI widget (ADDED 9 Jul 2026, Michael's "monthly flow" /
  // "build both" decisions — see lib/reportMap.js's `discounts` comment for the full source
  // investigation). Same full-calendar-month flow metric class as Rental Activity above — kept
  // outside `if (full)` so it's on the light previous-month record too. moveInVarianceCount/Sum are
  // raw (not pre-divided) — aggregateTotals()/mergeSiteAcrossRange() divide once, same
  // sum-then-divide-once rule as every other rate in this file.
  rec.discountPlans = disc.discount_plans || [];
  // FIXED 21 Jul 2026 (task #396) — this site's TRUE distinct-unit count across every plan, not
  // scoped to any one plan (see lib/reportMap.js's discounts.parse() comment). aggregateTotals()
  // below sums this straight across sites (safe — a unit belongs to exactly one site) into the real
  // portfolio-wide "Units on a Discount Plan" total, instead of page.js summing discountPlans' own
  // already-per-plan-deduped counts, which double-counted any unit carrying discounts under >1 plan
  // in the same month.
  rec.discountUnitsTotal = disc.discount_units_total || 0;
  // Move-in Variance vs Standard Rate — RESOURCED 21 Jul 2026 (Rich's portal review, task #360). Rich:
  // "Move in Variance vs standard rate is pulling from the wrong area... just taken from the mgmt
  // summary. Move in variance is from the MI and MO report. You take the variance vs standard rate."
  // Confirmed via Rich's supplied Move_in_Move_out PSF and Variance.xlsx (RPSF sheet): per store/
  // period, for MoveIn=1 rows only, Total Discount = Σ MovedInVariance ÷ Σ StandardRate (both native
  // MoveInsAndMoveOuts columns), then Actual = Total Discount − 8.33% (the natural, expected variance
  // from monthly vs 4-weekly billing-cycle differences — not a data error; the same 8.33%/(13÷12−1)
  // constant independently found in task #308's Bicester rate-annualization probe). Previously read
  // Discounts' dcVariance instead — a different report; that computation is left in reportMap.js for
  // Discount Summary's own discountPlans use but no longer feeds this widget. Raw sums (not pre-
  // divided) — aggregateTotals()/mergeSiteAcrossRange() divide once, same sum-then-divide-once rule as
  // every other rate in this file.
  // Keep the KPI's displayed move-in count on the exact same visible current-month basis as the
  // rest of the portal. Using raw `mio.move_ins` here leaked today's partial move-ins into the
  // `n=` label even after the main move-in widgets were corrected to stop at the last complete day.
  rec.moveInVarianceCount = visibleMoveIns;
  rec.moveInVarianceSum = mio.moved_in_variance_sum || 0;
  rec.moveInStdRateSum = mio.moved_in_std_rate_sum || 0;
  rec.moveInVarStdRatePct = rec.moveInStdRateSum ? +(rec.moveInVarianceSum / rec.moveInStdRateSum * 100).toFixed(2) : 0;
  rec.moveInVarStdRateActualPct = rec.moveInVarianceCount ? +(rec.moveInVarStdRatePct - 8.33).toFixed(2) : null;
  // Move-in Variance's whole-book half (management's var_from_std_rate, see reportMap.js) — kept as a
  // separate, relabeled "Units Below Standard Rate (Whole Book)" chart per Rich's own "it is
  // interesting data" comment (see page.js) rather than deleted. A live snapshot regardless of month,
  // so it'll just read the same "as of now" value on every month's light record until/unless SiteLink
  // starts supporting true historical "as of" reads for it.
  rec.varFromStdRate = mg.var_from_std_rate || [];
  // Historical pre-opening guard (27 Jul 2026, deep audit): some backfilled site-months have no
  // stored raw SOAP (`raw_response` missing on occupancy/rent_roll/scheduled_outs) yet still carry a
  // phantom inventory base such as 536 total units, 10 scheduled move-outs, and a nonzero asking rate
  // despite zero rent, zero tenants, and no real operating book. Verified on Exeter 2026-04. Those
  // rows can still have genuine pre-opening lead/reservation activity, so only zero the stock-style
  // occupancy/inventory fields; leave dated flow metrics (enquiries, reservations made, move-ins,
  // move-outs) untouched. Guarded narrowly to historical month-range reads and only when the data is
  // clearly impossible as a live trading month.
  if (
    (o.__missing_raw_response || rr.__missing_raw_response || so.__missing_raw_response) &&
    (rec.rent || 0) === 0 &&
    (rec.occ || 0) <= 1 &&
    (rec.tot || 0) > 100
  ) {
    zeroPreOperationalInventory(rec);
  }
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
    // corrupt the Autobill Conversion KPI.
    // FIXED AGAIN 15 Jul 2026: that first fix used the same OFFSET-based .range(from, from+PAGE-1)
    // pattern that just caused a recurring statement-timeout in fetchAllRaw() below (see that comment
    // for the full mechanism — cost grows with rows-seen-so-far, not just PAGE). autobill_daily was
    // small enough to not have hit it yet, but it accumulates daily and would eventually repeat the
    // exact same failure. Switched to the same KEYSET/cursor pagination (.gt('id', lastId).limit(PAGE))
    // pre-emptively, before it becomes a second version of the same outage.
    const out = []; const PAGE = 1000;
    let lastId = 0;
    for (;;) {
      let q = admin.from('autobill_daily').select('id,site_code,month,pct').gt('id', lastId).order('id').limit(PAGE);
      if (monthRange) q = q.gte('month', monthRange.start).lt('month', monthRange.endExclusive);
      const { data, error } = await retryOnStatementTimeout(async () => q);
      if (error) throw new Error(error.message);
      out.push(...(data || []));
      if (!data || data.length < PAGE) break;
      lastId = data[data.length - 1].id;
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
  rec.autobillNewCountExact = avgPct / 100 * rec.autobillNewTotal;
  rec.autobillNewCount = Math.round(rec.autobillNewCountExact);
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
async function fetchAllRaw(monthRange, opts = {}) {
  const out = [];
  const liveCurrentFast = !!opts.liveCurrentFast;
  // Lower page size again 23 Jul 2026 (post-go-live audit): keyset pagination fixed the old
  // OFFSET-growth bug, but rebuilds can still hit Postgres statement_timeout when an individual page
  // is too wide under transient load because each row includes the parsed `data` JSON. A smaller page
  // keeps each single statement lighter without changing any business logic or the final payload.
  //
  // Tightened again 28 Jul 2026 (production audit): the current-month rebuild path still routinely
  // lands just under one giant ~500-row page (29 sites x many reports), which means the whole live
  // refresh still depends on a SINGLE wide statement succeeding. When that one page times out, the
  // rebuild fails before pagination gets any chance to help. Use smaller pages whenever the caller
  // is already range-scoped so current/ranged live refreshes split into several lighter statements
  // instead of one all-or-nothing fetch. Full-history builds keep the larger page to avoid regressing
  // already-heavier repair jobs more than necessary.
  // Current-month live reads are bounded to just two months and ~1k rows. The smaller 100-row page
  // that protects broader range/history scans from statement timeouts costs the fast path several
  // extra network round trips per request. Direct timing probes on 4 Aug 2026 showed the two-month
  // live window falling sharply from ~12.1s at 100-row pages to ~5.2s at 300-row pages, while still
  // staying well below the old 500-row all-in-one statement size that originally drove timeout risk.
  // Keep historical/range reads conservative, but let the live path use 300.
  const PAGE = liveCurrentFast ? 300 : (monthRange ? 100 : 500);
  // FIXED 15 Jul 2026 (Michael: recurring "canceling statement due to statement timeout" errors on
  // the main pull's payload-rebuild step, 3x in one morning, worsening over the last few days): this
  // used OFFSET-based pagination (.range(from, from+PAGE-1)) — Postgres/PostgREST implements .range()
  // as OFFSET+LIMIT, which must re-scan and discard every earlier row on every page, so cost grows
  // roughly with (rows seen so far), not just PAGE. As raw_report kept growing (daily crons + every
  // backfilled month), later pages got slower and slower until they started blowing past Postgres's
  // own statement_timeout — exactly matching "measured ~13-15s and growing" in the old comment here.
  // Switched to KEYSET/cursor pagination instead (.gt('id', lastId).limit(PAGE)): each page is a
  // direct indexed lookup on the bigserial primary key, so cost per page stays flat regardless of how
  // deep into the table it is — no more O(rows²) growth as history accumulates.
  let lastId = 0;
  for (;;) {
    let q = admin.from('raw_report')
      .select('id,site_code,month,report,data,pulled_at').in('report', ALL_REPORTS).gt('id', lastId).order('id').limit(PAGE);
    // Optional server-side date filter (added 8 Jul 2026, Michael: portal briefly shows correct data
    // then reverts a few seconds later). buildPayload() calls this unfiltered — it genuinely needs
    // full history for `monthly`/`history`. buildPayloadRange() now passes its actual needed range
    // instead of scanning every row ever pulled: that full scan measured ~13-15s and growing with
    // every backfilled month, which was a wide-open window for a concurrent pull/repull write to land
    // mid-scan and produce an inconsistent read (fewer sites / stale sums) — exactly the symptom
    // reported. Narrowing this is the fix: less time scanning = less chance of catching a write
    // in-flight, plus the range view should just load near-instantly now regardless.
    if (monthRange) q = q.gte('month', monthRange.start).lt('month', monthRange.endExclusive);
    const { data, error } = await retryOnStatementTimeout(async () => q);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
    lastId = data[data.length - 1].id;
  }
  return out;
}

// Load every stored raw_report row into a {site -> month -> report -> data} index, plus the sorted
// list of months that have real occupancy data. Extracted 6 Jul 2026 alongside aggregateTotals()/
// buildHistory() so buildPayloadRange() (global month/date-range selector) can share the exact same
// de-dupe/pagination-safety logic instead of a second hand-copied implementation. `monthRange`
// (optional, 8 Jul 2026) narrows the underlying fetchAllRaw() scan — see its comment above.
async function fetchLeadFunnelRawMap(monthRange) {
  // Production hardening (27 Jul 2026): this helper only exists to reparse lead_funnel rows whose
  // already-parsed JSON is missing specific derived fields, but each row's raw_response payload is
  // large. A broader page here can still hit Postgres statement_timeout under load even when the
  // main raw_report scan succeeds. Keep this page intentionally small so range/current-month builds
  // remain reliable rather than failing the whole payload over one heavy reparsing aid.
  return fetchReportRawMap('lead_funnel', monthRange, 50);
}

function initialRawPageSizeForReport(report) {
  switch (report) {
    case 'rent_roll':
      return 20;
    case 'move_ins_outs':
      return 100;
    default:
      return 50;
  }
}

async function fetchMoveInsOutsRawMap(monthRange) {
  return fetchReportRawMap('move_ins_outs', monthRange, 100);
}

async function fetchManagementRawMap(monthRange) {
  return fetchReportRawMap('management', monthRange, 50);
}

async function fetchOccupancyRawMap(monthRange) {
  return fetchReportRawMap('occupancy', monthRange, 50);
}

async function fetchRentRollRawMap(monthRange) {
  return fetchReportRawMap('rent_roll', monthRange, 20);
}

async function fetchScheduledOutsRawMap(monthRange) {
  return fetchReportRawMap('scheduled_outs', monthRange, 50);
}

async function fetchFinancialRawMap(monthRange) {
  return fetchReportRawMap('financial', monthRange, 50);
}

async function fetchPastDueRawMap(monthRange) {
  return fetchReportRawMap('past_due', monthRange, 50);
}

async function fetchInsuranceActivityRawMap(monthRange) {
  return fetchReportRawMap('insurance_activity', monthRange, 50);
}

async function fetchReservationsRawMap(monthRange) {
  return fetchReportRawMap('reservations', monthRange, 50);
}

async function fetchMarketingRawMap(monthRange) {
  return fetchReportRawMap('marketing', monthRange, 50);
}

async function fetchDiscountsRawMap(monthRange) {
  return fetchReportRawMap('discounts', monthRange, 50);
}

async function fetchInsuranceRollRawMap(monthRange) {
  return fetchReportRawMap('insurance_roll', monthRange, 50);
}

async function fetchRateChangesRawMap(monthRange) {
  return fetchReportRawMap('rate_changes', monthRange, 50);
}

async function fetchMultiReportRawMaps(reports, monthRange, pageSize = 100) {
  const maps = Object.fromEntries((reports || []).map((report) => [report, new Map()]));
  if (!reports || !reports.length) return maps;
  try {
    let lastId = 0;
    for (;;) {
      let q = admin.from('raw_report')
        .select('id,site_code,month,report,raw_response')
        .in('report', reports)
        .gt('id', lastId)
        .order('id')
        .limit(pageSize);
      if (monthRange) q = q.gte('month', monthRange.start).lt('month', monthRange.endExclusive);
      const { data, error } = await retryOnStatementTimeout(async () => q);
      if (error) throw new Error(error.message);
      for (const row of data || []) {
        const key = `${row.site_code}|${String(row.month).slice(0, 7)}`;
        (maps[row.report] ??= new Map()).set(key, row.raw_response || null);
      }
      if (!data || data.length < pageSize) break;
      lastId = data[data.length - 1].id;
    }
    return maps;
  } catch (error) {
    // Production hardening (28 Jul 2026): the combined current-month raw_response fetch keeps the
    // happy path fast, but under Supabase load we've still seen it hit transient statement timeouts
    // and 52x edge failures even though the narrower per-report queries succeed moments later. When
    // that happens, prefer a slower but correct live build over failing the entire portal refresh.
    console.warn(`[buildPayload] combined raw_response fetch failed for ${reports.join(', ')}; retrying report-by-report:`, error?.message || error);
    for (const report of reports) {
      maps[report] = await fetchReportRawMap(report, monthRange, Math.min(pageSize, initialRawPageSizeForReport(report)));
    }
    return maps;
  }
}

async function fetchReportRawMap(report, monthRange, pageSize = 50) {
  const out = new Map();
  try {
    let lastId = 0;
    for (;;) {
      let q = admin.from('raw_report')
        .select('id,site_code,month,raw_response')
        .eq('report', report)
        .gt('id', lastId)
        .order('id')
        .limit(pageSize);
      if (monthRange) q = q.gte('month', monthRange.start).lt('month', monthRange.endExclusive);
      const { data, error } = await retryOnStatementTimeout(async () => q);
      if (error) throw new Error(error.message);
      for (const row of data || []) out.set(`${row.site_code}|${String(row.month).slice(0, 7)}`, row.raw_response || null);
      if (!data || data.length < pageSize) break;
      lastId = data[data.length - 1].id;
    }
    return out;
  } catch (error) {
    const nextPageSize = Math.max(5, Math.floor(pageSize / 2));
    if (nextPageSize >= pageSize) throw error;
    console.warn(`[buildPayload] raw_response fetch for ${report} failed at pageSize=${pageSize}; retrying with smaller pages (${nextPageSize}):`, error?.message || error);
    return fetchReportRawMap(report, monthRange, nextPageSize);
  }
}

async function buildIndex(monthRange, opts = {}) {
  const liveCurrentFast = !!opts.liveCurrentFast;
  const { data: sitesRef, error: sitesErr } = await retryOnStatementTimeout(async () => admin.from('sites').select('code,name'));
  if (sitesErr) {
    console.warn('[buildPayload] sites reference read failed; falling back to built-in portal site list:', sitesErr.message);
  }
  const nameOf = Object.fromEntries((sitesRef || []).map(s => [s.code, s.name]));
  for (const c of Object.keys(NAMES)) nameOf[c] = NAMES[c];   // authoritative names (fixes Bedford/Paulton etc.)

  const rows = await fetchAllRaw(monthRange, { liveCurrentFast });
  const latestRows = latestRawRowsByKey(rows);
  const realCurrentMonth = ym(reportingCurrentMonthStart());
  // Production hardening (27 Jul 2026): raw_response is the heaviest field in raw_report and this
  // second scan exists only to backfill a few derived lead_funnel fields on older/stale parsed rows.
  // Newer pulls already persist those fields directly in `data`, so fetching every raw SOAP blob on
  // every range/current-month build needlessly makes the "fast" path slow and timeout-prone. Only do
  // the extra raw_response scan when at least one selected lead_funnel row is actually missing the
  // fields normalizeLeadFunnelRow() would need to reparse.
  const needLeadFunnelRaw = rows.some((r) => r.report === 'lead_funnel' && (
    monthRange ||
    String(r.month).slice(0, 7) === realCurrentMonth ||
    leadFunnelNeedsRawReparse(r.data)
  ));
  // Current-month management rows must be reparsed even on the liveCurrentFast path. The stored
  // parsed JSON can still be missing ManagementSummary's normalized delinquent ageing buckets
  // (0-10/11-30/31-60...), which makes the live current-month payload fall back wholesale to
  // PastDueBalances' different bucket shape (1-30/31-60/...). That silently breaks current-month
  // debtor ageing in both portal-v2 and the legacy bootstrap adapter. Keep the historical fast-path
  // skip, but not for the visible current month.
  const needManagementRaw = rows.some((r) => r.report === 'management' && (
    String(r.month).slice(0, 7) === realCurrentMonth || (!liveCurrentFast && managementNeedsRawReparse(r.data))
  ));
  const currentMonthOnlyRawMonthRange = { start: `${realCurrentMonth}-01`, endExclusive: `${nextMonthKey(realCurrentMonth)}-01` };
  const currentOrRangeRawMonthRange = monthRange || currentMonthOnlyRawMonthRange;
  const rawFetchMonthRange = liveCurrentFast ? currentMonthOnlyRawMonthRange : currentOrRangeRawMonthRange;
  // Closed historical range reads should lean on the already-stored parsed JSON wherever that shape
  // is known-good. Re-fetching raw SOAP for every report family on every month-range request makes a
  // single prior-month page view pay almost the same cost as a full repair rebuild, which is exactly
  // where we keep seeing statement-timeout / 52x turbulence. Keep raw reparsing for lead_funnel
  // (historical marketing conversion correctness) and any report with a genuinely missing current-
  // month-only raw dependency, but let older historical rows for the other report families render
  // from their stored parsed payloads.
  const needOccupancyRaw = rows.some((r) => r.report === 'occupancy' && String(r.month).slice(0, 7) === realCurrentMonth);
  const needRentRollRaw = rows.some((r) => r.report === 'rent_roll' && String(r.month).slice(0, 7) === realCurrentMonth);
  const needScheduledOutsRaw = !liveCurrentFast && rows.some((r) => r.report === 'scheduled_outs' && String(r.month).slice(0, 7) === realCurrentMonth);
  // Current-month financial rows must be reparsed even on the liveCurrentFast path. The fast
  // current-month reader feeds readPortalPayloadFreshCurrentMonth()'s default portal response, while
  // explicit single-month range reads use the fuller buildPayloadRange() path. Skipping financial raw
  // here let those two code paths disagree on the same current-month revenue/collected figures,
  // because the fast path trusted the lighter stored parsed JSON while the range path rebuilt from
  // the authoritative raw_response. Keep the other fast-path raw skips, but not financial.
  const needFinancialRaw = rows.some((r) => r.report === 'financial' && String(r.month).slice(0, 7) === realCurrentMonth);
  const needPastDueRaw = !liveCurrentFast && rows.some((r) => r.report === 'past_due' && String(r.month).slice(0, 7) === realCurrentMonth);
  const needInsuranceActivityRaw = !liveCurrentFast && rows.some((r) => r.report === 'insurance_activity' && String(r.month).slice(0, 7) === realCurrentMonth);
  const needReservationsRaw = !liveCurrentFast && rows.some((r) => r.report === 'reservations' && String(r.month).slice(0, 7) === realCurrentMonth);
  const needMarketingRaw = !liveCurrentFast && rows.some((r) => r.report === 'marketing' && String(r.month).slice(0, 7) === realCurrentMonth);
  const needDiscountsRaw = !liveCurrentFast && rows.some((r) => r.report === 'discounts' && String(r.month).slice(0, 7) === realCurrentMonth);
  const needInsuranceRollRaw = !liveCurrentFast && rows.some((r) => r.report === 'insurance_roll' && String(r.month).slice(0, 7) === realCurrentMonth);
  const needRateChangesRaw = !liveCurrentFast && rows.some((r) => r.report === 'rate_changes' && String(r.month).slice(0, 7) === realCurrentMonth);
  const rawReports = [
    needLeadFunnelRaw ? 'lead_funnel' : null,
    needManagementRaw ? 'management' : null,
    needOccupancyRaw ? 'occupancy' : null,
    needRentRollRaw ? 'rent_roll' : null,
    needScheduledOutsRaw ? 'scheduled_outs' : null,
    needFinancialRaw ? 'financial' : null,
    needPastDueRaw ? 'past_due' : null,
    needInsuranceActivityRaw ? 'insurance_activity' : null,
    needReservationsRaw ? 'reservations' : null,
    needMarketingRaw ? 'marketing' : null,
    needDiscountsRaw ? 'discounts' : null,
    needInsuranceRollRaw ? 'insurance_roll' : null,
    needRateChangesRaw ? 'rate_changes' : null,
  ].filter(Boolean);
  const rawReportMaps = rawReports.length
    ? await fetchMultiReportRawMaps(rawReports, rawFetchMonthRange, liveCurrentFast ? 200 : 50)
    : {};
  const leadFunnelRawMap = rawReportMaps.lead_funnel || null;
  const managementRawMap = rawReportMaps.management || null;
  const occupancyRawMap = rawReportMaps.occupancy || null;
  const rentRollRawMap = rawReportMaps.rent_roll || null;
  const scheduledOutsRawMap = rawReportMaps.scheduled_outs || null;
  const financialRawMap = rawReportMaps.financial || null;
  const pastDueRawMap = rawReportMaps.past_due || null;
  const insuranceActivityRawMap = rawReportMaps.insurance_activity || null;
  const reservationsRawMap = rawReportMaps.reservations || null;
  const marketingRawMap = rawReportMaps.marketing || null;
  const discountsRawMap = rawReportMaps.discounts || null;
  const insuranceRollRawMap = rawReportMaps.insurance_roll || null;
  const rateChangesRawMap = rawReportMaps.rate_changes || null;
  const needCurrentMonthMoveRaw = rows.some((r) => r.report === 'move_ins_outs' && String(r.month).slice(0, 7) === realCurrentMonth);
  const currentMonthMoveRawMap = needCurrentMonthMoveRaw
    ? await fetchMoveInsOutsRawMap({ start: `${realCurrentMonth}-01`, endExclusive: `${nextMonthKey(realCurrentMonth)}-01` })
    : null;
  validateRequiredRawCoverage(latestRows, [
    {
      report: 'lead_funnel',
      rawMap: leadFunnelRawMap,
      // Historical hardening (28 Jul 2026): many older lead_funnel months were backfilled with a
      // usable parsed JSON payload (channels / totals / reservations) but no raw SOAP blob. Those
      // rows can still rebuild the visible enquiry widgets via normalizeLeadFunnelRow()'s channel-
      // derived backfills, so forcing raw coverage for every historical "old parser shape" month
      // makes manual/full historical repairs fail on data that is already good enough to render.
      // Keep raw mandatory for the live current month, where we actively need reparsing to guarantee
      // today's visible counts and conversions match the latest source rows, but let older months
      // proceed from parsed data when raw_response was never retained.
      needsRaw: (_row, mk) => mk === realCurrentMonth,
    },
    {
      report: 'management',
      rawMap: managementRawMap,
      // Historical hardening (28 Jul 2026): older management rows can legitimately predate
      // raw_response retention even when their parsed JSON is still usable enough to render. We
      // already degrade safely in normalizeManagementRow() when rawResponse is absent by keeping the
      // stored parsed row as-is. Treating missing raw coverage as fatal here blocks whole historical
      // range repairs and forced rebuilds over one non-critical enrichment gap. Keep reparsing when
      // raw exists, but do not require raw coverage for the build to proceed.
      needsRaw: () => false,
    },
    {
      report: 'occupancy',
      rawMap: occupancyRawMap,
      needsRaw: (_row, mk) => mk === realCurrentMonth,
    },
    {
      report: 'rent_roll',
      rawMap: rentRollRawMap,
      needsRaw: (_row, mk) => mk === realCurrentMonth,
    },
    {
      report: 'scheduled_outs',
      rawMap: scheduledOutsRawMap,
      needsRaw: (_row, mk) => mk === realCurrentMonth && !liveCurrentFast,
    },
    {
      report: 'financial',
      rawMap: financialRawMap,
      needsRaw: (_row, mk) => mk === realCurrentMonth && !liveCurrentFast,
    },
    {
      report: 'past_due',
      rawMap: pastDueRawMap,
      needsRaw: (_row, mk) => mk === realCurrentMonth && !liveCurrentFast,
    },
    {
      report: 'insurance_activity',
      rawMap: insuranceActivityRawMap,
      needsRaw: (_row, mk) => mk === realCurrentMonth && !liveCurrentFast,
    },
    {
      report: 'reservations',
      rawMap: reservationsRawMap,
      needsRaw: (_row, mk) => mk === realCurrentMonth && !liveCurrentFast,
    },
    {
      report: 'marketing',
      rawMap: marketingRawMap,
      needsRaw: (_row, mk) => mk === realCurrentMonth && !liveCurrentFast,
    },
    {
      report: 'discounts',
      rawMap: discountsRawMap,
      needsRaw: (_row, mk) => mk === realCurrentMonth && !liveCurrentFast,
    },
    {
      report: 'insurance_roll',
      rawMap: insuranceRollRawMap,
      needsRaw: (_row, mk) => mk === realCurrentMonth && !liveCurrentFast,
    },
    {
      report: 'rate_changes',
      rawMap: rateChangesRawMap,
      needsRaw: (_row, mk) => mk === realCurrentMonth && !liveCurrentFast,
    },
    {
      report: 'move_ins_outs',
      rawMap: currentMonthMoveRawMap,
      needsRaw: (_row, mk) => mk === realCurrentMonth,
    },
  ]);
  const idx = {}; const chosenAt = {};   // de-dupe: when two raw rows collapse to the same YYYY-MM
  for (const r of rows) {                 // (e.g. legacy end-of-month keys vs canonical -01 keys), keep the
    const mk = String(r.month).slice(0, 7);            // most-recently-pulled one so stale rows can't win.
    const key = `${r.site_code}|${mk}|${r.report}`, atMs = timestampMs(r.pulled_at);
    if (chosenAt[key] != null && !(atMs > chosenAt[key])) continue;
    chosenAt[key] = atMs;
    const normalized = r.report === 'lead_funnel'
      ? normalizeLeadFunnelRow(r.data, leadFunnelRawMap?.get(`${r.site_code}|${mk}`), mk, { forceReparse: !!monthRange })
      : r.report === 'management'
        ? normalizeManagementRow(r.data, managementRawMap?.get(`${r.site_code}|${mk}`), mk)
      : r.report === 'financial' && financialRawMap?.has(`${r.site_code}|${mk}`) && (monthRange || mk === realCurrentMonth)
        ? (() => {
            const rawResponse = financialRawMap.get(`${r.site_code}|${mk}`);
            const bounds = monthKeyBounds(mk);
            if (!rawResponse || !bounds) return r.data;
            return REPORTS.financial.parse(extractRows(rawResponse), bounds.start, bounds.end, rawResponse);
          })()
      : r.report === 'past_due' && pastDueRawMap?.has(`${r.site_code}|${mk}`) && (monthRange || mk === realCurrentMonth)
        ? (() => {
            const rawResponse = pastDueRawMap.get(`${r.site_code}|${mk}`);
            const bounds = monthKeyBounds(mk);
            if (!rawResponse || !bounds) return r.data;
            return REPORTS.past_due.parse(extractRows(rawResponse), bounds.start, bounds.end, rawResponse);
          })()
      : r.report === 'insurance_activity' && insuranceActivityRawMap?.has(`${r.site_code}|${mk}`) && (monthRange || mk === realCurrentMonth)
        ? (() => {
            const rawResponse = insuranceActivityRawMap.get(`${r.site_code}|${mk}`);
            const bounds = monthKeyBounds(mk);
            if (!rawResponse || !bounds) return r.data;
            return REPORTS.insurance_activity.parse(extractRows(rawResponse), bounds.start, bounds.end, rawResponse);
          })()
      : r.report === 'reservations' && reservationsRawMap?.has(`${r.site_code}|${mk}`) && (monthRange || mk === realCurrentMonth)
        ? (() => {
            const rawResponse = reservationsRawMap.get(`${r.site_code}|${mk}`);
            const bounds = monthKeyBounds(mk);
            if (!rawResponse || !bounds) return r.data;
            return REPORTS.reservations.parse(extractRows(rawResponse), bounds.start, bounds.end, rawResponse);
          })()
      : r.report === 'marketing' && marketingRawMap?.has(`${r.site_code}|${mk}`) && (monthRange || mk === realCurrentMonth)
        ? (() => {
            const rawResponse = marketingRawMap.get(`${r.site_code}|${mk}`);
            const bounds = monthKeyBounds(mk);
            if (!rawResponse || !bounds) return r.data;
            return REPORTS.marketing.parse(extractRows(rawResponse), bounds.start, bounds.end, rawResponse);
          })()
      : r.report === 'discounts' && discountsRawMap?.has(`${r.site_code}|${mk}`) && (monthRange || mk === realCurrentMonth)
        ? (() => {
            const rawResponse = discountsRawMap.get(`${r.site_code}|${mk}`);
            const bounds = monthKeyBounds(mk);
            if (!rawResponse || !bounds) return r.data;
            return REPORTS.discounts.parse(extractRows(rawResponse), bounds.start, bounds.end, rawResponse);
          })()
      : r.report === 'insurance_roll' && insuranceRollRawMap?.has(`${r.site_code}|${mk}`) && (monthRange || mk === realCurrentMonth)
        ? (() => {
            const rawResponse = insuranceRollRawMap.get(`${r.site_code}|${mk}`);
            const bounds = monthKeyBounds(mk);
            if (!rawResponse || !bounds) return r.data;
            return REPORTS.insurance_roll.parse(extractRows(rawResponse), bounds.start, bounds.end, rawResponse);
          })()
      : r.report === 'rate_changes' && rateChangesRawMap?.has(`${r.site_code}|${mk}`) && (monthRange || mk === realCurrentMonth)
        ? (() => {
            const rawResponse = rateChangesRawMap.get(`${r.site_code}|${mk}`);
            const bounds = monthKeyBounds(mk);
            if (!rawResponse || !bounds) return r.data;
            return REPORTS.rate_changes.parse(extractRows(rawResponse), bounds.start, bounds.end, rawResponse);
          })()
      : r.report === 'occupancy' && occupancyRawMap?.has(`${r.site_code}|${mk}`) && (monthRange || mk === realCurrentMonth)
        ? (() => {
            const rawResponse = occupancyRawMap.get(`${r.site_code}|${mk}`);
            const bounds = monthKeyBounds(mk);
            if (!bounds) return r.data;
            if (!rawResponse) {
              return {
                ...(typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {})),
                __missing_raw_response: true,
              };
            }
            return REPORTS.occupancy.parse(extractRows(rawResponse), bounds.start, bounds.end, rawResponse);
          })()
      : r.report === 'rent_roll' && rentRollRawMap?.has(`${r.site_code}|${mk}`) && (monthRange || mk === realCurrentMonth)
        ? (() => {
            const rawResponse = rentRollRawMap.get(`${r.site_code}|${mk}`);
            const bounds = monthKeyBounds(mk);
            if (!bounds) return r.data;
            if (!rawResponse) {
              return {
                ...(typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {})),
                __missing_raw_response: true,
              };
            }
            return REPORTS.rent_roll.parse(extractRows(rawResponse), bounds.start, bounds.end, rawResponse);
          })()
      : r.report === 'scheduled_outs' && scheduledOutsRawMap?.has(`${r.site_code}|${mk}`) && (monthRange || mk === realCurrentMonth)
        ? (() => {
            const rawResponse = scheduledOutsRawMap.get(`${r.site_code}|${mk}`);
            const bounds = monthKeyBounds(mk);
            if (!bounds) return r.data;
            if (!rawResponse) {
              return {
                ...(typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {})),
                __missing_raw_response: true,
              };
            }
            return {
              ...(typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {})),
              ...REPORTS.scheduled_outs.parse(extractRows(rawResponse), bounds.start, bounds.end, rawResponse),
            };
          })()
      : r.report === 'move_ins_outs' && mk === realCurrentMonth && currentMonthMoveRawMap?.has(`${r.site_code}|${mk}`)
        ? (() => {
            const rawResponse = currentMonthMoveRawMap.get(`${r.site_code}|${mk}`);
            const bounds = monthKeyBounds(mk);
            if (!rawResponse || !bounds) return r.data;
            const startDay = `${mk}-01`;
            const endDay = formatLocalYmd(bounds.end);
            const trimmedRows = extractNamedTable(rawResponse, 'UnitMoveInsAndMoveOuts').filter((row) => {
              const day = String(row.MoveDate || '').slice(0, 10);
              return !!day && day >= startDay && day <= endDay;
            });
            const trimmed = REPORTS.move_ins_outs.parse(trimmedRows, bounds.start, bounds.end, null);
            return {
              ...(typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {})),
              visible_move_ins: trimmed.move_ins || 0,
              visible_move_outs: trimmed.move_outs || 0,
              moved_in_area: trimmed.moved_in_area || 0,
              moved_out_area: trimmed.moved_out_area || 0,
              net_area: trimmed.net_area || 0,
              move_in_tenant_ids: trimmed.move_in_tenant_ids || [],
              moved_in_rental_rate_sum: trimmed.moved_in_rental_rate_sum || 0,
              moved_in_variance_sum: trimmed.moved_in_variance_sum || 0,
              moved_in_std_rate_sum: trimmed.moved_in_std_rate_sum || 0,
            };
          })()
        : r.data;
    ((idx[r.site_code] ??= {})[mk] ??= {})[r.report] = normalized;
  }

  const monthsSet = new Set();
  for (const code of Object.keys(idx)) for (const mk of Object.keys(idx[code])) if (idx[code][mk].occupancy && idx[code][mk].occupancy.total_units > 0) monthsSet.add(mk);
  const months = [...monthsSet].sort();
  const latestPulledAtByMonth = {};
  for (const key of Object.keys(chosenAt)) {
    const parts = key.split('|');
    const mk = parts[1];
    const at = chosenAt[key];
    if (!at || (latestPulledAtByMonth[mk] && latestPulledAtByMonth[mk] >= at)) continue;
    latestPulledAtByMonth[mk] = at;
  }
  return { idx, nameOf, months, latestPulledAtByMonth };
}

// CHANGED 7 Jul 2026 (Michael, after comparing our July dashboard against the legacy portal's live
// July numbers): Enquiries/Move-ins/Move-outs and the other flow/count metrics below now show the
// CURRENT in-progress month's own real (partial) data, matching the legacy portal, instead of being
// silently overridden with the previous complete month's numbers. The previous approach (borrowing
// the prior month because a partial month "looks like near-zero/garbage") is REVERTED per explicit
// instruction to show real partial numbers even though they'll look low until the month closes.
export async function buildPayload(currentMonth, prevMonth) {
  const cur = ym(currentMonth), prev = ym(prevMonth);
  const { idx, nameOf, months, latestPulledAtByMonth } = await buildIndex();
  const autobillDailyMap = await fetchAutobillDailyMap();   // unfiltered — mirrors buildIndex()'s own full-history call above
  const visibleMonths = months.filter((mk) => mk <= cur);

  // LIGHT per-site record for every month
  const monthly = {};
  for (let mi = 0; mi < visibleMonths.length; mi++) {
    const mk = visibleMonths[mi];
    monthly[mk] = Object.keys(idx).filter(code => idx[code][mk] && idx[code][mk].occupancy && idx[code][mk].occupancy.total_units > 0)
      .map(code => {
        // currentMonthData ADDED 24 Jul 2026 (task #308/#404/#405) — pass the TRUE current month's
        // bundle only when `mk` is exactly the month immediately before it, the one case the Real Rate
        // rewind is valid for (see recordFor()'s own comment + lib/rewindOccupiedArea.js).
        const rec = recordFor(code, nameOf[code] || code, idx[code][mk], false, mk === cur, nextMonthKey(mk) === cur ? idx[code][cur] : null);
        applyAutobillDailyAverage(rec, mk, autobillDailyMap);
        return rec;
      });
  }
  // MoM deltas vs the previous month in the series
  for (let i = 0; i < visibleMonths.length; i++) {
    const pm = visibleMonths[i - 1]; if (!pm) continue;
    const prevByCode = Object.fromEntries(monthly[pm].map(r => [r.code, r]));
    for (const r of monthly[visibleMonths[i]]) {
      const p = prevByCode[r.code]; if (!p) continue;
      r.occD = +(r.occPC - p.occPC).toFixed(1); r.rentD = r.rent - p.rent; r.areaD = r.occA - p.occA;
    }
  }

  // FULL detail for the current month. The 17 Jul 2026 (task #303) prevC cross-month threading that
  // used to be described here is gone along with prevC itself — see reservationConversions' comment
  // inside recordFor() (task #310: reverted to a plain period-ratio, no cross-month data needed).
  // NOTE: the comment that used to be here ("s.enquiries = p.enquiries") described a generic
  // "borrow previous month" override loop that was removed 7 Jul 2026 (see the True Revenue restore
  // below) — Enquiries/Move-ins/Move-outs etc. now correctly show the current month's own real
  // (partial) data, with no substitution, per Michael's explicit 7 Jul instruction.
  const sites = Object.keys(NAMES)
    .map(code => {
      // No currentMonthData here (defaults to null) — this call IS the current in-progress month's
      // own record, so there's no "later" data to rewind its occupied area with yet (see
      // recordFor()'s comment) — stays on the pre-24-Jul frozen-snapshot formula until next month.
      const rec = recordFor(code, nameOf[code] || NAMES[code] || code, (idx[code] && idx[code][cur]) || {}, true, true);
      applyAutobillDailyAverage(rec, cur, autobillDailyMap);
      return rec;
    });
  const prevByCode = monthly[prev] ? Object.fromEntries(monthly[prev].map(r => [r.code, r])) : {};
  for (const s of sites) {
    const p = prevByCode[s.code];
    if (!p) continue;
    s.occD = +(s.occPC - p.occPC).toFixed(1); s.rentD = s.rent - p.rent; s.areaD = s.occA - p.occA;
    // RESTORED 16 Jul 2026 (Michael's audit: Financials page's True Revenue table AND True Revenue
    // — Unit Types table "not close to legacy") — root cause: these are full-CALENDAR-MONTH flow
    // metrics; legacy always shows the last COMPLETE month for them (confirmed 3 Jul 2026 — see the
    // matching comment in recordFor() above), never the in-progress current month's partial data.
    // That substitution used to happen via a generic "borrow previous month" override loop that got
    // deliberately removed 7 Jul 2026 for Enquiries/Move-ins/Move-outs (which SHOULD show real
    // partial current-month numbers, per Michael's explicit instruction that day) — True Revenue's
    // (and Rental Activity's) OWN substitution was an unintended casualty of that same revert, since
    // it relied on the identical mechanism. Restoring it here, scoped to just these fields, so the
    // current-month default view once again matches legacy's last-complete-month convention while
    // Enquiries/Move-ins/Move-outs stay on real partial data as intended.
    s.trueRevenueByDesc = p.trueRevenueByDesc || [];
    s.trueRevenueByType = p.trueRevenueByType || [];
    s.rentalActivityByTypeSize = p.rentalActivityByTypeSize || [];
  }
  // SORTED BY SITE CODE 8 Jul 2026 (Michael: "organize each widget by store, bicester should be first
  // l001 and abington should be last l029, this includes the filter at the top") — was sorted by
  // occPC descending, which made every per-site table AND the top store-filter dropdown (built
  // straight off this same sites[] array in app/portal-v2/page.js's storeOptions) reorder themselves
  // every time occupancy changed, with no stable/predictable position for any given store. Codes are
  // consistently "L" + 3 digits (L001..L029) so a plain string compare sorts them numerically too.
  sites.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
  const totals = aggregateTotals(sites);

  const generatedAt = [cur, prev]
    .map((mk) => latestPulledAtByMonth[mk] || null)
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || null;
  return {
    build_version: PORTAL_PAYLOAD_BUILD_VERSION,
    generated_at: timestampIso(generatedAt),
    current_month: cur,
    prev_month: prev,
    months: visibleMonths,
    sites,
    totals,
    history: buildHistory(visibleMonths, monthly),
    monthly,
  };
}

// Lightweight full-detail current-month builder for read-time refreshes. Unlike buildPayload(), this
// only scans the current visible month plus the immediately previous month needed for deltas and the
// True Revenue / Rental Activity last-complete-month substitution.
export async function buildCurrentMonthPayload(currentMonth, prevMonth) {
  const cur = ym(currentMonth), prev = ym(prevMonth);
  const afterCur = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
  const monthRange = {
    start: `${prev}-01`,
    endExclusive: `${afterCur.getFullYear()}-${String(afterCur.getMonth() + 1).padStart(2, '0')}-01`,
  };
  const { idx, nameOf, months, latestPulledAtByMonth } = await buildIndex(monthRange, { liveCurrentFast: true });
  const autobillDailyMap = await fetchAutobillDailyMap(monthRange);
  const visibleMonths = months.filter((mk) => mk === prev || mk === cur).sort();

  const monthly = {};
  for (const mk of visibleMonths) {
    monthly[mk] = Object.keys(idx).filter(code => idx[code][mk] && idx[code][mk].occupancy && idx[code][mk].occupancy.total_units > 0)
      .map(code => {
        const rec = recordFor(code, nameOf[code] || code, idx[code][mk], false, mk === cur, nextMonthKey(mk) === cur ? idx[code][cur] : null);
        applyAutobillDailyAverage(rec, mk, autobillDailyMap);
        return rec;
      });
  }

  const sites = Object.keys(NAMES)
    .map(code => {
      const rec = recordFor(code, nameOf[code] || NAMES[code] || code, (idx[code] && idx[code][cur]) || {}, true, true);
      applyAutobillDailyAverage(rec, cur, autobillDailyMap);
      return rec;
    });
  const prevByCode = monthly[prev] ? Object.fromEntries(monthly[prev].map(r => [r.code, r])) : {};
  for (const s of sites) {
    const p = prevByCode[s.code];
    if (!p) continue;
    s.occD = +(s.occPC - p.occPC).toFixed(1);
    s.rentD = s.rent - p.rent;
    s.areaD = s.occA - p.occA;
    s.trueRevenueByDesc = p.trueRevenueByDesc || [];
    s.trueRevenueByType = p.trueRevenueByType || [];
    s.rentalActivityByTypeSize = p.rentalActivityByTypeSize || [];
  }
  sites.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
  const totals = aggregateTotals(sites);
  const generatedAt = [cur, prev]
    .map((mk) => latestPulledAtByMonth[mk] || null)
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || null;
  return {
    build_version: PORTAL_PAYLOAD_BUILD_VERSION,
    generated_at: timestampIso(generatedAt),
    current_month: cur,
    prev_month: prev,
    months: visibleMonths,
    sites,
    totals,
  };
}

// Portfolio-wide rollup from a `sites[]` array (any set of full-detail site records — the current
// month's in normal use, or a range-merged set from buildPayloadRange() below). Extracted 6 Jul 2026
// so the global month/date-range selector can reuse the EXACT same sum-then-divide-once rules
// instead of a second hand-copied implementation drifting out of sync over time.
export function aggregateTotals(sites) {
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
    n: sites.length, occ: sum('occ'), tot: sum('tot'), occA, claA, totA: sum('totA'), rent: sum('rent'), gpot: sum('gpot'), grossOcc: sum('grossOcc'), occActualRent: sum('occActualRent'),
    occPC: sum('tot') ? +(sum('occ') / sum('tot') * 100).toFixed(1) : 0,
    // Keep `areaPC` on the same CLA basis as the per-site record and widget label. `areaPCmla`
    // exists separately for the MLA version; using totA here made aggregate/custom-widget totals
    // silently disagree with both the store rows and the "Occupied Area % of CLA" label.
    areaPC: claA ? +(occA / claA * 100).toFixed(1) : (sum('totA') ? +(occA / sum('totA') * 100).toFixed(1) : 0),
    areaPCmla: sum('totA') ? +(occA / sum('totA') * 100).toFixed(1) : 0,
    // Economic Occupancy — ADDED 21 Jul 2026 (Rich's portal review, task #356), per his supplied
    // Economic occupancy Tracker.xlsx: Σ ActualOccupied ÷ Σ GrossPotential × 100 (sum-then-divide,
    // portfolio-wide). Both numerator (occActualRent, OccupancyStatistics' ActualOccupied — actual
    // billed rent of occupied units) and denominator (gpot, GrossPotential — potential income at 100%
    // occupancy, full asking rate) were ALREADY pulled/aggregated for other widgets (occActualRent
    // for Debtor Levels' rentRollPct, gpot for the Rate/Real Rate tiles) — no new report/field needed,
    // purely a new ratio of two existing sums. Blends vacancy loss AND rate/discount loss into one
    // number, distinct from plain Occupancy % (units) and Area Occupancy % (sqft), both of which
    // ignore how much occupied space is actually billed at vs its full asking rate.
    economicOccPct: sum('gpot') ? +(sum('occActualRent') / sum('gpot') * 100).toFixed(1) : 0,
    // Portfolio "% of CLA" — the single authoritative occupancy-by-area figure. Falls back to
    // areaPC (occA/totA) only if no site reports a CLA area at all, matching the per-site rule
    // in recordFor() above (areaPC there = claA ? occA/claA : occA/totA).
    claPC: claA ? +(occA / claA * 100).toFixed(1) : (sum('totA') ? +(occA / sum('totA') * 100).toFixed(1) : 0),
    // Rate / Real Rate / SS variants: sum the RAW numerator + denominator across sites FIRST, then
    // divide once — per the locked spec, never average already-divided per-site rates.
    // Rate: REPLACED 22 Jul 2026 (task #308) — billing-adjusted dcRent-based (adjRentSum/ssAdjRentSum,
    // see recordFor()'s matching comment), falling back to the old dcStdRate-based stdRentSum/
    // ssStdRentSum per-site whenever billing_frequency wasn't available for that site/month.
    // Real Rate: REPLACED 8 Jul 2026 — True Revenue-based (see recordFor()'s trueRevenueNumerator
    // comment). rentSum/stdRentSum are kept as raw fields for reference but no longer feed Real Rate.
    rate: sum('areaSum') ? R2(sum('adjRentSum') / sum('areaSum') * 12) : 0,
    // Real Rate — SWITCHED 24 Jul 2026 (task #308/#404/#405) from summing trueRevenueNumerator/
    // areaTotalAll (all True Revenue charge types ÷ total area incl. vacant) to summing
    // rentTruePeriod/realRateArea (Rent-only True Revenue ÷ rewound-or-frozen occupied area — see
    // recordFor()'s matching comment for the full root-cause/validation). Same sum-then-divide-once
    // rule either way; rentTruePeriod/realRateArea are ALWAYS populated (each falls back component-by-
    // component to the pre-24-Jul figures on recordFor() whenever the newer inputs aren't available),
    // so this portfolio total stays consistent with whichever basis each individual site actually used.
    realRate: sum('realRateArea') ? R2(sum('rentTruePeriod') / sum('realRateArea') * realRateAnnualizeFactor) : 0,
    ssRate: sum('ssAreaSum') ? R2(sum('ssAdjRentSum') / sum('ssAreaSum') * 12) : 0,
    // ssReal — SWITCHED 24 Jul 2026 (task #308 follow-up) from ssTrueRevenueNumerator/ssAreaTotalAll
    // to ssRentTruePeriod/ssRealArea, mirroring the Total realRate switch above (see recordFor()'s
    // ssReal comment for the full explanation). Same sum-then-divide-once rule either way;
    // ssRentTruePeriod/ssRealArea are ALWAYS populated (each falls back component-by-component to the
    // pre-24-Jul figures whenever the newer inputs aren't available).
    ssReal: sum('ssRealArea') ? R2(sum('ssRentTruePeriod') / sum('ssRealArea') * realRateAnnualizeFactor) : 0,
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
  // FIXED 24 Jul 2026 (deep audit): the aggregate debtor widgets/tables are explicitly labeled
  // "30+ days" everywhere in the UI, and per-site rows already read `debtors.total` for that same
  // bucket. This rollup had drifted to `allOverdue`, which can be broader whenever only the older
  // PastDueBalances fallback fields exist. That let the portfolio total/% be computed from a wider
  // bucket than the store rows it sat beside. Keep the aggregate on the exact displayed 30+ source.
  const debtTotal = sites.reduce((a, s) => a + (s.debtors ? s.debtors.total : 0), 0);
  const occActualRentSum = sum('occActualRent');
  totals.debtorTenantPct = totals.occ ? +(debtAccounts / totals.occ * 100).toFixed(1) : 0;
  totals.debtorRentRollPct = occActualRentSum ? +(debtTotal / occActualRentSum * 100).toFixed(1) : 0;
  totals.debtorTotal = debtTotal;
  // Autobill Conversion — "new autobilled customers / total new customers" (legacy tooltip,
  // confirmed 2 Jul 2026), sum-then-divide across sites. NOT the whole-book autobill rate (kept
  // below as autobillPC_allTenants for reference/back-compat, no longer shown on the widget).
  const autobillNewCountSum = sum('autobillNewCount');
  const autobillNewCountExactSum = sites.reduce((a, s) => a + ((s.autobillNewCountExact ?? s.autobillNewCount) || 0), 0);
  const autobillNewTotalSum = sum('autobillNewTotal');
  totals.autobillNewCount = Math.round(autobillNewCountExactSum);
  totals.autobillNewCountExact = autobillNewCountExactSum;
  totals.autobillNewTotal = autobillNewTotalSum;
  totals.autobillPC = autobillNewTotalSum ? +(autobillNewCountExactSum / autobillNewTotalSum * 100).toFixed(1) : 0;
  totals.stayDaysSum = sites.reduce((a, s) => a + ((s.stayDaysSum ?? (((s.avgStayDays > 0) && (s.occ || 0) > 0) ? s.avgStayDays * s.occ : 0)) || 0), 0);
  totals.stayCount = sites.reduce((a, s) => a + ((s.stayCount ?? (((s.avgStayDays > 0) && (s.occ || 0) > 0) ? s.occ : 0)) || 0), 0);
  totals.stayRentSum = sites.reduce((a, s) => a + ((s.stayRentSum ?? (((s.avgStayDays > 0) && (s.occ || 0) > 0) ? s.rent : 0)) || 0), 0);
  totals.avgStayDays = totals.stayCount ? Math.round(totals.stayDaysSum / totals.stayCount) : 0;
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
  totals.reservations = sum('reservations');
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
  totals.moveInAreaSum = sum('moveInAreaSum');
  totals.moveOutAreaSum = sum('moveOutAreaSum');
  totals.moveInRateSum = sum('moveInRateSum');
  // Enquiries (Marketing page / exports) — normalize the top-level totals shape to match the per-site
  // records and current-month history point. Several UI paths already recompute these from sites, but
  // leaving them absent at the portfolio level makes the payload internally inconsistent and invites
  // future widget/export drift.
  totals.enquiries = {
    total: sites.reduce((a, s) => a + ((s.enquiries && s.enquiries.total) || 0), 0),
    conversions: sites.reduce((a, s) => a + ((s.enquiries && s.enquiries.conversions) || 0), 0),
    reservationConversions: sites.reduce((a, s) => a + ((s.enquiries && s.enquiries.reservationConversions) || 0), 0),
    reservationConversionBase: sites.reduce((a, s) => a + ((s.enquiries && (s.enquiries.reservationConversionBase ?? s.enquiries.total)) || 0), 0),
    phone: sites.reduce((a, s) => a + ((s.enquiries && s.enquiries.phone) || 0), 0),
    walkin: sites.reduce((a, s) => a + ((s.enquiries && s.enquiries.walkin) || 0), 0),
    web: sites.reduce((a, s) => a + ((s.enquiries && s.enquiries.web) || 0), 0),
    webOnly: sites.reduce((a, s) => a + ((s.enquiries && (s.enquiries.webOnly ?? s.enquiries.web)) || 0), 0),
    email: sites.reduce((a, s) => a + ((s.enquiries && s.enquiries.email) || 0), 0),
  };
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
  // FIXED 21 Jul 2026 (task #396) — true portfolio-wide distinct-unit count (see recordFor()'s
  // discountUnitsTotal comment), NOT a sum of discountPlanRows' own per-plan units above — that sum
  // double-counts any unit on more than one plan this month. Straight sum across sites is safe here
  // (a unit belongs to exactly one site, so no cross-site double-count risk).
  totals.discountUnitsOnPlan = sum('discountUnitsTotal');

  // Keep the aggregate payload's shape aligned with both the per-site current-month records and the
  // per-month history points: these are current-month flow totals, not just snapshot-page concepts.
  // They were already present everywhere else and are cheap, unambiguous sums here.
  totals.moveIns = sum('moveIns');
  totals.moveOuts = sum('moveOuts');
  totals.netArea = sum('netArea');

  // Move-in Variance vs Standard Rate (RESOURCED 21 Jul 2026, task #360 — see recordFor()'s comment).
  // This-period half: sum count/variance/standard-rate across sites first, divide once — never
  // average each site's own already-divided %. Whole-book half (VarFromStdRate): bucket counts summed
  // across sites — a straight count, no division involved. Bucket order preserved via SortID (added
  // to the reportMap.js parser specifically so this doesn't depend on object-key insertion order).
  totals.moveInVarianceCount = sum('moveInVarianceCount');
  const moveInVarianceSumTotal = sum('moveInVarianceSum');
  const moveInStdRateSumTotal = sum('moveInStdRateSum');
  totals.moveInVarianceSum = moveInVarianceSumTotal;
  totals.moveInStdRateSum = moveInStdRateSumTotal;
  totals.moveInVarStdRatePct = moveInStdRateSumTotal ? +(moveInVarianceSumTotal / moveInStdRateSumTotal * 100).toFixed(2) : 0;
  totals.moveInVarStdRateActualPct = totals.moveInVarianceCount ? +(totals.moveInVarStdRatePct - 8.33).toFixed(2) : null;
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
    // the visible Marketing conversion numerator/base for THIS month is already correct with no
    // averaging-bug risk (the
    // sum-then-divide RULE in this file is about not averaging already-divided per-month %s together
    // when collapsing several months into one — see mergeRowsAcrossMonths' and aggregateTotals'
    // comments — a single point isn't at risk of that).
    const enqTotal = recs.reduce((a, r) => a + (r.enquiries ? r.enquiries.total : 0), 0);
    const enqReservationConversions = recs.reduce((a, r) => a + (r.enquiries ? r.enquiries.reservationConversions : 0), 0);
    const enqReservationConversionBase = recs.reduce((a, r) => a + (r.enquiries ? (r.enquiries.reservationConversionBase ?? r.enquiries.total ?? 0) : 0), 0);
    return {
      month: mk, occ: s('occ'), tot: s('tot'), occPC: s('tot') ? +(s('occ') / s('tot') * 100).toFixed(1) : 0, occA: oa, rent: s('rent'), ssOccA: ssoa,
      // REPLACED 22 Jul 2026 (task #308) — see aggregateTotals()'s matching note above.
      rate: s('areaSum') ? R2(s('adjRentSum') / s('areaSum') * 12) : 0,
      ssRate: s('ssAreaSum') ? R2(s('ssAdjRentSum') / s('ssAreaSum') * 12) : 0,
      revenue: recs.reduce((a, r) => a + (r.revenue ? r.revenue.collected : 0), 0),
      moveIns: s('moveIns'), moveOuts: s('moveOuts'),   // moveOuts added for Customer Churn (trailing 12mo moveOuts / avg occ) once backfill gives >=12 months
      insured: recs.reduce((a, r) => a + (r.insurance ? r.insurance.insured : 0), 0),
      insurancePremium: s('insurancePremiumSum'),   // Month-on-Month "Insurance Roll" trend
      enqTotal, enqReservationConversions, enqReservationConversionBase,   // Marketing YoY trend (task #136) — visible legacy-style channel counts/conversions, portfolio-wide
      enqPhone: recs.reduce((a, r) => a + (r.enquiries ? r.enquiries.phone : 0), 0),
      enqWeb: recs.reduce((a, r) => a + (r.enquiries ? r.enquiries.web : 0), 0),
      enqWalkin: recs.reduce((a, r) => a + (r.enquiries ? r.enquiries.walkin : 0), 0),
      // Keep "no visible enquiry base" distinct from a genuine 0% conversion month. Serializing this
      // as 0 made the stored history payload quietly claim a real zero-conversion month even when the
      // rate was actually not derivable at all.
      enqConvPct: enqReservationConversionBase ? +(enqReservationConversions / enqReservationConversionBase * 100).toFixed(1) : null,
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
  // adjRentSum/ssAdjRentSum ADDED 22 Jul 2026 (task #308) — the new billing-adjusted Rate numerator,
  // same sum-then-divide-once treatment as stdRentSum/ssStdRentSum above.
  'adjRentSum', 'ssAdjRentSum',
  'trueRevenueNumerator', 'ssTrueRevenueNumerator', 'areaTotalAll', 'ssAreaTotalAll',
  // rentTruePeriod/realRateArea ADDED 24 Jul 2026 (task #308/#404/#405) — same point-in-time-snapshot
  // averaging treatment as trueRevenueNumerator/areaTotalAll above, which these supersede for realRate
  // specifically (see recordFor()'s + aggregateTotals()'s matching comments).
  'rentTruePeriod', 'realRateArea',
  // ssRentTruePeriod/ssRealArea ADDED 24 Jul 2026 (task #308 follow-up) — same treatment, Self
  // Storage's own version (see recordFor()'s ssReal comment).
  'ssRentTruePeriod', 'ssRealArea',
  'autobillRate', 'avgStayDays', 'autobillCount', 'tenantsCount',
  'activeReservations', 'reservedSqftEstimate', 'scheduledOuts',
];
// Flow/count metrics for a full calendar month (Enquiries, Move-ins/outs, Merchandise, Insurance new
// customers, Autobill new customers, InquiryTracking's own `reservations` conversion count) — these
// genuinely accumulate over a period, so a 3-month range should show 3 months' worth, not an average
// of 3 monthly totals.
const RANGE_SUM_FIELDS = ['moveIns', 'moveOuts', 'netArea', 'moveInAreaSum', 'moveOutAreaSum', 'moveInRateSum', 'autobillNewCount', 'autobillNewCountExact', 'autobillNewTotal', 'reservations', 'reservationsMade', 'stayDaysSum', 'stayCount', 'stayRentSum'];

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
  // A single-month selection should be the exact month record, not a synthetic range merge. Routing
  // even one month through the range-merging path risks silently dropping fields that the direct
  // current-month record already computed correctly (for example Reservations Made and several
  // full-detail current-month arrays), while adding no user-visible benefit.
  if ((recs?.length || 0) === 1) return JSON.parse(JSON.stringify(recs[0]));
  const last = recs[recs.length - 1];
  const rec = JSON.parse(JSON.stringify(last));   // start from the LAST month's record — anything not
  // explicitly re-aggregated below (unitTypes/unitMix/debtors.ageing/revenue.categories/marketing.sources,
  // plus name/code) simply falls back to a last-month snapshot. Known v1 limitation, not yet range-aware.

  for (const k of RANGE_AVG_FIELDS) rec[k] = avgOf(recs, (r) => r[k]);
  for (const k of RANGE_SUM_FIELDS) rec[k] = sumOf(recs, (r) => r[k]);

  rec.ss = {
    occ: avgOf(recs, (r) => r.ss && r.ss.occ), tot: avgOf(recs, (r) => r.ss && r.ss.tot),
    occA: avgOf(recs, (r) => r.ss && r.ss.occA),
    // Keep nested Self Storage rent/gpot aligned with the selected range too. These feed the custom
    // widget builder directly (`ss.rent`, `ss.gpot`); leaving them on the last month's deep-copied
    // snapshot made a multi-month range label silently lie for those fields even after the main ss
    // occupancy/rate values were made range-aware.
    rent: avgOf(recs, (r) => r.ss && r.ss.rent),
    gpot: avgOf(recs, (r) => r.ss && r.ss.gpot),
    rate: 0, real: 0,
  };
  rec.offices = { occ: avgOf(recs, (r) => r.offices && r.offices.occ), tot: avgOf(recs, (r) => r.offices && r.offices.tot), rate: 0 };
  // `vacant` / `unrentable` are snapshot counts from OccupancyStatistics, same class as occ/tot/occA.
  // The custom widget builder exposes them directly, so a range-labeled widget should not keep the
  // final month's count while the rest of the occupancy payload is averaged across the selected months.
  rec.vacant = avgOf(recs, (r) => r.vacant);
  rec.unrentable = avgOf(recs, (r) => r.unrentable);
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
  // FIXED 24 Jul 2026 (deep audit): these nested objects were still falling through from the last
  // month because mergeSiteAcrossRange() started from the final record and only re-aggregated a
  // subset of fields. Result: a multi-month range could label a site/widget as covering several
  // months while Revenue / Rate Changes / Marketing source counts were actually just the final
  // month's snapshot. Rebuild them here with the same period semantics as their source reports.
  rec.revenue = {
    charge: R2(sumOf(recs, (r) => r.revenue && r.revenue.charge)),
    payment: R2(sumOf(recs, (r) => r.revenue && r.revenue.payment)),
    credit: R2(sumOf(recs, (r) => r.revenue && r.revenue.credit)),
    discount: R2(sumOf(recs, (r) => r.revenue && r.revenue.discount)),
  };
  rec.revenue.collected = R2(rec.revenue.charge - rec.revenue.credit);
  rec.merchandise = {
    sales: R2(sumOf(recs, (r) => r.merchandise && r.merchandise.sales)), cost: R2(sumOf(recs, (r) => r.merchandise && r.merchandise.cost)),
    margin: R2(sumOf(recs, (r) => r.merchandise && r.merchandise.margin)), chargeFromFinancial: R2(sumOf(recs, (r) => r.merchandise && r.merchandise.chargeFromFinancial)),
  };
  const rateIncreases = sumOf(recs, (r) => r.rateChanges && r.rateChanges.increases);
  const rateDecreases = sumOf(recs, (r) => r.rateChanges && r.rateChanges.decreases);
  const rateAvgPctWeightedNumer = recs.reduce((sum, r) => sum + ((r.rateChanges?.avgPct || 0) * (r.rateChanges?.increases || 0)), 0);
  rec.rateChanges = {
    increases: rateIncreases,
    decreases: rateDecreases,
    avgPct: rateIncreases ? +((rateAvgPctWeightedNumer / rateIncreases).toFixed(1)) : 0,
  };
  // MarketingSummary is a DATED monthly-flow report (per reportMap.js), not a point-in-time snapshot:
  // TenTot / TenComNum / TenResNum are "this month's tenants from marketing source" counts. Averaging
  // them across a selected multi-month range understates the period and contradicts the report's own
  // month-scoped totals. Sum the counts across the range, but still recompute avgRent from the summed
  // weighted numerator/denominator once rather than averaging already-divided monthly averages.
  const marketingTenantsSum = sumOf(recs, (r) => r.marketing && r.marketing.tenants);
  const marketingCommercialSum = sumOf(recs, (r) => r.marketing && r.marketing.commercial);
  const marketingResidentialSum = sumOf(recs, (r) => r.marketing && r.marketing.residential);
  const marketingAvgRentNumer = recs.reduce((sum, r) => sum + ((r.marketing?.avgRent || 0) * ((r.marketing?.commercial || 0) + (r.marketing?.residential || 0))), 0);
  const marketingAvgRentDenom = recs.reduce((sum, r) => sum + (r.marketing?.commercial || 0) + (r.marketing?.residential || 0), 0);
  rec.marketing = {
    tenants: marketingTenantsSum,
    commercial: marketingCommercialSum,
    residential: marketingResidentialSum,
    avgRent: marketingAvgRentDenom ? R2(marketingAvgRentNumer / marketingAvgRentDenom) : 0,
  };
  rec.marketing.sources = (() => {
    const g = {};
    for (const r of recs) for (const row of (r.marketing?.sources || [])) {
      const key = row.source || '';
      const o = (g[key] ??= { source: key, tenants: 0, commercial: 0, residential: 0, com_avg_rent_numer: 0, res_avg_rent_numer: 0, moveins: 0 });
      const commercial = row.commercial || 0;
      const residential = row.residential || 0;
      o.tenants += row.tenants || 0;
      o.commercial += commercial;
      o.residential += residential;
      o.com_avg_rent_numer += commercial * (row.com_avg_rent || 0);
      o.res_avg_rent_numer += residential * (row.res_avg_rent || 0);
      o.moveins += row.moveins || 0;
    }
    return Object.values(g)
      .map((row) => ({
        source: row.source,
        tenants: row.tenants,
        commercial: row.commercial,
        residential: row.residential,
        com_avg_rent: row.commercial ? R2(row.com_avg_rent_numer / row.commercial) : 0,
        res_avg_rent: row.residential ? R2(row.res_avg_rent_numer / row.residential) : 0,
        moveins: row.moveins,
      }))
      .sort((a, b) => String(a.source).localeCompare(String(b.source)));
  })();
  // Keep the nested breakdowns aligned with the same range semantics as their parent objects rather
  // than silently inheriting the final month from the initial deep-copy above.
  rec.debtors.ageing = (() => {
    const keys = ['0-10', '11-30', '31-60', '61-90', '91-120', '121-180', '181-360', '361+'];
    const out = {};
    for (const key of keys) out[key] = R2(avgOf(recs, (r) => r.debtors?.ageing?.[key]));
    return out;
  })();
  rec.revenue.categories = (() => {
    const g = {};
    for (const r of recs) for (const row of (r.revenue?.categories || [])) {
      const key = `${row.category || ''}|${row.desc || ''}`;
      const o = (g[key] ??= { category: row.category || '', desc: row.desc || '', charge: 0, payment: 0, discount: 0, credit: 0 });
      o.charge = R2(o.charge + (row.charge || 0));
      o.payment = R2(o.payment + (row.payment || 0));
      o.discount = R2(o.discount + (row.discount || 0));
      o.credit = R2(o.credit + (row.credit || 0));
    }
    return Object.values(g);
  })();
  rec.unitTypes = (() => {
    const g = {};
    for (const r of recs) for (const row of (r.unitTypes || [])) {
      const key = row.unit_type || '';
      const o = (g[key] ??= { unit_type: key, units: 0, area: 0, rent: 0 });
      o.units += row.units || 0;
      o.area += row.area || 0;
      o.rent += row.rent || 0;
    }
    const n = recs.length || 1;
    return Object.values(g)
      .map((row) => {
        const units = row.units / n;
        const area = row.area / n;
        const rent = row.rent / n;
        return {
          unit_type: row.unit_type,
          units,
          area: R2(area),
          rent: R2(rent),
          rate_per_sqft_ann: area ? R2(rent / area * 12) : 0,
        };
      })
      .sort((a, b) => String(a.unit_type).localeCompare(String(b.unit_type)));
  })();
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
  // FIXED 23 Jul 2026 (production-readiness audit): unitMix was one of the arrays left behind in the
  // initial "start from last month, only re-aggregate some fields" range implementation, so the KPI
  // page's "Unit Mix Occupancy (All Stores)" table silently showed the LAST month's snapshot under a
  // multi-month range label. That's a direct contradiction of the range semantics documented above:
  // snapshot-style occupancy/unit/area fields should be AVERAGED across the selected months, not
  // replaced by the final month. Merge by rounded size bucket (the same key reportMap.js emits) and
  // average the raw counts/areas, then recompute occ_pc from those averaged components.
  rec.unitMix = (() => {
    const g = {};
    for (const r of recs) for (const row of (r.unitMix || [])) {
      const key = String(row.area ?? '');
      const o = (g[key] ??= { area: row.area || 0, occ: 0, tot: 0, occ_area: 0, total_area: 0 });
      o.occ += row.occ || 0;
      o.tot += row.tot || 0;
      o.occ_area += row.occ_area || 0;
      o.total_area += row.total_area || 0;
    }
    const n = recs.length || 1;
    return Object.values(g)
      .map((row) => {
        const occ = row.occ / n;
        const tot = row.tot / n;
        const occArea = row.occ_area / n;
        const totalArea = row.total_area / n;
        return {
          area: row.area,
          occ: occ,
          tot: tot,
          occ_area: occArea,
          total_area: totalArea,
          occ_pc: tot ? +(occ / tot * 100).toFixed(1) : 0,
        };
      })
      .sort((a, b) => a.area - b.area);
  })();
  // FIXED 28 Jul 2026 (continued production-readiness audit): occByTypeSize was still one of the
  // nested arrays silently inherited from the LAST month via the initial deep-copy above. The KPI
  // page's Economic Occupancy detail table reads this structure directly, so a multi-month range was
  // labeling the table as a range while actually showing only the final month's type/size snapshot.
  // Same semantics as unitMix just above: these are occupancy-style month snapshots, so average the
  // raw counts/areas/revenue sums across the selected months, then let page.js derive the displayed
  // occupancy / economic occupancy / asking / in-place metrics from those averaged components.
  rec.occByTypeSize = (() => {
    const g = {};
    for (const r of recs) for (const row of (r.occByTypeSize || [])) {
      const key = `${row.type || ''}|${row.area ?? ''}`;
      const o = (g[key] ??= {
        type: row.type || '',
        area: row.area || 0,
        occ: 0,
        tot: 0,
        occArea: 0,
        totalArea: 0,
        grossPotential: 0,
        actualOccupied: 0,
      });
      o.occ += row.occ || 0;
      o.tot += row.tot || 0;
      o.occArea += row.occArea || 0;
      o.totalArea += row.totalArea || 0;
      o.grossPotential += row.grossPotential || 0;
      o.actualOccupied += row.actualOccupied || 0;
    }
    const n = recs.length || 1;
    return Object.values(g)
      .map((row) => ({
        type: row.type,
        area: row.area,
        occ: row.occ / n,
        tot: row.tot / n,
        occArea: R2(row.occArea / n),
        totalArea: R2(row.totalArea / n),
        grossPotential: R2(row.grossPotential / n),
        actualOccupied: R2(row.actualOccupied / n),
      }))
      .sort((a, b) => (String(a.type || '').localeCompare(String(b.type || '')) || ((a.area || 0) - (b.area || 0))));
  })();
  rec.autobillNewCountExact = sumOf(recs, (r) => r.autobillNewCountExact ?? r.autobillNewCount);
  rec.autobillNewCount = Math.round(rec.autobillNewCountExact);
  rec.stayDaysSum = sumOf(recs, (r) => r.stayDaysSum ?? (((r.avgStayDays > 0) && (r.occ || 0) > 0) ? r.avgStayDays * r.occ : 0));
  rec.stayCount = sumOf(recs, (r) => r.stayCount ?? (((r.avgStayDays > 0) && (r.occ || 0) > 0) ? r.occ : 0));
  rec.stayRentSum = R2(sumOf(recs, (r) => r.stayRentSum ?? (((r.avgStayDays > 0) && (r.occ || 0) > 0) ? r.rent : 0)));
  rec.enquiries = {
    total: sumOf(recs, (r) => r.enquiries && r.enquiries.total),
    conversions: sumOf(recs, (r) => r.enquiries && r.enquiries.conversions),
    reservationConversions: sumOf(recs, (r) => r.enquiries && r.enquiries.reservationConversions),
    reservationConversionBase: sumOf(recs, (r) => r.enquiries && (r.enquiries.reservationConversionBase ?? r.enquiries.total)),
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
  // Summed across the range's months, same convention as discountPlans just above (a genuine
  // multi-month flow total, not deduplicated across months — consistent with every other flow metric
  // here for range views; the task #396 fix only targeted the WITHIN-one-month cross-plan double
  // count, not the separate multi-month-range semantics, which Michael already chose explicitly).
  rec.discountUnitsTotal = sumOf(recs, (r) => r.discountUnitsTotal);
  // Move-in Variance vs Standard Rate, this-period half — sum raw count/variance/standard-rate across
  // the range's months first, divide once (never average each month's own already-divided %; see
  // recordFor()'s comment on the 21 Jul 2026 MI/MO-report resourcing, task #360).
  rec.moveInVarianceCount = sumOf(recs, (r) => r.moveInVarianceCount);
  rec.moveInVarianceSum = R2(sumOf(recs, (r) => r.moveInVarianceSum));
  rec.moveInStdRateSum = R2(sumOf(recs, (r) => r.moveInStdRateSum));
  rec.moveInVarStdRatePct = rec.moveInStdRateSum ? +(rec.moveInVarianceSum / rec.moveInStdRateSum * 100).toFixed(2) : 0;
  rec.moveInVarStdRateActualPct = rec.moveInVarianceCount ? +(rec.moveInVarStdRatePct - 8.33).toFixed(2) : null;
  // varFromStdRate (whole-book half) intentionally NOT re-aggregated here — it's a live "as of now"
  // snapshot regardless of month (see reportMap.js's comment), so it just inherits the last month's
  // value from `rec`'s initial deep-copy at the top of this function, same as unitTypes/debtors.ageing.

  // Recompute every derived rate/percentage from the range-aggregated raw sums, exactly mirroring
  // recordFor()'s own formulas — never trust an averaged/summed already-divided rate.
  rec.rpu = rec.occ ? R2(rec.rent / rec.occ) : 0;
  rec.occPC = rec.tot ? +(rec.occ / rec.tot * 100).toFixed(1) : 0;
  // BUG FIX 17 Jul 2026 (full-portal review): autobillRate was in RANGE_AVG_FIELDS (correct — it's a
  // whole-book snapshot count, same treatment as occ/tot/rent, so averaging autobillCount/tenantsCount
  // across the range's months is right), but nothing ever recomputed the RATE from those averaged
  // components afterward — so a multi-month range instead kept the plain arithmetic mean of each
  // month's own already-divided autobillRate, the exact average-of-averages this file's sum-then-
  // divide convention exists to avoid (harmless when denominators are similar month to month, wrong
  // when they differ). Only reachable via the custom widget builder's "Autobill Rate % (whole book)"
  // metric with a multi-month range selected — the primary Autobill Conversion tile uses a different,
  // already-correct field. Mirrors occPC's recompute directly above.
  rec.autobillRate = rec.tenantsCount ? +(rec.autobillCount / rec.tenantsCount).toFixed(4) : 0;
  rec.avgStayDays = rec.stayCount ? Math.round(rec.stayDaysSum / rec.stayCount) : 0;
  rec.areaPC = rec.claA ? +(rec.occA / rec.claA * 100).toFixed(1) : (rec.totA ? +(rec.occA / rec.totA * 100).toFixed(1) : 0);
  rec.areaPCmla = rec.totA ? +(rec.occA / rec.totA * 100).toFixed(1) : 0;
  // Economic Occupancy (task #356) — occActualRent/gpot are both in RANGE_AVG_FIELDS (already
  // correctly averaged across the range's months above), so recompute the ratio from THOSE, same
  // "never average an already-divided rate" rule as areaPC/occPC recomputes around this line.
  rec.economicOccPct = rec.gpot ? +(rec.occActualRent / rec.gpot * 100).toFixed(1) : 0;
  // REPLACED 22 Jul 2026 (task #308) — see the matching note in aggregateTotals() above / reportMap.js's rent_roll parser.
  rec.rate = rec.areaSum ? R2(rec.adjRentSum / rec.areaSum * 12) : 0;
  // REPLACED 8 Jul 2026 — True Revenue-based, divided by TOTAL area not occupied area (see
  // recordFor()'s trueRevenueNumerator comment for why areaSum/ssAreaSum would be wrong here).
  // SWITCHED 24 Jul 2026 (task #308/#404/#405) to rentTruePeriod/realRateArea — same reasoning as
  // aggregateTotals()'s matching change; rentTruePeriod/realRateArea are averaged across the range's
  // months by RANGE_AVG_FIELDS above (same snapshot-averaging rule as areaTotalAll/trueRevenueNumerator
  // used to get), so recomputing the ratio from THOSE here follows the same "never average an
  // already-divided rate" rule as areaPC/occPC just above.
  rec.realRate = rec.realRateArea ? R2(rec.rentTruePeriod / rec.realRateArea * 12) : 0;
  rec.ssRate = rec.ssAreaSum ? R2(rec.ssAdjRentSum / rec.ssAreaSum * 12) : 0;
  // SWITCHED 24 Jul 2026 (task #308 follow-up) to ssRentTruePeriod/ssRealArea — same reasoning as
  // realRate just above, Self Storage's own version (see recordFor()'s ssReal comment).
  rec.ssReal = rec.ssRealArea ? R2(rec.ssRentTruePeriod / rec.ssRealArea * 12) : 0;
  rec.ss.occPC = rec.ss.tot ? +(rec.ss.occ / rec.ss.tot * 100).toFixed(1) : 0; rec.ss.rate = rec.ssRate; rec.ss.real = rec.ssReal;
  rec.offices.occPC = rec.offices.tot ? +(rec.offices.occ / rec.offices.tot * 100).toFixed(1) : 0;
  rec.offices.rate = rec.officesAreaSum ? R2(rec.officesRentSum / rec.officesAreaSum * 12) : 0;
  rec.debtors.tenantPct = rec.occ ? +(rec.debtors.accounts / rec.occ * 100).toFixed(1) : 0;
  rec.debtors.rentRollPct = rec.occActualRent ? +(rec.debtors.total / rec.occActualRent * 100).toFixed(1) : 0;
  rec.insurance.penetration = rec.occ ? +(rec.insurance.insured / rec.occ * 100).toFixed(1) : 0;
  const custTot = rec.customerType.business.units + rec.customerType.residential.units;
  rec.customerType.business.pct = custTot ? +(rec.customerType.business.units / custTot * 100).toFixed(1) : 0;
  rec.customerType.residential.pct = custTot ? +(rec.customerType.residential.units / custTot * 100).toFixed(1) : 0;
  // moveInVarianceAvg (£avg-per-move-in) — REMOVED 21 Jul 2026 (task #360): was a leftover recompute
  // of the OLD Discounts-sourced metric this widget no longer shows (see recordFor()'s comment on the
  // MI/MO-report resourcing); moveInVarStdRatePct/ActualPct above are the correct recompute now and
  // were already being (re)computed a few lines up alongside moveInStdRateSum.
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
export async function buildPayloadRange(fromMonth, toMonth, opts = {}) {
  const includeMonthly = !!opts.includeMonthly;
  const fromStart = monthStartFromDate(fromMonth);
  const toStart = monthStartFromDate(toMonth);
  const from = ym(fromStart), to = ym(toStart);
  const realCurrentMonth = ym(reportingCurrentMonthStart());
  if (from === realCurrentMonth && to === realCurrentMonth) {
    const payload = await buildCurrentMonthPayload(toStart, reportingPreviousMonthStart(toStart));
    return {
      ...payload,
      history: includeMonthly ? buildHistory([realCurrentMonth], { [realCurrentMonth]: payload.sites || [] }) : [],
      monthly: includeMonthly ? { [realCurrentMonth]: payload.sites || [] } : {},
      range: { from: realCurrentMonth, to: realCurrentMonth, months: [realCurrentMonth] },
    };
  }
  // Only ask the DB for months this call can possibly use: the selected range, plus one extra
  // calendar month BEFORE `from`. REPURPOSED 17 Jul 2026 (task #310): that extra month used to be for
  // reservationConversions' previous-month lookback match (task #303) — gone now, recordFor() no
  // longer takes any cross-month argument at all (see its own comment). Still needed, though, for the
  // True Revenue/Rental Activity "show last complete month" restore below (added 16 Jul, independent
  // of reservationConversions): whenever the selected range is a single current in-progress month
  // (isSingleCurrentMonth below), that restore needs the month right before `from` on hand. No buffer
  // needed PAST `to` any more — nothing in this function looks forward across months at all now.
  const beforeFrom = new Date(fromStart.getFullYear(), fromStart.getMonth() - 1, 1);
  const afterTo = new Date(toStart.getFullYear(), toStart.getMonth() + 1, 1);
  const monthRange = {
    start: `${beforeFrom.getFullYear()}-${String(beforeFrom.getMonth() + 1).padStart(2, '0')}-01`,
    // Only scan THROUGH the selected `to` month itself. The previous implementation introduced an
    // unnecessary extra month past `to` (e.g. July read scanned through August) even though the
    // forward-looking reservation-conversion logic it once needed is gone; that widened the live
    // current-month read path right where we're trying to avoid Supabase timeouts.
    endExclusive: `${afterTo.getFullYear()}-${String(afterTo.getMonth() + 1).padStart(2, '0')}-01`,
  };
  const { idx, nameOf, months, latestPulledAtByMonth } = await buildIndex(monthRange);
  const requestedTo = to > realCurrentMonth ? realCurrentMonth : to;
  const visibleMonths = months.filter((mk) => mk <= realCurrentMonth);
  const rangeMonths = months.filter((mk) => mk >= from && mk <= to && mk <= realCurrentMonth);
  const latestPulledAt = rangeMonths
    .map((mk) => latestPulledAtByMonth[mk] || null)
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || null;
  if (!rangeMonths.length) {
    return { generated_at: latestPulledAt, current_month: requestedTo, prev_month: null, months: rangeMonths, sites: [], totals: null, history: [], monthly: {}, range: { from, to: requestedTo, months: rangeMonths } };
  }
  const autobillDailyMap = await fetchAutobillDailyMap(monthRange);

  // REVERTED 7 Jul 2026 (Michael): the current in-progress month now always uses its own real
  // (partial) flow-metric data here too, matching buildPayload()'s default view — no more borrowing
  // the previous complete month's numbers for Enquiries/Move-ins/Move-outs/etc. (True Revenue and
  // Rental Activity are the deliberate exception — see the restore just below `sites` is built.)

  const codes = Object.keys(NAMES);
  const firstRangeIdx = visibleMonths.indexOf(rangeMonths[0]);
  const prevDetailMonth = firstRangeIdx > 0 ? visibleMonths[firstRangeIdx - 1] : null;
  const detailMonths = includeMonthly && prevDetailMonth ? [prevDetailMonth, ...rangeMonths] : rangeMonths;
  const monthlyOut = includeMonthly ? Object.fromEntries(rangeMonths.map((mk) => [mk, []])) : null;
  const sites = codes.map((code) => {
    const recMap = {};
    for (const mk of detailMonths) {
      // Same nextMonthKey() gate as buildPayload()'s monthly loop above — only rewind `mk` when
      // it's exactly the month before the TRUE current month (realCurrentMonth), using that
      // month's own bundle from the wider (unfiltered-by-range) idx.
      const rec = recordFor(code, nameOf[code] || NAMES[code] || code, (idx[code] && idx[code][mk]) || {}, true, mk === realCurrentMonth, nextMonthKey(mk) === realCurrentMonth ? (idx[code] && idx[code][realCurrentMonth]) : null);
      applyAutobillDailyAverage(rec, mk, autobillDailyMap);
      recMap[mk] = rec;
    }
    for (let i = 1; i < detailMonths.length; i++) {
      const mk = detailMonths[i];
      const pm = detailMonths[i - 1];
      const r = recMap[mk];
      const p = recMap[pm];
      if (!r || !p) continue;
      r.occD = +(r.occPC - p.occPC).toFixed(1);
      r.rentD = r.rent - p.rent;
      r.areaD = r.occA - p.occA;
    }
    if (includeMonthly) {
      for (const mk of rangeMonths) {
        monthlyOut[mk].push(recMap[mk]);
      }
    }
    return mergeSiteAcrossRange(rangeMonths.map((mk) => recMap[mk]));
  });
  // RESTORED 16 Jul 2026 — same True Revenue/Rental Activity fix as buildPayload()'s default path
  // (see its matching comment for the full root-cause explanation). Scoped narrowly to a SINGLE
  // selected month that is ALSO the current in-progress month — an explicitly-selected PAST month
  // already has its own correct, complete data and needs no substitution, and a genuine multi-month
  // range's partial final month is a different, accepted characteristic of ranges.
  // BUG FIX 17 Jul 2026 (full-portal review): this used to compare `rangeMonths[0]` against
  // `months[months.length - 1]`, on the claim that the latter "is always [the] current in-progress
  // month, since pull.js only ever re-pulls the current month." That's true for buildPayload()'s own
  // unscoped index, but NOT here — `months` in this function comes from buildIndex(monthRange), whose
  // window is intentionally capped at `afterTo` (exactly one month past `to`, see above), so `months`
  // can structurally never contain anything later than `to`. That means `months[months.length-1]`
  // always equals `to` itself (whenever `to` has data at all) — making this check true for EVERY
  // single-month selection, not just the genuine current month. Net effect: selecting any single,
  // fully-closed PAST month (e.g. March, viewed in July) silently overwrote that site's True Revenue
  // and Rental Activity tables with the PRIOR month's data (February's), mislabeled as March's, with
  // no visual indication anything was substituted. Fix: compare `to` against today's REAL calendar
  // month (same firstOfMonth(now) convention pull.js itself uses to decide what "current" means),
  // completely independent of whatever this call's own locally-scoped month window happens to hold.
  const isSingleCurrentMonth = rangeMonths.length === 1 && rangeMonths[0] === realCurrentMonth;
  if (isSingleCurrentMonth) {
    const prevMk = months[months.length - 2];
    if (prevMk) {
      for (const s of sites) {
        const prevRaw = idx[s.code] && idx[s.code][prevMk];
        if (!prevRaw) continue;
        const p = recordFor(s.code, s.name, prevRaw, false);
        s.trueRevenueByDesc = p.trueRevenueByDesc || [];
        s.trueRevenueByType = p.trueRevenueByType || [];
        s.rentalActivityByTypeSize = p.rentalActivityByTypeSize || [];
      }
    }
  }
  // SORTED BY SITE CODE 8 Jul 2026 (Michael: "organize each widget by store, bicester should be first
  // l001 and abington should be last l029, this includes the filter at the top") — was sorted by
  // occPC descending, which made every per-site table AND the top store-filter dropdown (built
  // straight off this same sites[] array in app/portal-v2/page.js's storeOptions) reorder themselves
  // every time occupancy changed, with no stable/predictable position for any given store. Codes are
  // consistently "L" + 3 digits (L001..L029) so a plain string compare sorts them numerically too.
  sites.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
  if (includeMonthly) {
    for (const mk of Object.keys(monthlyOut)) {
      monthlyOut[mk].sort((a, b) => (a.code || '').localeCompare(b.code || ''));
    }
  }

  const totals = aggregateTotals(sites);
  return {
    build_version: PORTAL_PAYLOAD_BUILD_VERSION,
    generated_at: timestampIso(latestPulledAt),
    current_month: rangeMonths[rangeMonths.length - 1],
    prev_month: rangeMonths.length >= 2 ? rangeMonths[rangeMonths.length - 2] : null,
    months: rangeMonths,
    sites,
    totals,
    history: includeMonthly ? buildHistory(rangeMonths, monthlyOut) : [],
    monthly: includeMonthly ? monthlyOut : {},
    range: { from, to: requestedTo, months: rangeMonths },
  };
}
