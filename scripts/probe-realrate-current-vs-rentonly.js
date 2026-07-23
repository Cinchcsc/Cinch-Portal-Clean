// PROBE (23 Jul 2026), task #403 — direct continuation of "next" after Michael ran
// probe-realrate-nocredit-all-sites.js and got Rent-alone (B) beating Rent-minus-Credit (A) decisively
// on every metric, all 25 sites. Before reporting that as "the fix", checked what that probe (and the
// whole 22 Jul rentonly/bytype/rent-exact chain before it) actually tests, against what's LIVE in
// lib/buildPayload.js RIGHT NOW:
//
//   PRODUCTION TODAY (buildPayload.js, confirmed by reading the file directly):
//     trueRevenueNumerator = Sigma true_revenue.by_type[].truePeriod  <- ALL ChargeDesc values blended
//     together per UnitType (Rent + Insurance + Late Fee + Merchandise + StoreProtect + everything else)
//     denominator = rent_roll.total_area_all_units (TOTAL area incl. vacant)
//     NO Credit subtraction, NO Discounts subtraction (dropped 8 Jul; re-confirmed 16:06 22 Jul).
//
//   WHAT THE CREDITS PROBE (AND its whole lineage: probe-truerevenue-rentonly.js 22 Jul 14:25,
//   probe-truerevenue-rentonly-bytype.js 22 Jul 14:29, probe-realrate-truerevenue-rent-exact.js 22 Jul
//   16:14, probe-realrate-all-sites-june.js 22 Jul 17:50, probe-realrate-nocredit-all-sites.js 22 Jul
//   18:21) ACTUALLY TESTS:
//     numerator = true_revenue.by_desc[] filtered to ChargeDesc === 'rent' ONLY  <- excludes every
//     other charge type entirely
//     (some variants also subtract a Credit figure; the just-run probe shows NOT subtracting it wins)
//
// So "should Credit be subtracted" was never really the live question — Credit subtraction ISN'T
// currently happening in production either way. The real, bigger question the whole 22 Jul session was
// actually chasing is: should the numerator itself switch from "all charge types" (by_type, live today)
// to "Rent only" (by_desc, tested all day, not yet wired anywhere). This directly compares BOTH against
// the SAME 25 legacy June targets Michael read off the dashboard 22 Jul (probe-realrate-all-sites-
// june.js's SITES list), using 100% already-stored frozen June data (raw_report.data for true_revenue +
// rent_roll — the exact pre-parsed by_type/by_desc/total_area_all_units fields buildPayload.js itself
// reads, not a reparse of raw XML) — zero live SiteLink calls, so this is safe to run any time.
//
// NOTE: by_desc doesn't split by UnitType, so this can only test the TOTAL Real Rate, not Self Storage
// (a Rent-only-by-UnitType breakdown would need a new grouping in reportMap.js's true_revenue parser —
// not added yet, deliberately, until Total is confirmed worth doing).
//
// Run:  node --env-file=.env scripts/probe-realrate-current-vs-rentonly.js
import { admin } from '../lib/supabaseAdmin.js';

const JUNE_KEY = '2026-06-01';
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Same 25 sites/targets as probe-realrate-all-sites-june.js, read directly off legacy's own Dashboard
// "REAL RATE PER FT²" widget, 22 Jul 2026 (Total column only, used here).
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
const codes = Object.keys(SITES);

const { data: trRows, error: trErr } = await admin
  .from('raw_report').select('site_code,data')
  .eq('month', JUNE_KEY).eq('report', 'true_revenue').in('site_code', codes);
if (trErr) { console.error('true_revenue fetch failed:', trErr.message); process.exit(1); }

const { data: rrRows, error: rrErr } = await admin
  .from('raw_report').select('site_code,data')
  .eq('month', JUNE_KEY).eq('report', 'rent_roll').in('site_code', codes);
if (rrErr) { console.error('rent_roll fetch failed:', rrErr.message); process.exit(1); }

const parseD = (d) => (typeof d === 'string' ? (() => { try { return JSON.parse(d); } catch { return null; } })() : d);
const trBySite = Object.fromEntries((trRows || []).map((r) => [r.site_code, parseD(r.data)]));
const rrBySite = Object.fromEntries((rrRows || []).map((r) => [r.site_code, parseD(r.data)]));

