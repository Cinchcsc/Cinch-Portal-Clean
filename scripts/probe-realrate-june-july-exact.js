// PROBE (22 Jul 2026), task #308/#403 — Michael: "needs to be exact... near is unacceptable." Two
// corrections since the last probe:
// 1. £18.66 IS the Total Real Rate for Bicester July 2026 (confirmed from Michael's own Real Rate per
//    ft² screenshot) -- SS is actually £19.50, a DIFFERENT figure. Earlier messages misread "ss" as
//    "self storage" when Michael meant "screenshot" (answering when it was taken), which had wrongly
//    suggested £18.66 might be the SS figure. It never was -- Total, as originally assumed.
// 2. Michael has now also supplied Bicester's June 2026 Real Rate: SS £28.02, Total £26.39 (from a
//    screenshot where June's Real Rate panel — empty in an earlier, narrower June-only screenshot — is
//    now populated). June is a FULLY CLOSED month, so its TruePeriod/area figures are final, not still
//    accumulating like July's live MTD data -- testing a formula against June removes the "maybe it's
//    just timing drift" ambiguity entirely.
//
// Getting June's area right is NOT as simple as calling RentRoll with June's date range: per lib/
// pull.js's own comment ("RentRoll/OccupancyStatistics are point-in-time snapshots, not real
// historical 'as of' reports... every pull silently re-captured TODAY's live state under June's
// label"), SiteLink's RentRoll always reflects right now regardless of what dates are passed. The only
// correct source for June's true per-unit area is the FROZEN raw_response already captured (once, while
// June was still the live month, per pull.js's "once closed, never re-pulled" rule) in Supabase's
// raw_report table -- read directly here (service-role client, SELECT only, same one buildPayload.js/
// pull.js already use for this exact table). True Revenue, by contrast, IS a genuine period report
// (confirmed via probe:true-revenue-scope, "totals scale down with narrower window") -- calling it
// fresh with June's actual date bounds correctly returns June's real historical revenue even today, no
// stored-snapshot workaround needed.
//
// For July (still the live current month), RentRoll's snapshot behavior is exactly what's wanted —
// pulled fresh, same as every other probe this session.
//
// Runs the same exhaustive per-type subset search as the last probe, against BOTH months' now-correct
// targets, side by side.
//
// Run:  node --env-file=.env scripts/probe-realrate-june-july-exact.js [siteCode]
import { callReport, callCustomReport, extractNamedTable, extractRows } from '../lib/sitelink.js';
import { admin } from '../lib/supabaseAdmin.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-realrate-june-july-exact.js <siteCode>'); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };

async function areaByTypeFromRaw(rawRentRoll) {
  const rows = extractRows(rawRentRoll);
  const areaByType = {};
  for (const r of rows) {
    const t = String(r.sTypeName || 'Other').trim();
    areaByType[t] = (areaByType[t] || 0) + num(r.Area ?? r.Area1);
  }
  return { areaByType, rowCount: rows.length };
}

async function rentOnlyByTypeFromTrueRevenue(start, end) {
  const { raw } = await callCustomReport(781861, site, start, end);
  const trRows = extractNamedTable(raw, 'Table1');
  const rentRows = trRows.filter((r) => /rent/i.test(r.ChargeDesc || ''));
  const rentByType = {};
  for (const r of rentRows) {
    const t = String(r.UnitType || 'Other').trim();
    rentByType[t] = (rentByType[t] || 0) + num(r.TruePeriod);
  }
  return { rentByType, rowCount: trRows.length, rentRowCount: rentRows.length };
}

