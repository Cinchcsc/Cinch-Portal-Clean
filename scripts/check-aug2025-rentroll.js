// Follow-up to check-rentroll-gaps.js: that script confirmed Aug 2025 is NOT one of the 16 months
// missing from rent_roll's raw_report coverage (the gap is a contiguous 2017-03..2018-06 block only)
// — yet the live /api/portfolio?from=2025-08&to=2025-08 response showed rate/realRate/rentSum/
// areaSum = 0 for EVERY site that month. That means, unlike the 16-month gap (no row at all), Aug
// 2025 DOES have a raw_report row for rent_roll per site — but something inside `data` itself is
// zeroed out. This dumps the raw stored `data` object for Aug 2025 across every site to see whether
// the rows exist with genuinely empty sums (e.g. a failed/empty SiteLink pull that still got written),
// or something else entirely (wrong shape, error object stored as data, etc.).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-aug2025-rentroll.js
import { admin } from '../lib/supabaseAdmin.js';

const { data: rows, error } = await admin
  .from('raw_report')
  .select('site_code, data, pulled_at')
  .eq('report', 'rent_roll')
  .eq('month', '2025-08-01');
if (error) { console.error(error.message); process.exit(1); }

console.log(`Found ${rows.length} raw_report rows for rent_roll / 2025-08-01\n`);
for (const r of rows.slice(0, 5)) {
  console.log(`--- ${r.site_code} (pulled_at ${r.pulled_at}) ---`);
  console.log(JSON.stringify(r.data, null, 2).slice(0, 800));
  console.log();
}
if (rows.length > 5) console.log(`...(${rows.length - 5} more sites, same shape likely)`);
process.exit(0);
