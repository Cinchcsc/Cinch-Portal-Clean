// Merchandise Income per New Customer (Ancillaries page) reads £11.01 live vs legacy's £1.00 for
// July 2026 — an ~11x gap, much bigger than the ~£8 "wrong report" bug fixed 6 Jul (switching the
// numerator from MerchandiseSummary to FinancialSummary's POS category). Both move_ins_outs and
// financial are pulled with the IDENTICAL month-to-date date range (lib/pull.js's endOf() caps every
// report at "now", not just some of them), so a simple numerator/denominator month-scope mismatch is
// ruled out by inspection. Two remaining live hypotheses this dumps evidence for:
//   1) FinancialSummary's raw SOAP response has more than one table (same shape as the
//      ManagementSummary/True-Revenue multi-table reports already found this session) and
//      extractRows() is picking up more than just this period's detail rows.
//      lib/reportMap.js's financial.parse() pushes ONE row per raw line item into `categories`
//      (not pre-aggregated by category) — if `rows` itself contains more than just this month's real
//      line items, the POS sum inherits whatever that excess is.
//   2) The 'POS' category code also catches something that isn't genuinely new merchandise (a
//      recurring/non-move-in-linked charge), inflating the numerator relative to what legacy counts.
// Read-only, no writes, no PII (site codes + counts/sums only, no tenant/charge descriptions beyond
// the category code already used in production).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/dump-financial-vs-moveins.js [siteCode]
import { callReport, extractRows } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const siteCode = process.argv[2] || 'L001';
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const end = now; // month-to-date, matching lib/pull.js's endOf()

console.log(`=== FinancialSummary vs MoveInsAndMoveOuts, ${siteCode}, ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)} ===\n`);

const { rows: finRows, raw: finRaw } = await callReport('FinancialSummary', siteCode, start, end);
console.log(`extractRows() returns ${finRows.length} FinancialSummary rows for ${siteCode}.`);
console.log('Sample row:', finRows[0] || '(none)');

const finParsed = REPORTS.financial.parse(finRows);
const posRows = finParsed.categories.filter((c) => c.category === 'POS');
const posSum = posRows.reduce((a, c) => a + c.charge, 0);
console.log(`\nParsed: ${finParsed.categories.length} total charge line items, ${posRows.length} tagged category='POS'.`);
console.log(`POS charge sum (this is the Merchandise Sales numerator): £${posSum.toFixed(2)}`);
console.log(`All category codes seen (with counts): ${JSON.stringify(
  Object.entries(finParsed.categories.reduce((a, c) => { a[c.category || '(blank)'] = (a[c.category || '(blank)'] || 0) + 1; return a; }, {}))
)}`);

// Multi-table check, same technique as dump-truerevenue-tables.js / dump-managementsummary-tables.js.
let diff = null;
(function find(node) {
  if (!node || typeof node !== 'object' || diff) return;
  for (const [k, v] of Object.entries(node)) {
    if (diff) return;
    if (/diffgram/i.test(k) && v && typeof v === 'object') { diff = v; return; }
    if (v && typeof v === 'object') find(v);
  }
})(finRaw);
const tables = [];
(function walk(node, path) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') tables.push({ name: k, count: v.length, sampleKeys: Object.keys(v[0].attributes || v[0]) });
    else if (v && typeof v === 'object') walk(v, `${path}.${k}`);
  }
})(diff || finRaw, 'root');
console.log(`\nFound ${tables.length} row-array table(s) in the raw FinancialSummary response:`);
for (const t of tables) console.log(`  ${t.name} (${t.count} rows) — keys: ${t.sampleKeys.join(', ')}`);
if (tables.length > 1) console.log(`  extractRows() picked the largest (${finRows.length} rows) — if that's NOT the right one for this report, that's the bug.`);

console.log('');
const { rows: mioRows } = await callReport('MoveInsAndMoveOuts', siteCode, start, end);
const mioParsed = REPORTS.move_ins_outs.parse(mioRows);
console.log(`MoveInsAndMoveOuts: ${mioRows.length} raw rows, ${mioParsed.move_ins} move-ins this period.`);
console.log(`\nMerchandise Income per New Customer for ${siteCode} alone: £${mioParsed.move_ins ? (posSum / mioParsed.move_ins).toFixed(2) : 'n/a (0 move-ins)'}`);
process.exit(0);
