// PROBE (23 Jul 2026), task #308 — follow-up to probe-realrate-rentroll-vs-truerevenue-basis.js.
// That probe found True Revenue's "Rent" TruePeriod ALONE (no Credit/Discount subtraction) is the
// best-performing candidate across all 25 sites (avg gap £0.78, 18/25 within £1) — but 7 sites still
// miss by >£1 (Chippenham -1.59, Swindon -1.39, Exeter -1.29, Sidcup -1.21, Brighton -1.19,
// Sittingbourne -1.05, Enfield +1.05), and at 3 of the smallest sites (Newcastle/Shoreham/Exeter) the
// RentRoll-based candidate (dcRent minus Credit minus Discounts) actually tracks the legacy target
// MORE closely than True Revenue does — Exeter hits an EXACT match on RentRoll, but True Revenue
// misses by £1.29 there. Michael asked to dig into why before deciding whether to ship either formula
// for tomorrow's cutover (task #173).
//
// Since both variants already share the SAME occupied-area denominator (ruled out as a confound by
// the prior probe's own design), any gap has to live in the NUMERATOR — either (a) True Revenue's
// strict ChargeDesc==='rent' filter is missing some OTHER rent-like charge line at certain sites
// (e.g. Parking/Vehicle/Outside Storage billed under a different ChargeDesc), or (b) a genuine
// accrual-vs-snapshot difference (True Revenue = actual June recognition; RentRoll dcRent = TODAY's
// live contracted rate) that happens to matter more/less per site depending on how much mid-period
// rate-change or move activity occurred. This probe surfaces the raw numerator-level facts needed to
// tell those apart, for all 25 sites (not just the 3 flagged) so the pattern isn't presumed to be
// purely a "small site" effect just because that's where it was first noticed.
//
// For each site, prints:
//   - Total June TruePeriod across ALL ChargeDescs, vs "Rent"-only TruePeriod, and the ratio between
//     them (a low ratio = other charge types are a bigger share of revenue there than typical).
//   - The next 3 largest non-Rent ChargeDescs by TruePeriod (so a rent-like line hiding under another
//     label would show up directly, if one exists).
//   - RentRoll unit-type mix (count/area/dcRent by sTypeName) vs True Revenue's Rent-only TruePeriod
//     by UnitType — same grouping key, side by side, to catch a categorization mismatch (e.g. Parking
//     units whose RentRoll dcRent is real but whose True Revenue charge lands under a non-"Rent" desc).
//   - The raw £ RentRoll billing-adjusted dcRent sum vs raw £ True Revenue "Rent" TruePeriod sum
//     (pre-division, so the actual revenue-recognition gap in cash terms is visible, not just per-sqft).
//
// Run:  node --env-file=.env scripts/probe-realrate-basis-gap-diagnosis.js
import { callReport, callCustomReport, extractNamedTable, extractRows } from '../lib/sitelink.js';
import { admin } from '../lib/supabaseAdmin.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const str = (v) => String(v ?? '').trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());

const JUNE_KEY = '2026-06-01';
const juneStart = new Date(2026, 5, 1), juneEnd = new Date(2026, 5, 30);

async function frozenJuneRentRoll(site) {
  const { data, error } = await admin.from('raw_report').select('raw_response')
    .eq('site_code', site).eq('month', JUNE_KEY).eq('report', 'rent_roll').limit(1);
  if (error || !data?.length || !data[0].raw_response) return null;
  let raw = data[0].raw_response;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return null; } }
  const rows = extractRows(raw);
  let occArea = 0;
  const byLedger = [];
  const byType = {}; // sTypeName -> {n, area, rent}
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!yes(r.bRented)) continue;
    const a = num(r.Area ?? r.Area1), rent = num(r.dcRent), type = str(r.sTypeName) || '(blank)';
    occArea += a;
    byLedger.push({ ledgerId: str(r.LedgerID), rent, type });
    if (!byType[type]) byType[type] = { n: 0, area: 0, rent: 0 };
    byType[type].n++; byType[type].area += a; byType[type].rent += rent;
  }
  return { occArea: R2(occArea), byLedger, byType };
}

async function billingFrequencyByLedger(site) {
  const now = new Date();
  const { raw } = await callCustomReport(999824, site, new Date(now.getFullYear(), now.getMonth(), 1), now);
  const rows = extractRows(raw);
  const m = {};
  for (const r of rows) { const id = str(r.LedgerID); if (id) m[id] = str(r.sBillingFreqDesc); }
  return m;
}

// Now pulls the FULL Table1 (every ChargeDesc x UnitType row), not just the "Rent" filter, so we can
// see everything else revenue-wise at each site.
async function trueRevenueFull(site) {
  const { raw } = await callCustomReport(781861, site, juneStart, juneEnd);
  const rows = extractNamedTable(raw, 'Table1');
  let totalAll = 0, totalRent = 0;
  const byDesc = {}; // ChargeDesc -> TruePeriod sum, ALL descs
  const rentByType = {}; // UnitType -> TruePeriod sum, ChargeDesc==='rent' only
  for (const r of rows) {
    const desc = str(r.ChargeDesc), type = str(r.UnitType) || '(blank)', v = num(r.TruePeriod);
    totalAll += v;
    byDesc[desc] = (byDesc[desc] || 0) + v;
    if (desc.toLowerCase() === 'rent') { totalRent += v; rentByType[type] = (rentByType[type] || 0) + v; }
  }
  return { totalAll: R2(totalAll), totalRent: R2(totalRent), byDesc, rentByType };
}

