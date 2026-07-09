// Follow-up to the Debtor Levels investigation: an Excel export of ManagementSummary for L012
// (Gillingham, run 7 Jul 2026 in SiteLink's own UI) has 16 sheets — Sheet9 is a genuine "Delinquency
// Aging" table (buckets 0-10/11-30/31-60/61-90/.../>360, each with a £ total and unit count) that
// EXACTLY explains the Debtor Levels discrepancy we've been chasing (31-60+ bucket totals £973.29,
// much closer to reality than our current PastDueBalances-derived figure). But lib/sitelink.js's
// extractRows() only ever returns the SINGLE LARGEST table in the SOAP response (`if (v.length >
// found.length) found = v`) — for ManagementSummary that's always "UnitActivity" (13 rows), so the
// Delinquency Aging table (8 rows) has been silently discarded on every pull, ever.
// This script dumps the RAW (untouched by extractRows) SOAP response's table structure so we can
// find the Delinquency Aging table's real diffgram node name (Excel's "Sheet9" is just SiteLink's own
// export tool's generic label, not the underlying table name) — needed before writing a targeted
// extractor for it.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/dump-managementsummary-tables.js [siteCode] [YYYY-MM]
// FIXED 9 Jul 2026: (a) siteCode/month args were declared in the usage comment but never actually
// read from process.argv — every run silently used the hardcoded L012/Jul-2026 regardless of what
// was typed on the command line. (b) sampleKeys used `v[0].attributes || v[0]` — but these SOAP rows
// have BOTH a real `attributes` object (diffgr:id/msdata:rowOrder bookkeeping only, confirmed via a
// live run) AND the actual data fields (sConcessionPlan, dcVarRentSum, etc.) as top-level SIBLING
// properties on v[0] itself — `attributes` being truthy meant the `||` never fell through to the
// real fields, so every table printed only the 2 bookkeeping keys and nothing useful. Now prints
// Object.keys(v[0]) (the real fields) plus a full JSON dump of the first 2 rows for the two tables
// we actually care about (VarFromStdRate, Discounts).
import { callReport } from '../lib/sitelink.js';

const siteCode = process.argv[2] || 'L012';
const monthArg = process.argv[3];
let start, end;
if (monthArg) {
  const [y, m] = monthArg.split('-').map(Number);
  start = new Date(y, m - 1, 1);
  const now = new Date();
  const fullMonthEnd = new Date(y, m, 0);
  end = (y === now.getFullYear() && m === now.getMonth() + 1 && fullMonthEnd > now) ? now : fullMonthEnd;
} else {
  start = new Date(2026, 6, 1); end = new Date();
}
console.log(`Site ${siteCode}, ${start.toISOString().slice(0,10)} to ${end.toISOString().slice(0,10)}\n`);
const { raw: result } = await callReport('ManagementSummary', siteCode, start, end);

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
      tables.push({ path: `${path}.${k}`, name: k, count: v.length, rows: v });
    } else if (v && typeof v === 'object') walk(v, `${path}.${k}`);
  }
})(diff || result, 'root');

console.log(`Found ${tables.length} row-array tables:\n`);
for (const t of tables) {
  const keys = Object.keys(t.rows[0]).filter((k) => k !== 'attributes');
  console.log(`${t.name} (${t.count} rows) — keys: ${keys.join(', ')}`);
}

console.log('\n--- Full sample rows for VarFromStdRate and Discounts ---');
for (const name of ['VarFromStdRate', 'Discounts']) {
  const t = tables.find((x) => x.name === name);
  console.log(`\n${name}:`);
  if (!t) { console.log('  (table not found in this response)'); continue; }
  for (const r of t.rows.slice(0, 3)) {
    const clean = { ...r }; delete clean.attributes;
    console.log('  ' + JSON.stringify(clean));
  }
}
process.exit(0);
