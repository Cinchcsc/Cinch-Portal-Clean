// PROBE (23 Jul 2026), task #308/#403 — Michael, asked directly which "Rent" R6 meant (RentRoll's
// billing-adjusted dcRent, vs True Revenue's "Rent" TruePeriod), said: "im not sure, try them both."
// This runs BOTH bases side by side, same 25 legacy June targets, same occupied-area denominator for
// both (so any difference is purely the numerator choice, not a confounded area methodology change):
//
//   VARIANT 1 (R6's literal words, probe-r6-rate-formula.js, 22 Jul): RentRoll's dcRent, billing-
//   adjusted (x1.0833 for 28-day-billed tenants, else x1) — same basis as the already-live "Rate"
//   widget. Tested 3 ways: alone, minus FinancialSummary Credit, minus Credit AND Discounts (excl.
//   Non-Expiring) — R6's full literal spec subtracts both.
//     - billing_frequency (custom report 999824) isn't backfilled for June, so this uses TODAY's live
//       billing-frequency call joined by LedgerID against June's FROZEN dcRent (Supabase raw_report,
//       already-stored, not re-derived) — small disclosed risk if any tenant's cycle changed since June,
//       accepted as the only way to test this at all for a closed month right now.
//     - dcRent/area come from the FROZEN June rent_roll snapshot already in Supabase, NOT a fresh live
//       RentRoll call — RentRoll only ever reflects current state regardless of requested date range
//       (confirmed earlier this project), so a live call for a "June" figure would silently be wrong.
//
//   VARIANT 2 (what today's earlier Credits probes actually tested): True Revenue's "Rent" ChargeDesc
//   TruePeriod (custom report 781861), live call scoped to June — already established as reliable for
//   a closed month. Tested 2 ways: alone, minus Credit (Discounts already tested and rejected for this
//   basis on 22 Jul — probe-realrate-rewind-plus-discounts.js, worse in all 4 months tried).
//
// Both variants use the SAME occupied area (Σ Area where bRented, from the frozen June rent_roll) as
// the denominator — Rate/Real Rate's established convention (realrate_rentroll.py, reportMap.js).
//
// Run:  node --env-file=.env scripts/probe-realrate-rentroll-vs-truerevenue-basis.js
import { callReport, callCustomReport, extractNamedTable, extractRows } from '../lib/sitelink.js';
import { admin } from '../lib/supabaseAdmin.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const str = (v) => String(v ?? '').trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());

function allTables(raw) {
  if (!raw) return {};
  let diff = null;
  (function find(node) {
    if (!node || typeof node !== 'object' || diff) return;
    for (const [k, v] of Object.entries(node)) {
      if (diff) return;
      if (/diffgram/i.test(k) && v && typeof v === 'object') { diff = v; return; }
      if (v && typeof v === 'object') find(v);
    }
  })(raw);
  const scope = diff || raw;
  const tables = {};
  const seen = new Set();
  (function walk(node, path) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') tables[`${path}${path ? '.' : ''}${k}`] = v;
      else if (v && typeof v === 'object') walk(v, `${path}${path ? '.' : ''}${k}`);
    }
  })(scope, '');
  return tables;
}
function flattenRow(r) {
  if (r && typeof r === 'object' && r.attributes && typeof r.attributes === 'object') {
    const { attributes, ...rest } = r; return { ...attributes, ...rest };
  }
  return r;
}
function findTable(raw, nameSuffix) {
  const tables = allTables(raw);
  const key = Object.keys(tables).find((k) => k.toLowerCase().endsWith(nameSuffix.toLowerCase()));
  return key ? tables[key].map(flattenRow) : [];
}

const JUNE_KEY = '2026-06-01';
const juneStart = new Date(2026, 5, 1), juneEnd = new Date(2026, 5, 30);

