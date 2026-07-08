// Follow-up to the exhaustive June comparison (7 Jul 2026): our Financials page's True Revenue
// "Rent" row for June 2026 is ~2.14x the legacy portal's (£2,331,337.64 vs £1,088,223.23 True Period;
// £2,684,647.58 vs £1,256,728.91 Invoiced) — and a rough sanity check (occupied area × rate ÷ 12 ≈
// £1.24M/month) says legacy's figure is the plausible one, ours is inflated.
// This is the exact same BUG CLASS already found and fixed for ManagementSummary/Debtor Levels this
// session: lib/sitelink.js's extractRows() only ever returns the SINGLE LARGEST table in a SOAP
// DataSet response (`if (v.length > found.length) found = v`), silently discarding every other table.
// If CustomReportByReportID's raw response for ReportID 781861 ("True Revenue Report - Daily Prorate")
// contains MORE THAN ONE table — e.g. a per-(ChargeDesc,UnitType) DETAIL table plus a per-ChargeDesc
// SUBTOTAL table — and extractRows() is quietly picking (or `rows` ends up containing) both, every
// group in lib/reportMap.js's true_revenue.parse()'s groupBy('ChargeDesc') would sum detail rows AND
// their own subtotals together, roughly doubling every figure. This script dumps the RAW (untouched
// by extractRows) response's table structure, same technique as dump-managementsummary-tables.js, to
// confirm or rule this out before writing a fix.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/dump-truerevenue-tables.js [siteCode]
// Example: node --env-file=.env scripts/dump-truerevenue-tables.js L012
import { callCustomReport, extractRows } from '../lib/sitelink.js';

const siteCode = process.argv[2] || 'L012';
const start = new Date(2026, 5, 1), end = new Date(2026, 5, 30); // June 2026, a closed month
const { rows, raw: result } = await callCustomReport(781861, siteCode, start, end);

console.log(`extractRows() currently returns ${rows.length} rows for ${siteCode}, June 2026.`);
console.log(`Sample row:`, rows[0] || '(none)');
console.log('');

// Find the diffgram, then list EVERY table found inside it (name + row count + first row's keys),
// instead of extractRows()'s "just the biggest one" behavior.
let diff = null;
(function find(node) {
  if (!node || typeof node !== 'object' || diff) return;
  for (const [k, v] of Object.entries(node)) {
    if (diff) return;
    if (/diffgram/i.test(k) && v && typeof v === 'object') { diff = v; return; }
    if (v && typeof v === 'object') find(v);
  }
})(result);

const tables = [];
(function walk(node, path) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      tables.push({ path: `${path}.${k}`, name: k, count: v.length, sampleKeys: Object.keys(v[0].attributes || v[0]) });
    } else if (v && typeof v === 'object') walk(v, `${path}.${k}`);
  }
})(diff || result, 'root');

console.log(`Found ${tables.length} row-array table(s) in the raw CustomReportByReportID(781861) response for ${siteCode}:\n`);
for (const t of tables) {
  console.log(`${t.name} (${t.count} rows) — keys: ${t.sampleKeys.join(', ')}`);
}
if (tables.length > 1) {
  console.log('\n>1 table found — this is almost certainly the doubling bug. Compare row counts/keys above');
  console.log('to see if one table is a per-(ChargeDesc,UnitType) detail table and another is a subtotal/');
  console.log('summary table at a coarser grain (e.g. per-ChargeDesc only, or a single portfolio total row).');
}
process.exit(0);