async function rentCreditFromFinancialSummary(site) {
  const { raw } = await callReport('FinancialSummary', site, juneStart, juneEnd);
  function allTables(r) {
    if (!r) return {};
    let diff = null;
    (function find(node) { if (!node || typeof node !== 'object' || diff) return;
      for (const [k, v] of Object.entries(node)) { if (diff) return;
        if (/diffgram/i.test(k) && v && typeof v === 'object') { diff = v; return; }
        if (v && typeof v === 'object') find(v); } })(r);
    const scope = diff || r; const tables = {}; const seen = new Set();
    (function walk(node, path) { if (!node || typeof node !== 'object' || seen.has(node)) return; seen.add(node);
      for (const [k, v] of Object.entries(node)) {
        if (Array.isArray(v) && v.length && typeof v[0] === 'object') tables[`${path}${path ? '.' : ''}${k}`] = v;
        else if (v && typeof v === 'object') walk(v, `${path}${path ? '.' : ''}${k}`); } })(scope, '');
    return tables;
  }
  const flat = (r) => (r?.attributes ? { ...r.attributes, ...r } : r);
  const tables = allTables(raw);
  const key = Object.keys(tables).find((k) => k.toLowerCase().endsWith('.charge'));
  const chargeRows = key ? tables[key].map(flat) : [];
  const rentRow = chargeRows.find((r) => str(r.sChgDesc).toLowerCase() === 'rent' || str(r.sChgCategory).toLowerCase() === 'rent');
  return rentRow ? num(rentRow.Credit) : 0;
}

async function discountsExclNonExpiring(site) {
  const { rows } = await callReport('Discounts', site, juneStart, juneEnd);
  let total = 0;
  for (const r of rows) { if (/non.?exp/i.test(str(r.sConcessionPlan))) continue; total += num(r.dcDiscount); }
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
    let v1Numer = 0;
    for (const u of frozen.byLedger) {
      const freqDesc = freqByLedger[u.ledgerId];
      const factor = freqDesc && /28/.test(freqDesc) ? 1.0833 : 1;
      v1Numer += u.rent * factor;
    }
    v1Numer = R2(v1Numer);
    const tr = await trueRevenueFull(code);
    const credit = await rentCreditFromFinancialSummary(code);
    const discounts = await discountsExclNonExpiring(code);
    const area = frozen.occArea;
    const rate = (n) => area ? R2(n / area * 12) : 0;

    const v1c = rate(v1Numer - credit - discounts);
    const v2a = rate(tr.totalRent);
    const rentShare = tr.totalAll ? R2(tr.totalRent / tr.totalAll * 100) : 0;
    const otherDescs = Object.entries(tr.byDesc).filter(([d]) => d.toLowerCase() !== 'rent')
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d, v]) => `${d}=£${R2(v)}`).join(', ');

    results.push({ code, name, target, v1c, v2a, rentShare, v1Numer, trTotalRent: tr.totalRent, credit, discounts });
    console.log(`\n${code} ${name} — target=£${target.toFixed(2)}  V1c=£${v1c.toFixed(2)} (gap ${R2(v1c - target)})  V2a=£${v2a.toFixed(2)} (gap ${R2(v2a - target)})`);
    console.log(`  Rent-share of total True Revenue: ${rentShare}% (£${tr.totalRent} of £${tr.totalAll})`);
    console.log(`  Next-largest non-Rent charges: ${otherDescs || '(none)'}`);
    console.log(`  Raw £: RentRoll billing-adj dcRent=£${v1Numer}  True Revenue Rent TruePeriod=£${tr.totalRent}  diff=£${R2(v1Numer - tr.totalRent)}  Credit=£${credit}  Discounts=£${discounts}`);
    console.log(`  RentRoll unit-type mix (count/area/dcRent): ${Object.entries(frozen.byType).map(([t, s]) => `${t}=${s.n}/${R2(s.area)}sqft/£${R2(s.rent)}`).join('; ')}`);
    console.log(`  True Revenue "Rent" TruePeriod by UnitType: ${Object.entries(tr.rentByType).map(([t, v]) => `${t}=£${R2(v)}`).join('; ') || '(none)'}`);
  } catch (e) {
    console.log(`${code} ${name.padEnd(18)} FAILED: ${e.message}`);
  }
}

console.log(`\n${'='.repeat(100)}`);
console.log('SUMMARY — sites where V2a (True Revenue Rent alone) misses target by >£1, with rent-share for context:');
for (const r of results) {
  if (Math.abs(R2(r.v2a - r.target)) > 1) {
    console.log(`  ${r.code} ${r.name}: target=£${r.target.toFixed(2)} V2a=£${r.v2a.toFixed(2)} gap=${R2(r.v2a - r.target)}  rent-share=${r.rentShare}%  V1c=£${r.v1c.toFixed(2)} (gap ${R2(r.v1c - r.target)})`);
  }
}
console.log('\nAll 25 sites, rent-share sorted ascending (lowest rent-share first -- if low rent-share correlates with V2a undershoot, that IDs the mechanism):');
for (const r of [...results].sort((a, b) => a.rentShare - b.rentShare)) {
  console.log(`  ${r.code} ${r.name.padEnd(18)} rent-share=${r.rentShare}%  V2a gap=${R2(r.v2a - r.target)}  V1c gap=${R2(r.v1c - r.target)}`);
}
console.log('='.repeat(100));
process.exit(0);