// --- Frozen June rent_roll (Supabase) — occupied area + per-ledger dcRent, NOT a live RentRoll call ---
async function frozenJuneRentRoll(site) {
  const { data, error } = await admin.from('raw_report').select('raw_response')
    .eq('site_code', site).eq('month', JUNE_KEY).eq('report', 'rent_roll').limit(1);
  if (error || !data?.length || !data[0].raw_response) return null;
  let raw = data[0].raw_response;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return null; } }
  // extractRows() (keep-the-largest-table) is the established extractor for RentRoll — a single-
  // table report, unlike custom report 781861 (True Revenue), which genuinely needs extractNamedTable
  // to avoid grabbing the wrong one of its 3 tables. Same pattern as
  // probe-realrate-truerevenue-rent-exact.js's frozen-June-rent_roll read.
  const rows = extractRows(raw);
  let occArea = 0;
  const byLedger = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const a = num(r.Area ?? r.Area1);
    if (!yes(r.bRented)) continue;
    occArea += a;
    byLedger.push({ ledgerId: str(r.LedgerID), rent: num(r.dcRent) });
  }
  return { occArea: R2(occArea), byLedger };
}

// --- TODAY's live billing frequency, joined by LedgerID (June isn't backfilled — see header note) ---
async function billingFrequencyByLedger(site) {
  const now = new Date();
  const { raw } = await callCustomReport(999824, site, new Date(now.getFullYear(), now.getMonth(), 1), now);
  // reportMap.js's own billing_frequency parser comment: "single small flat table, no multi-table
  // extraction needed" — extractRows() (keep-the-largest-table), not extractNamedTable(), matching that.
  const rows = extractRows(raw);
  const m = {};
  for (const r of rows) { const id = str(r.LedgerID); if (id) m[id] = str(r.sBillingFreqDesc); }
  return m;
}

async function trueRevenueRent(site) {
  const { raw } = await callCustomReport(781861, site, juneStart, juneEnd);
  const rows = extractNamedTable(raw, 'Table1');
  let total = 0;
  for (const r of rows) { if (str(r.ChargeDesc).toLowerCase() === 'rent') total += num(r.TruePeriod); }
  return R2(total);
}

async function rentCreditFromFinancialSummary(site) {
  const { raw } = await callReport('FinancialSummary', site, juneStart, juneEnd);
  const chargeRows = findTable(raw, '.Charge');
  const rentRow = chargeRows.find((r) => str(r.sChgDesc).toLowerCase() === 'rent' || str(r.sChgCategory).toLowerCase() === 'rent');
  return rentRow ? num(rentRow.Credit) : 0;
}

async function discountsExclNonExpiring(site) {
  const { rows } = await callReport('Discounts', site, juneStart, juneEnd);
  let total = 0;
  for (const r of rows) {
    const plan = str(r.sConcessionPlan);
    if (/non.?exp/i.test(plan)) continue;
    total += num(r.dcDiscount);
  }
  return R2(total);
}

const SITES = {
  L001: ['Bicester', 26.39], L002: ['Leighton Buzzard', 31.24], L003: ['Letchworth', 28.69],
  L004: ['Chippenham', 28.85], L005: ['Brighton', 25.29], L006: ['Huntingdon', 16.64],
  L007: ['Newmarket', 21.49], L008: ['Enfield', 18.39], L009: ['Newbury', 21.63],
  L010: ['Mitcham', 32.99], L011: ['Sittingbourne', 28.05], L012: ['Gillingham', 30.01],
  L013: ['Brentwood', 20.40], L014: ['Earlsfield', 26.65], L015: ['Watford', 20.02],
  L016: ['Seaford', 17.91], L017: ['Southend', 21.47], L018: ['Woking', 21.99],
  L019: ['Sidcup', 25.79], L020: ['Dunstable', 16.95], L022: ['Swindon', 16.34],
  L023: ['Wisbech', 11.36], L024: ['Newcastle', 11.02], L025: ['Shoreham-By-Sea', 9.68],
  L027: ['Exeter', 8.21],
};

