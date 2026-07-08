// Merchandise Income per New Customer (Ancillaries page) reads £11.01 live vs legacy's £1.00 for
// July 2026 — an ~11x gap (Michael's own framing: "mine is 10 higher"), bigger than the ~£8 "wrong
// report" bug fixed 6 Jul (switching the numerator from MerchandiseSummary to FinancialSummary's POS
// category). Both move_ins_outs and financial are pulled with the IDENTICAL month-to-date date range
// (lib/pull.js's endOf() caps every report at "now"), so a simple numerator/denominator month-scope
// mismatch is ruled out by inspection.
// UPDATE 8 Jul 2026, second live run (L001): the moveIns-source-mismatch hypothesis is ALSO dead —
// ManagementSummary and MoveInsAndMoveOuts agree exactly (5 move-ins both ways). Numerator confirmed
// 2 independent ways, denominator confirmed 2 independent ways, all landing on the same £20.00/customer
// for L001. That number is internally solid — the mystery is no longer "is our arithmetic wrong," it's
// "why does a solid per-site number still roll up to an ~11x-too-high portfolio figure." Leading
// hypothesis now: TIMING, not calculation. Today is the 8th of the month — "month-to-date" is only ~8
// days of data, and a *ratio* of two small counts (a handful of move-ins, a handful of POS sales) is
// naturally noisy/volatile early in the month in a way a raw count isn't. Legacy may be showing the
// last COMPLETE month (June, ~30 days, much larger/stabler sample) for this specific ratio widget,
// while ours (since the 7 Jul revert to always show real current-month partial data for flow metrics)
// now shows the live partial month. Added optional monthArg so this can be re-run against a closed
// month for direct comparison — same endOf() capping convention as reparse-report.js.
// Read-only, no writes, no PII (site codes + counts/sums only, no tenant/charge descriptions beyond
// the category code already used in production).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/dump-financial-vs-moveins.js [siteCode] [YYYY-MM]
// Example: node --env-file=.env scripts/dump-financial-vs-moveins.js L001 2026-06   (last complete month)
import { callReport, extractRows } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const siteCode = process.argv[2] || 'L001';
const monthArg = process.argv[3]; // optional YYYY-MM; defaults to current month-to-date
const now = new Date();
let start, end;
if (monthArg) {
  const [y, m] = monthArg.split('-').map(Number);
  start = new Date(y, m - 1, 1);
  const fullMonthEnd = new Date(y, m, 0);
  const isCurrentMonth = y === now.getFullYear() && m === now.getMonth() + 1;
  end = isCurrentMonth && fullMonthEnd > now ? now : fullMonthEnd;
} else {
  start = new Date(now.getFullYear(), now.getMonth(), 1);
  end = now; // month-to-date, matching lib/pull.js's endOf()
}
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

console.log(`=== FinancialSummary vs MoveInsAndMoveOuts, ${siteCode}, ${fmt(start)} to ${fmt(end)} ===\n`);

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
// UPDATED 8 Jul 2026: sampleKeys (Object.keys(v[0].attributes || v[0])) came back as just diffgram
// plumbing ('diffgr:id','msdata:rowOrder') for EVERY table including Charge — not useful, since
// Charge's real fields only appear once extractRows() normalizes them (the "Sample row" print above).
// Print full rows instead of guessing which key holds real data, so there's no ambiguity about what's
// actually inside the smaller POSCharges/PaymentsGrouped/ChargeCards tables sitting next to Charge —
// first run found exactly one of these (POSCharges) sitting right where you'd expect the *real*
// merchandise source to live, separate from Charge-filtered-by-category (what the code uses today).
const tables = [];
(function walk(node, path) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') tables.push({ name: k, count: v.length, rows: v });
    else if (v && typeof v === 'object') walk(v, `${path}.${k}`);
  }
})(diff || finRaw, 'root');
console.log(`\nFound ${tables.length} row-array table(s) in the raw FinancialSummary response:`);
for (const t of tables) {
  console.log(`  ${t.name} (${t.count} rows)`);
  if (t.count <= 10) for (const r of t.rows) console.log(`    ${JSON.stringify(r)}`);
  else console.log(`    sample: ${JSON.stringify(t.rows[0])}`);
}
if (tables.length > 1) {
  const largest = tables.slice().sort((a, b) => b.count - a.count)[0];
  console.log(`\n  extractRows() picked the largest ('${largest.name}', ${finRows.length} rows) — if that's NOT the right one for this report, that's the bug.`);
}

console.log('');
const { rows: mioRows } = await callReport('MoveInsAndMoveOuts', siteCode, start, end);
const mioParsed = REPORTS.move_ins_outs.parse(mioRows);
console.log(`MoveInsAndMoveOuts: ${mioRows.length} raw rows, ${mioParsed.move_ins} move-ins this period (per-event count).`);

// ADDED 8 Jul 2026: the POSCharges detour above was a dead end (its total matches Charge-filtered-by-
// POS exactly for this site). But buildPayload.js's ACTUAL `moveIns` field — the Ancillaries page's
// real denominator — is NOT move_ins_outs.move_ins above. It's `mg.move_ins`, read from
// ManagementSummary's own labelled UnitActivity row (buildPayload.js: `moveIns: mg.move_ins || 0`).
// These are two different reports/counting methods and nothing had compared them directly for the
// same site/period before now — if they disagree, that's a much stronger candidate for the real bug,
// since it changes the denominator production actually uses, not just a diagnostic side-quantity.
const { rows: mgRows } = await callReport('ManagementSummary', siteCode, start, end);
const mgParsed = REPORTS.management.parse(mgRows, start, end);
console.log(`ManagementSummary: ${mgParsed.move_ins} move-ins this period (this is what buildPayload.js actually uses as 'moveIns').`);
if (mgParsed.move_ins !== mioParsed.move_ins) {
  console.log(`  *** MISMATCH: ManagementSummary says ${mgParsed.move_ins}, MoveInsAndMoveOuts says ${mioParsed.move_ins}, same site/period. ***`);
}

console.log(`\nMerchandise Income per New Customer for ${siteCode} alone:`);
console.log(`  using ManagementSummary move-ins (what production actually computes): £${mgParsed.move_ins ? (posSum / mgParsed.move_ins).toFixed(2) : 'n/a (0 move-ins)'}`);
console.log(`  using MoveInsAndMoveOuts move-ins (for comparison):                   £${mioParsed.move_ins ? (posSum / mioParsed.move_ins).toFixed(2) : 'n/a (0 move-ins)'}`);
process.exit(0);
