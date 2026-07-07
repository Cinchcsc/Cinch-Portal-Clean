// Explains the Month-on-Month "Self Storage Rate" chart looking broken: occ counts are populated
// for all 71 backfilled months (back to 2020), but ssRate/ssAreaSum/ssRentSum are exactly 0 for
// every month before May 2026 — meaning rent_roll's self_storage sub-object (or rent_roll itself)
// was very likely never actually pulled/stored for the older backfilled months. This counts, PER
// REPORT, how many of the 71 stored months actually have that report's raw_report row at all — if
// rent_roll's coverage count is much lower than occupancy's, that confirms the historical backfill
// only ever covered a subset of reports.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-backfill-coverage.js
import { admin } from '../lib/supabaseAdmin.js';

// Supabase's client caps .select() at 1000 rows by default. With ~71 months x 27 sites x ~16
// report types, raw_report has tens of thousands of rows, so a single unpaginated select() only
// sees a fraction of the table (silently, no error) — paginate with .range() until a page comes
// back short of the page size.
const PAGE = 1000;
let all = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await admin
    .from('raw_report')
    .select('report,month')
    .range(from, from + PAGE - 1);
  if (error) { console.error(error.message); process.exit(1); }
  all = all.concat(data);
  if (data.length < PAGE) break;
}
console.log(`Fetched ${all.length} raw_report rows (paginated)\n`);

const byReport = {};
for (const r of all) {
  const mk = String(r.month).slice(0, 7);
  (byReport[r.report] ??= new Set()).add(mk);
}
console.log('report'.padEnd(20), 'months with data', '  earliest', '   latest');
for (const [report, months] of Object.entries(byReport).sort((a, b) => b[1].size - a[1].size)) {
  const sorted = [...months].sort();
  console.log(report.padEnd(20), String(months.size).padStart(15), '  ', sorted[0], '..', sorted[sorted.length - 1]);
}
process.exit(0);