const results = [];
for (const [code, [name, target]] of Object.entries(SITES)) {
  try {
    const frozen = await frozenJuneRentRoll(code);
    if (!frozen || !frozen.occArea) { console.log(`${code} ${name.padEnd(18)} SKIPPED: no frozen June rent_roll`); continue; }
    const freqByLedger = await billingFrequencyByLedger(code);
    const hasFreq = Object.keys(freqByLedger).length > 0;
    let v1Numer = 0;
    for (const u of frozen.byLedger) {
      const freqDesc = freqByLedger[u.ledgerId];
      const factor = freqDesc && /28/.test(freqDesc) ? 1.0833 : 1;
      v1Numer += u.rent * factor;
    }
    v1Numer = R2(v1Numer);
    const trueRevRent = await trueRevenueRent(code);
    const credit = await rentCreditFromFinancialSummary(code);
    const discounts = await discountsExclNonExpiring(code);
    const area = frozen.occArea;

    const rate = (n) => area ? R2(n / area * 12) : 0;
    const v1a = rate(v1Numer), v1b = rate(v1Numer - credit), v1c = rate(v1Numer - credit - discounts);
    const v2a = rate(trueRevRent), v2b = rate(trueRevRent - credit);

    results.push({ code, name, target, area, hasFreq, v1a, v1b, v1c, v2a, v2b });
    console.log(`${code} ${name.padEnd(18)} target=£${target.toFixed(2)} area=${area.toFixed(0)} freq=${hasFreq ? 'y' : 'NO'}  |  V1-alone=£${v1a.toFixed(2)} V1-Credit=£${v1b.toFixed(2)} V1-Credit-Disc=£${v1c.toFixed(2)}  |  V2-alone=£${v2a.toFixed(2)} V2-Credit=£${v2b.toFixed(2)}`);
  } catch (e) {
    console.log(`${code} ${name.padEnd(18)} FAILED: ${e.message}`);
  }
}

function stats(key) {
  const gaps = results.map((r) => R2(r[key] - r.target));
  const abs = gaps.map(Math.abs);
  const ratios = results.map((r) => r[key] ? R2(r.target / r[key]) : 0);
  return {
    avgAbs: R2(abs.reduce((a, b) => a + b, 0) / abs.length),
    avgSigned: R2(gaps.reduce((a, b) => a + b, 0) / gaps.length),
    within25p: abs.filter((g) => g < 0.25).length,
    within1: abs.filter((g) => g < 1).length,
    avgRatio: R2(ratios.reduce((a, b) => a + b, 0) / ratios.length),
    ratioSpread: R2(Math.max(...ratios) - Math.min(...ratios)),
    n: results.length,
  };
}

console.log(`\n${'='.repeat(110)}`);
console.log(`Sites: ${results.length}/${Object.keys(SITES).length}   (freq join coverage: ${results.filter((r) => r.hasFreq).length}/${results.length})\n`);
for (const [label, key] of [
  ['VARIANT 1a  RentRoll billing-adj dcRent, ALONE            ', 'v1a'],
  ['VARIANT 1b  RentRoll billing-adj dcRent, minus Credit      ', 'v1b'],
  ['VARIANT 1c  RentRoll billing-adj dcRent, minus Credit+Disc ', 'v1c'],
  ['VARIANT 2a  True Revenue Rent TruePeriod, ALONE            ', 'v2a'],
  ['VARIANT 2b  True Revenue Rent TruePeriod, minus Credit     ', 'v2b'],
]) {
  const s = stats(key);
  console.log(`${label}: avg|gap|=£${s.avgAbs}  avg signed=£${s.avgSigned}  within25p=${s.within25p}/${s.n}  within£1=${s.within1}/${s.n}  avg ratio=${s.avgRatio}  spread=${s.ratioSpread}`);
}
console.log(`${'='.repeat(110)}`);
process.exit(0);