function testCombinations(areaByType, rentByType, ssTarget, totalTarget) {
  const allTypes = new Set([...Object.keys(areaByType), ...Object.keys(rentByType)]);
  console.log('  Per-type Real Rate:');
  for (const t of allTypes) {
    const rent = rentByType[t] || 0, area = areaByType[t] || 0;
    console.log(`    ${t}: £${R2(rent)} / ${R2(area)} sqft × 12 = £${area ? R2(rent / area * 12) : 0}/sqft/yr`);
  }
  const keys = [...allTypes];
  const results = [];
  for (let mask = 1; mask < (1 << keys.length); mask++) {
    const subset = keys.filter((_, i) => mask & (1 << i));
    const rent = subset.reduce((a, k) => a + (rentByType[k] || 0), 0);
    const area = subset.reduce((a, k) => a + (areaByType[k] || 0), 0);
    const rate = area ? R2(rent / area * 12) : 0;
    results.push({ subset: subset.join('+'), rent: R2(rent), area: R2(area), rate });
  }
  console.log(`  Closest to SS target £${ssTarget}:`);
  results.slice().sort((a, b) => Math.abs(a.rate - ssTarget) - Math.abs(b.rate - ssTarget)).slice(0, 5)
    .forEach((r) => console.log(`    ${r.subset.padEnd(30)} £${r.rent} / ${r.area} = £${r.rate}   gap £${R2(r.rate - ssTarget)}${Math.abs(r.rate - ssTarget) < 0.005 ? '  <<< EXACT' : ''}`));
  console.log(`  Closest to Total target £${totalTarget}:`);
  results.slice().sort((a, b) => Math.abs(a.rate - totalTarget) - Math.abs(b.rate - totalTarget)).slice(0, 5)
    .forEach((r) => console.log(`    ${r.subset.padEnd(30)} £${r.rent} / ${r.area} = £${r.rate}   gap £${R2(r.rate - totalTarget)}${Math.abs(r.rate - totalTarget) < 0.005 ? '  <<< EXACT' : ''}`));
  // "All types" is always the literal Total figure (not just the closest-looking subset).
  const all = results.find((r) => r.subset.split('+').length === keys.length);
  console.log(`  ALL types (the true "Total"): £${all.rent} / ${all.area} = £${all.rate}   gap vs Total target £${R2(all.rate - totalTarget)}`);
}

// CLOSED_MONTHS — every past, fully-closed month to cross-check, so a match isn't just a one-month
// coincidence (Michael, 22 Jul: "cross check it for previous months that are closed as well to be
// certain"). Each entry needs its own legacy SS/Total Real Rate target (from a legacy screenshot with
// that month selected) before it's worth anything — add a row here once that screenshot exists. Only
// June is populated so far; still runs even with just one, but the whole point is accumulating more.
const CLOSED_MONTHS = [
  { label: '2026-06-01', monthIdx: 5, ssTarget: 28.02, totalTarget: 26.39 },   // June 2026
  // { label: '2026-05-01', monthIdx: 4, ssTarget: ..., totalTarget: ... },   // May 2026 — add once screenshotted
  // { label: '2026-04-01', monthIdx: 3, ssTarget: ..., totalTarget: ... },   // April 2026 — add once screenshotted
];

for (const { label, monthIdx, ssTarget, totalTarget } of CLOSED_MONTHS) {
  console.log(`${'='.repeat(70)}\n${label} (closed month — frozen area from Supabase, live True Revenue query)\n${'='.repeat(70)}`);
  const { data: rows, error } = await admin.from('raw_report').select('raw_response').eq('site_code', site).eq('month', label).eq('report', 'rent_roll').limit(1);
  if (error) { console.error('Supabase error:', error.message); continue; }
  if (!rows || !rows.length || !rows[0].raw_response) { console.log(`No frozen ${label} rent_roll raw_response found in Supabase for this site — cannot test this month.`); continue; }
  const { areaByType, rowCount } = await areaByTypeFromRaw(rows[0].raw_response);
  console.log(`Frozen ${label} rent_roll: ${rowCount} row(s). Area by type:`, JSON.stringify(areaByType));
  const mStart = new Date(2026, monthIdx, 1), mEnd = new Date(2026, monthIdx + 1, 0);
  const { rentByType, rowCount: trRowCount, rentRowCount } = await rentOnlyByTypeFromTrueRevenue(mStart, mEnd);
  console.log(`${label} True Revenue Table1: ${trRowCount} row(s), ${rentRowCount} Rent-only. Rent by type:`, JSON.stringify(rentByType));
  testCombinations(areaByType, rentByType, ssTarget, totalTarget);
  console.log('');
}

console.log(`\n${'='.repeat(70)}\nJULY 2026 (current month — live RentRoll + live True Revenue, both fresh)\n${'='.repeat(70)}`);
{
  const now = new Date();
  const julStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const { rows: rrRows } = await callReport('RentRoll', site, julStart, now);
  const areaByType = {};
  for (const r of rrRows) { const t = String(r.sTypeName || 'Other').trim(); areaByType[t] = (areaByType[t] || 0) + num(r.Area ?? r.Area1); }
  console.log(`Live July RentRoll: ${rrRows.length} row(s). Area by type:`, JSON.stringify(areaByType));
  const { rentByType, rowCount: trRowCount, rentRowCount } = await rentOnlyByTypeFromTrueRevenue(julStart, now);
  console.log(`July True Revenue Table1: ${trRowCount} row(s), ${rentRowCount} Rent-only. Rent by type:`, JSON.stringify(rentByType));
  testCombinations(areaByType, rentByType, 19.50, 18.66);
}
process.exit(0);
