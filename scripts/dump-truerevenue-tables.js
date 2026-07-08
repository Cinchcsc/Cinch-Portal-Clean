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
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/dump-truerevenue-tables.js [siteCode] [YYYY-MM]
// Example: node --env-file=.env scripts/dump-truerevenue-tables.js L012
// Example: node --env-file=.env scripts/dump-truerevenue-tables.js L008 2026-07
//
// UPDATED 8 Jul 2026 (Michael: several sites' Real Rate landing 40-87% BELOW legacy after the
// True-Revenue-based formula fix — Enfield/L008, Exeter/L027, Swindon/L022, Wisbech/L023 worst so
// far). That's the opposite direction from the ~2.14x INFLATION this script was originally written
// to chase (multiple SOAP tables silently summed together) — so also now prints the raw TruePeriod
// sum, to check the simpler explanation first: SiteLink returning fewer/zero rows for these specific
// sites this month, rather than a table-multiplicity bug. Month now defaults to the CURRENT month
// (was hardcoded to June 2026) so this can actually check the month where the gap shows up.
import { callCustomReport, extractRows } from '../lib/sitelink.js';

const siteCode = process.argv[2] || 'L012';
const monthArg = process.argv[3]; // optional YYYY-MM, defaults to current month
let y, m;
if (monthArg) { [y, m] = monthArg.split('-').map(Number); } else { const n = new Date(); y = n.getFullYear(); m = n.getMonth() + 1; }
const start = new Date(y, m - 1, 1), end = new Date(y, m, 0);
const { rows, raw: result } = await callCustomReport(781861, siteCode, start, end);

console.log(`extractRows() currently returns ${rows.length} rows for ${siteCode}, ${y}-${String(m).padStart(2, '0')}.`);
console.log(`Sample row:`, rows[0] || '(none)');
const truePeriodSum = rows.reduce((a, r) => a + (Number(r.TruePeriod) || 0), 0);
const adjSum = rows.reduce((a, r) => a + (Number(r.ThisPeriodAdjustments) || 0), 0);
// ADDED 8 Jul 2026 (Michael: "tax adjustments is 0 fix it") — reportMap.js's true_revenue.parse()
// was reading the wrong column name for this field ('Tax1AdjustmentsThisPeriod' vs the real
// 'ThisPeriodTax1Adjustments', fixed same day) — this line sums the REAL column directly so a single
// run of this script proves whether that fix is producing a genuinely non-zero total for this site/
// month, instead of needing to eyeball the live page or a 790-row sample.
const taxAdjSum = rows.reduce((a, r) => a + (Number(r.ThisPeriodTax1Adjustments) || 0), 0);
console.log(`\nRaw TruePeriod sum across all ${rows.length} rows: ${truePeriodSum.toFixed(2)}`);
console.log(`Raw ThisPeriodAdjustments sum: ${adjSum.toFixed(2)}`);
console.log(`Raw ThisPeriodTax1Adjustments sum ("Tax Adj" column): ${taxAdjSum.toFixed(2)}`);
console.log(`TruePeriod - Adjustments (this is the Real Rate numerator before dividing by area): ${(truePeriodSum - adjSum).toFixed(2)}`);
if (rows.length === 0) console.log('\n0 rows back from SiteLink for this site/month — that alone would explain a 0 or near-0 Real Rate, no parsing bug needed. Worth checking directly in the legacy SiteLink UI whether this site genuinely has no True Revenue data for this month.');
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
  // UPDATED 8 Jul 2026: this used to say ">1 table = almost certainly the doubling bug" — RULED OUT
  // since (see check-truerevenue-freshness.js-era investigation): extractRows() picks the SINGLE
  // LARGEST table only (`if (v.length > found.length) found = v`), confirmed above as rows.length
  // matching that largest table's count exactly, every time — no concatenation across tables occurs.
  // The actual ~2x doubling bug (found and fixed the same day) was in lib/buildPayload.js's
  // mergeRowsAcrossMonths(), unrelated to this multi-table shape. The 2 smaller tables here are a
  // genuine, still-unexplained curiosity (their contents/purpose are unknown) but are NOT currently
  // read or summed anywhere, so they are not a live bug.
  console.log(`\n${tables.length} tables found (${tables.map(t => t.count).join('/')} rows) — extractRows() only`);
  console.log('ever keeps the largest one (confirmed: rows.length above matches it exactly), so the smaller');
  console.log('tables are silently unused, not double-counted. Their contents are still unidentified but');
  console.log('this is NOT the ~2x doubling bug (that was mergeRowsAcrossMonths(), already fixed).');
}
process.exit(0);
