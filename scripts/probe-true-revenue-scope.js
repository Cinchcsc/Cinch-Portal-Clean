// Diagnoses the "£1M+ off" True Revenue complaint (3 Jul 2026). The column mapping/coloring was
// just fixed, but the underlying £ values are still way off — the leading suspect is that
// CustomReportByReportID(781861) does NOT actually respect dReportDateStart/dReportDateEnd (some
// SiteLink custom reports are built with their own hardcoded date logic in the report designer,
// ignoring whatever the caller passes) and is instead returning multi-year cumulative totals for
// the site, which then get SUMMED ACROSS EVERY SITE in buildPayload.js's sumRevenueGroups() —
// easily enough to land a million-plus pounds off for a portfolio-wide table.
// This proves/disproves that theory directly: call the same report for the SAME site with two very
// different date windows (this month vs. a 3-day window) and check whether the totals change at all.
//   - If totals are IDENTICAL (or nearly) regardless of date range -> confirmed: the report ignores
//     the date params and returns all-time cumulative data. Fix = either find the right params SiteLink
//     actually uses for this custom report (may need their support), or stop summing across sites/months
//     and instead take this report at face value as a point-in-time "life of report" cumulative figure.
//   - If totals scale down with the narrower window -> the report IS respecting dates, and the £1M+ gap
//     has a different cause (e.g. duplicate ChargeDesc/UnitType rows, wrong column mapping, or a units
//     mismatch like pence vs pounds).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-true-revenue-scope.js
import { callCustomReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const now = new Date();

const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
const narrowStart = new Date(monthEnd); narrowStart.setDate(narrowStart.getDate() - 2);
const narrowEnd = monthEnd;

async function run(label, start, end) {
  const { rows } = await callCustomReport(781861, loc, start, end);
  const parsed = REPORTS.true_revenue.parse(rows);
  const total = parsed.by_desc.reduce((a, r) => a + r.truePeriod, 0);
  console.log(`${label.padEnd(28)} range=${start.toDateString()} -> ${end.toDateString()}  rows=${rows.length}  TOTAL True Period=£${total.toFixed(2)}`);
  return total;
}

console.log(`site ${loc} · ReportID 781861 — date-scope sensitivity test\n`);
const full = await run('Full month window', monthStart, monthEnd);
const narrow = await run('3-day window (same end date)', narrowStart, narrowEnd);

console.log('\n---');
if (Math.abs(full - narrow) < 0.01) {
  console.log('IDENTICAL totals regardless of date range -> the custom report is NOT respecting the date params. It is returning a fixed/cumulative figure no matter what we ask for. This explains the £1M+ gap: buildPayload.js is summing this same inflated per-site figure across every site as if it were month-scoped.');
} else if (narrow < full * 0.5) {
  console.log('Totals scale down with a narrower window -> the report DOES respect date params. The £1M+ gap has a different cause — check for duplicate rows, wrong column-to-field mapping, or a pence/pounds unit mismatch next.');
} else {
  console.log('Partial difference, not a clean scale-down or exact match — inconclusive, needs a closer look at raw row dates/values (add a per-row dump if this happens).');
}
process.exit(0);