const results = [];
console.log(`${'Site'.padEnd(6)} ${'Name'.padEnd(18)} ${'Target'.padStart(8)}  ${'CURRENT(by_type)'.padStart(18)}  ${'gap'.padStart(8)}  ${'PROPOSED(rent-only)'.padStart(20)}  ${'gap'.padStart(8)}`);
for (const code of codes) {
  const [name, target] = SITES[code];
  const tr = trBySite[code], rr = rrBySite[code];
  if (!tr || !rr) { console.log(`${code.padEnd(6)} ${name.padEnd(18)} MISSING DATA (tr=${!!tr} rr=${!!rr}) — skipped`); continue; }
  const totalArea = rr.total_area_all_units || 0;
  if (!totalArea) { console.log(`${code.padEnd(6)} ${name.padEnd(18)} totalArea=0 — skipped`); continue; }

  // CURRENT PRODUCTION (buildPayload.js today): Sigma by_type[].truePeriod, ALL charge types blended.
  const currentNumer = (tr.by_type || []).reduce((a, r) => a + (r.truePeriod || 0), 0);
  const currentRate = R2(currentNumer / totalArea * 12);
  const currentGap = R2(currentRate - target);

  // PROPOSED: by_desc row(s) matching ChargeDesc === 'rent' (case-insensitive, raw-label exact match).
  const rentRow = (tr.by_desc || []).filter((r) => String(r.desc || '').trim().toLowerCase() === 'rent');
  const rentNumer = rentRow.reduce((a, r) => a + (r.truePeriod || 0), 0);
  const rentRate = R2(rentNumer / totalArea * 12);
  const rentGap = R2(rentRate - target);

  results.push({ code, name, target, currentRate, currentGap, rentRate, rentGap });
  console.log(`${code.padEnd(6)} ${name.padEnd(18)} £${target.toFixed(2).padStart(7)}  £${currentRate.toFixed(2).padStart(17)}  £${currentGap.toFixed(2).padStart(7)}  £${rentRate.toFixed(2).padStart(19)}  £${rentGap.toFixed(2).padStart(7)}`);
}

function stats(key) {
  const gaps = results.map((r) => r[key]);
  const abs = gaps.map(Math.abs);
  const avgAbs = R2(abs.reduce((a, b) => a + b, 0) / abs.length);
  const avgSigned = R2(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  const within1 = abs.filter((g) => g < 1).length, within3 = abs.filter((g) => g < 3).length, within5 = abs.filter((g) => g < 5).length;
  const ratios = results.map((r) => r[key === 'currentGap' ? 'currentRate' : 'rentRate'] / r.target);
  const avgRatio = R2(ratios.reduce((a, b) => a + b, 0) / ratios.length);
  const ratioSpread = R2(Math.max(...ratios) - Math.min(...ratios));
  return { avgAbs, avgSigned, within1, within3, within5, avgRatio, ratioSpread, n: results.length };
}

console.log(`\n${'='.repeat(100)}`);
console.log(`Sites compared: ${results.length}/${codes.length}\n`);
const cur = stats('currentGap'), prop = stats('rentGap');
console.log(`CURRENT PRODUCTION (by_type, all charge types, live in buildPayload.js today):`);
console.log(`  avg|gap| £${cur.avgAbs}   avg signed gap £${cur.avgSigned}   within £1: ${cur.within1}/${cur.n}   within £3: ${cur.within3}/${cur.n}   within £5: ${cur.within5}/${cur.n}   avg ratio ${cur.avgRatio}   ratio spread ${cur.ratioSpread}`);
console.log(`\nPROPOSED (by_desc, Rent-only, tested all day 22 Jul + in the just-run Credits probe, not wired anywhere yet):`);
console.log(`  avg|gap| £${prop.avgAbs}   avg signed gap £${prop.avgSigned}   within £1: ${prop.within1}/${prop.n}   within £3: ${prop.within3}/${prop.n}   within £5: ${prop.within5}/${prop.n}   avg ratio ${prop.avgRatio}   ratio spread ${prop.ratioSpread}`);
console.log(`${'='.repeat(100)}`);
process.exit(0);
