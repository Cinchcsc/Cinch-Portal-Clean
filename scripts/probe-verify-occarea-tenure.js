// Verifies two "conflict" flags raised against Michael's uploaded KPI Widget Reference doc
// (3 Jul 2026), before assuming our implementation is wrong:
//   (1) "Occupied Area %" (single number) — doc says this comes DIRECTLY from ManagementSummary's
//       Rental Activity section (a pre-computed field), not derived from Occupancy Statistics sums
//       like our areaPC currently is. This dumps EVERY labelled row ManagementSummary returns
//       (lib/reportMap.js's management parser already buckets rows by sDesc) so we can see if a
//       ready-made "Occupied Area %"-type row exists, and what value it holds vs our own areaPC calc.
//   (2) "Customer Insight" / Average Tenure — doc says this is TWO DAY-COUNTS (Avg Tenure all
//       tenants vs Avg Tenure occupied-only) sourced from MarketingSummary's Tenancy section — a
//       different report AND a different concept than the "Avg Customer Value" (£) tile we built
//       from a legacy tooltip screenshot. This dumps every column on MarketingSummary's raw rows to
//       check whether a tenancy-day-count field actually exists there.
// PII-SAFE: prints labelled aggregate figures and column names only.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-verify-occarea-tenure.js
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);
const str = (v) => (v ?? '').toString().trim();

console.log(`site ${loc} · last complete month ${start.toISOString().slice(0, 10)} -> ${end.toISOString().slice(0, 10)}\n`);

console.log('=== (1) ManagementSummary — every labelled row (sDesc), for Occupied Area % check ===');
try {
  const { rows: mgRows } = await callReport('ManagementSummary', loc, start, end);
  for (const r of mgRows) {
    const desc = str(r.sDesc);
    if (!desc) continue;
    console.log(`  ${desc.padEnd(40)} d=${r.iDCount ?? '-'}  mo=${r.iMCount ?? '-'}  y=${r.iYCount ?? '-'}`);
  }
  const areaLike = mgRows.filter(r => /area|occup/i.test(str(r.sDesc)));
  console.log(`\n  Rows matching /area|occup/i: ${areaLike.length ? areaLike.map(r => str(r.sDesc)).join(', ') : '(none found)'}`);
} catch (e) { console.log('  error:', e.message); }

console.log('\n=== (1b) Our current areaPC calc (Occupancy Statistics-based) for comparison ===');
try {
  const { rows: occRows } = await callReport('OccupancyStatistics', loc, start, end);
  const occ = REPORTS.occupancy.parse(occRows);
  const areaPC = occ.total_area ? (occ.occupied_area / occ.total_area * 100).toFixed(1) : 'n/a';
  console.log(`  occupied_area=${occ.occupied_area}  total_area=${occ.total_area}  areaPC=${areaPC}%`);
} catch (e) { console.log('  error:', e.message); }

console.log('\n=== (2) MarketingSummary — ALL raw columns, for tenancy/Average Tenure check ===');
try {
  const { rows: mkRows } = await callReport('MarketingSummary', loc, start, end);
  if (mkRows.length) {
    const cols = Object.keys(mkRows[0]).filter(c => !/^(diffgr|msdata)/i.test(c));
    console.log('  ALL COLUMNS:', cols.join(', '));
    const tenureLike = cols.filter(c => /tenan|tenure|day/i.test(c));
    console.log(`\n  Columns matching /tenan|tenure|day/i: ${tenureLike.length ? tenureLike.join(', ') : '(none found)'}`);
    if (tenureLike.length) {
      console.log('\n  Sample values (first 3 rows):');
      for (const r of mkRows.slice(0, 3)) console.log('   ', tenureLike.map(c => `${c}=${r[c]}`).join('  '));
    }
  } else {
    console.log('  No rows returned.');
  }
} catch (e) { console.log('  error:', e.message); }

process.exit(0);
