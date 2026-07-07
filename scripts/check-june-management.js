// Read-only, no SiteLink calls: after the SQL delete + `npm run pull`, Customer Churn's June
// row STILL shows moveIns=0/moveOuts=0 (see check-churn-history.js output). This script checks
// whether that's because (a) the delete/pull never actually touched June's `management` rows
// (stale pulled_at, fixable by re-running), or (b) the rows WERE freshly re-pulled today but
// SiteLink's ManagementSummary report simply doesn't return real numbers for a closed/past month
// (same "not historical-aware" pattern already confirmed for RentRoll/OccupancyStatistics/
// ReservationList — in which case the correct June figures are gone for good via this API).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-june-management.js
import { admin } from '../lib/supabaseAdmin.js';

const { data, error } = await admin
  .from('raw_report')
  .select('site_code,pulled_at,data')
  .eq('month', '2026-06-01')
  .eq('report', 'management');

if (error) { console.log('read error:', error.message); process.exit(1); }
if (!data || !data.length) {
  console.log('No `management` rows exist for 2026-06-01 at all — the delete ran but the pull never re-wrote them. Re-run `npm run pull`.');
  process.exit(0);
}

const pulledAts = data.map(r => r.pulled_at).sort();
console.log(`Rows found for June/management: ${data.length}`);
console.log(`Oldest pulled_at: ${pulledAts[0]}`);
console.log(`Newest pulled_at: ${pulledAts[pulledAts.length - 1]}`);
console.log(`(compare to today's date/time — if these are OLD, the pull silently skipped June; if RECENT/today, SiteLink was actually called just now)\n`);

let miSum = 0, moSum = 0, nonZeroSites = 0;
console.log('site_code   moveIns   moveOuts   pulled_at');
console.log('---------------------------------------------------------');
for (const r of data) {
  const d = r.data || {};
  const mi = d.move_ins ?? d.moveIns ?? 0;
  const mo = d.move_outs ?? d.moveOuts ?? 0;
  if (mi || mo) nonZeroSites++;
  miSum += mi; moSum += mo;
  console.log(`${r.site_code.padEnd(10)}  ${String(mi).padStart(7)}   ${String(mo).padStart(8)}   ${r.pulled_at}`);
}
console.log(`\nTotals: moveIns=${miSum}, moveOuts=${moSum}, sites with any nonzero=${nonZeroSites}/${data.length}`);
process.exit(0);
