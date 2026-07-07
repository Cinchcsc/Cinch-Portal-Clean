// Follow-up to check-aug2025-rentroll.js: that script queried raw_report with `.eq('month',
// '2025-08-01')` and found real, nonzero data for L001 (area_sum 23522, rent_sum 47919). But the live
// /api/portfolio?from=2025-08&to=2025-08 endpoint still shows L001's rate/rentSum/areaSum all as 0 —
// even after restarting the dev server, ruling out stale-server-cache as the cause. buildIndex()
// (lib/buildPayload.js) has a comment noting it de-dupes rows that collapse to the same YYYY-MM key
// (e.g. "legacy end-of-month keys vs canonical -01 keys"), keeping whichever has the LATER pulled_at —
// so if there's a SECOND raw_report row for the same site+report with a different literal `month`
// value that also falls in August 2025 (e.g. '2025-08-31' instead of '2025-08-01'), and that second
// row has empty/zero data with a pulled_at timestamp that beats the good row's, buildIndex would pick
// the WRONG (empty) one — explaining exactly this symptom. This lists every raw_report row for
// rent_roll/L001 whose month falls in August 2025, with its exact month value and pulled_at, so we can
// see if there are two colliding rows.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-aug2025-dupe-keys.js [siteCode]
import { admin } from '../lib/supabaseAdmin.js';

const site = process.argv[2] || 'L001';
const { data, error } = await admin
  .from('raw_report')
  .select('site_code, month, report, pulled_at, data')
  .eq('site_code', site)
  .eq('report', 'rent_roll')
  .gte('month', '2025-08-01')
  .lt('month', '2025-09-01');
if (error) { console.error(error.message); process.exit(1); }

console.log(`Found ${data.length} raw_report row(s) for ${site}/rent_roll with month in Aug 2025:\n`);
for (const r of data) {
  console.log(`month=${r.month}  pulled_at=${r.pulled_at}  area_sum=${r.data?.area_sum}  rent_sum=${r.data?.rent_sum}  rate_per_sqft_ann=${r.data?.rate_per_sqft_ann}`);
}
if (data.length > 1) {
  console.log(`\n*** MULTIPLE ROWS FOUND for the same site+report both mapping to "2025-08" — this is the bug. ***`);
  console.log(`buildIndex() picks whichever has the LATER pulled_at, which may not be the one with real data.`);
}
process.exit(0);
