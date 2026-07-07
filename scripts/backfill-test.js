// Tests whether SiteLink returns HISTORICAL occupancy for past months (the make-or-break for a
// backfill). Pulls OccupancyStatistics for the first location for each of the last 6 complete
// months and prints occ/area/rent. If they change month-to-month, historical backfill works.
// Run:  npm run backfill:test
import { callReport } from '../lib/sitelink.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const now = new Date();

console.log(`Testing historical occupancy for ${loc} — last 6 complete months:\n`);
console.log('month     occ/tot      occArea   rent(actual)');
console.log('--------------------------------------------------');
for (let k = 1; k <= 6; k++) {
  const start = new Date(now.getFullYear(), now.getMonth() - k, 1);
  const end = new Date(now.getFullYear(), now.getMonth() - k + 1, 0);
  try {
    const { rows } = await callReport('OccupancyStatistics', loc, start, end);
    let occ = 0, tot = 0, oa = 0, ao = 0;
    for (const r of rows) { const a = num(r.Area), o = num(r.Occupied); occ += o; tot += num(r.TotalUnits); oa += a * o; ao += num(r.ActualOccupied); }
    console.log(`${start.toISOString().slice(0, 7)}   ${String(occ).padStart(4)}/${String(tot).padStart(4)}    ${String(Math.round(oa)).padStart(7)}   £${Math.round(ao)}`);
  } catch (e) { console.log(`${start.toISOString().slice(0, 7)}   ERROR: ${e.message}`); }
}
console.log('\n→ If occ/area CHANGE each month, historical backfill works (we can load all history).');
console.log('→ If every row is IDENTICAL, SiteLink only returns the CURRENT snapshot, so occupancy');
console.log('  history can only build forward from now (activity reports still backfill fine).');
process.exit(0);
