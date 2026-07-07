// Finds the real column SiteLink's OccupancyStatistics report uses for "Autobilled" units, so we
// can implement the authoritative Autobill formula (legacy portal tooltip, confirmed 2 Jul 2026):
//   Autobill % = Occupancy Statistics -> Autobilled  /  Occupancy Statistics -> Occupied Units
// The current occupancy parser (lib/reportMap.js) only reads UnitType, Area, TotalArea, Occupied,
// TotalUnits, StandardRate, GrossPotential, GrossOccupied, ActualOccupied — no Autobill column is
// captured yet, so this dumps every raw column + full row for one site/month to find it.
// PII-SAFE: OccupancyStatistics rows are per UnitType x UnitSize, not per-tenant, so this is safe
// to print in full (no tenant names/balances).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-autobill.js
import { callReport } from '../lib/sitelink.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const end = now;

console.log(`OccupancyStatistics · site ${loc} · ${start.toISOString().slice(0, 10)} -> ${end.toISOString().slice(0, 10)}\n`);
const { rows } = await callReport('OccupancyStatistics', loc, start, end);
console.log('row count:', rows.length);
if (!rows.length) { console.log('no rows for this period.'); process.exit(0); }

const cols = Object.keys(rows[0]).filter((k) => !/^(diffgr|msdata)/i.test(k));
console.log('\nALL COLUMNS:\n' + cols.join(', '));

console.log('\nCANDIDATE COLUMNS (name hints at autobill/auto-pay/billing):');
const nameHints = cols.filter((c) => /auto.?bill|autopay|billtype|billing/i.test(c));
console.log(nameHints.join(', ') || '(none by name — check the full row dump below)');

console.log('\nFULL FIRST ROW (all columns + values):');
for (const c of cols) console.log(`  ${c.padEnd(25)} ${rows[0][c]}`);

console.log('\nVALUE HISTOGRAMS for every column with <=12 distinct values (categorical/flag candidates):');
for (const c of cols) {
  const vals = {};
  for (const r of rows) { const v = String(r[c] ?? '(blank)'); vals[v] = (vals[v] || 0) + 1; }
  const distinct = Object.keys(vals);
  if (distinct.length >= 1 && distinct.length <= 12) {
    console.log(`\n${c}:`);
    for (const [v, n] of Object.entries(vals).sort((a, b) => b[1] - a[1])) console.log(`  ${v.padEnd(20)} ${n}`);
  }
}
process.exit(0);
