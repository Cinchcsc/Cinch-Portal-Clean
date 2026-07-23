// PROBE (23 Jul 2026), task #308 — direct follow-up to today's basis-gap diagnosis
// (probe-realrate-basis-gap-diagnosis.js). That probe ruled out "a rent-like charge hiding under a
// different ChargeDesc" as the explanation for True Revenue's worst misses (every site's largest
// non-Rent charge is a genuine ancillary item — StoreProtect insurance, Combi Padlock, fees — and
// Parking/Office/Enterprise/Drive-Up rent is already correctly captured inside the "Rent" ChargeDesc
// filter, confirmed via the by-UnitType breakdown). Instead it found a clean, mechanistic pattern:
//
//   Discounts (excl. Non-Expiring) as a % of RentRoll's billing-adjusted dcRent varies from ~5% to
//   ~52% across sites, and this ratio predicts almost exactly where True Revenue "Rent" alone (V2a)
//   undershoots the legacy target: at the 3 worst sites (Exeter 52%, Shoreham 34%, Newcastle 31% —
//   vs 5-18% typical elsewhere), Credit+Discount together explain 84-93% of the RentRoll-vs-True-
//   Revenue numerator gap. This strongly suggests True Revenue's TruePeriod does NOT fully net out
//   that period's concessions at high-discount sites specifically.
//
// IMPORTANT — this is a genuinely NEW combination, not a repeat of an already-rejected test. The 22
// Jul probe referenced as "Discounts already tested and rejected" (probe-realrate-rewind-plus-
// discounts.js, recovered from git history to check this) tested Credit+Discounts TOGETHER, for ONE
// site across 4 months — it never isolated Discounts alone, and it stacked Discounts on top of an
// already-Credit-reduced figure rather than testing it against the untouched True Revenue "Rent"
// baseline. Separately, today's basis probe (25 sites) already showed subtracting Credit ALONE (V2b)
// is worse than subtracting nothing (V2a) — so testing Credit+Discounts together was always going to
// look bad partly because of the Credit half, independent of whatever Discounts alone would do.
//
// This tests the specific untested combination — True Revenue "Rent" TruePeriod MINUS Discounts
// (excl. Non-Expiring), Credit left OUT entirely — across all 25 sites, alongside V2a for direct
// comparison, to see whether it closes the gap at the high-discount-ratio sites without dragging down
// the sites where V2a already works well.
//
// Run:  node --env-file=.env scripts/probe-realrate-truerevenue-minus-discounts-only.js
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

async function frozenJuneOccArea(site) {
  const { data, error } = await admin.from('raw_report').select('raw_response')
    .eq('site_code', site).eq('month', JUNE_KEY).eq('report', 'rent_roll').limit(1);
  if (error || !data?.length || !data[0].raw_response) return null;
  let raw = data[0].raw_response;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return null; } }
  const rows = extractRows(raw);
  let occArea = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) { if (yes(r.bRented)) occArea += num(r.Area ?? r.Area1); }
  return R2(occArea);
}

async function trueRevenueRent(site) {
  const { raw } = await callCustomReport(781861, site, juneStart, juneEnd);
  const rows = extractNamedTable(raw, 'Table1');
  let total = 0;
  for (const r of rows) { if (str(r.ChargeDesc).toLowerCase() === 'rent') total += num(r.TruePeriod); }
  return R2(total);
}

async function discountsExclNonExpiring(site) {
  const { rows } = await callReport('Discounts', site, juneStart, juneEnd);
  let total = 0;
  for (const r of rows) {
    if (/non.?exp/i.test(str(r.sConcessionPlan))) continue;
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
    const occArea = await frozenJuneOccArea(code);
    if (!occArea) { console.log(`${code} ${name.padEnd(18)} SKIPPED: no frozen June rent_roll`); continue; }
    const trueRevRent = await trueRevenueRent(code);
    const discounts = await discountsExclNonExpiring(code);
    const rate = (n) => occArea ? R2(n / occArea * 12) : 0;

    const v2a = rate(trueRevRent);
    const v2c = rate(trueRevRent - discounts);
    const discRatio = trueRevRent ? R2(discounts / trueRevRent * 100) : 0;

    results.push({ code, name, target, v2a, v2c, discRatio });
    console.log(`${code} ${name.padEnd(18)} target=£${target.toFixed(2)}  V2a(alone)=£${v2a.toFixed(2)} (gap ${R2(v2a - target)})   V2c(minus Disc)=£${v2c.toFixed(2)} (gap ${R2(v2c - target)})   disc/rent=${discRatio}%`);
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
    within1: abs.filter((g) => g < 1).length,
    avgRatio: R2(ratios.reduce((a, b) => a + b, 0) / ratios.length),
    n: results.length,
  };
}

console.log(`\n${'='.repeat(100)}`);
console.log(`Sites: ${results.length}/${Object.keys(SITES).length}\n`);
for (const [label, key] of [['V2a  True Revenue Rent, ALONE           ', 'v2a'], ['V2c  True Revenue Rent, MINUS Discounts', 'v2c']]) {
  const s = stats(key);
  console.log(`${label}: avg|gap|=£${s.avgAbs}  avg signed=£${s.avgSigned}  within£1=${s.within1}/${s.n}  avg ratio=${s.avgRatio}`);
}
console.log(`\nPer-site: does subtracting Discounts help or hurt, sorted by discount/rent ratio (highest first)?`);
for (const r of [...results].sort((a, b) => b.discRatio - a.discRatio)) {
  const v2aGap = Math.abs(R2(r.v2a - r.target)), v2cGap = Math.abs(R2(r.v2c - r.target));
  const verdict = v2cGap < v2aGap - 0.05 ? 'HELPS' : v2cGap > v2aGap + 0.05 ? 'hurts' : 'flat';
  console.log(`  ${r.code} ${r.name.padEnd(18)} disc/rent=${r.discRatio}%  V2a gap=${R2(r.v2a - r.target)}  V2c gap=${R2(r.v2c - r.target)}  -> ${verdict}`);
}
console.log('='.repeat(100));
process.exit(0);
