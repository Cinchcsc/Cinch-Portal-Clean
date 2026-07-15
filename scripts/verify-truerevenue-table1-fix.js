// Verifies the 15 Jul 2026 true_revenue fix (lib/reportMap.js) BEFORE it's trusted/committed to a
// financial-accuracy-critical code path. Prints "True Revenue — Unit Types" totals computed the OLD
// way (Table2 — per-transaction/day-prorated rows, 1853+ per site, what extractRows() was silently
// keeping) side-by-side with the NEW way (Table1 — SiteLink's own 36-row per-(UnitType,ChargeDesc)
// pre-aggregate, what the fix now uses via extractNamedTable()), for one site + the current month.
// Compare the NEW column directly against the legacy portal's own "True Revenue — Unit Types" widget
// for the SAME site/month (e.g. whatever Michael's side-by-side screenshot showed) — that's the real
// ground truth here, not the (possibly stale) hardcoded targets in probe-truerevenue-coverage.js.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/verify-truerevenue-table1-fix.js <SITE>
// Example: node --env-file=.env scripts/verify-truerevenue-table1-fix.js L012
import { callCustomReport, extractRows, extractNamedTable } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[verify-truerevenue-table1-fix] ' + lock.message); process.exit(1); }

const loc = process.argv[2] || 'L012';
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

const num = (row, k) => {
  const v = row && row[k];
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[£,%\s]/g, ''));
  return Number.isNaN(n) ? 0 : n;
};
const str = (v) => (v == null ? '' : String(v).trim());
const R2v = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const { raw } = await callCustomReport(781861, loc, start, now);
const oldRows = extractRows(raw);           // whatever extractRows() keeps today (Table2, pre-fix behavior)
const newRows = extractNamedTable(raw, 'Table1'); // what the fix now uses

console.log(`${loc} — ${start.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}`);
console.log(`OLD (extractRows, largest table): ${oldRows.length} rows`);
console.log(`NEW (extractNamedTable 'Table1'): ${newRows.length} rows\n`);

function byType(rows) {
  const g = {};
  for (const r of rows) {
    const k = str(r.UnitType) || 'Other';
    g[k] = (g[k] || 0) + num(r, 'TruePeriod');
  }
  return g;
}

const oldByType = byType(oldRows);
const newByType = byType(newRows);
const types = [...new Set([...Object.keys(oldByType), ...Object.keys(newByType)])].sort();

console.log('UnitType'.padEnd(20) + 'OLD (Table2)'.padEnd(16) + 'NEW (Table1)');
let oldTotal = 0, newTotal = 0;
for (const t of types) {
  const o = R2v(oldByType[t] || 0), n = R2v(newByType[t] || 0);
  oldTotal += o; newTotal += n;
  console.log(t.padEnd(20) + `£${o}`.padEnd(16) + `£${n}`);
}
console.log('-'.repeat(50));
console.log('TOTAL'.padEnd(20) + `£${R2v(oldTotal)}`.padEnd(16) + `£${R2v(newTotal)}`);
console.log('\nCompare the NEW column above against the legacy portal\'s own True Revenue — Unit Types');
console.log('widget for this same site/month. If NEW is close to legacy and OLD is not, the fix is confirmed.');
process.exit(0);
