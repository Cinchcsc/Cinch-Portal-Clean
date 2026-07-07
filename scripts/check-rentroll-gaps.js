// Diagnoses "rates aren't showing for August [2025]" and the broader "many widgets show 0 when
// browsing history" report — confirmed via the live /api/portfolio?from=2025-08&to=2025-08 response
// that ALL 23 sites present for that month have rate/realRate/ssRate/ssReal/rentSum/stdRentSum/
// areaSum = 0, even though other reports (enquiries, move-ins/outs) DO have data for the same month.
// check:backfill-coverage already showed several reports have FEWER stored months than occupancy's
// full 122 (rent_roll 106, scheduled_outs/marketing/rate_changes 105, true_revenue/reservations
// 96-97) — meaning those reports are missing SOME months' raw_report rows entirely (not just missing
// fields on an existing row, like the earlier real-rate bug this session already fixed via a full
// historical re-pull of rent_roll). Any widget sourced from one of those reports will read 0 for
// whichever specific months are missing. This lists the exact missing months for a given report
// (default rent_roll) by comparing its stored months against occupancy's (the one report confirmed to
// have full 122-month coverage).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-rentroll-gaps.js [report]
import { admin } from '../lib/supabaseAdmin.js';

const report = process.argv[2] || 'rent_roll';

const PAGE = 1000;
async function fetchAllMonths(rep) {
  let all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from('raw_report').select('month').eq('report', rep).range(from, from + PAGE - 1);
    if (error) { console.error(error.message); process.exit(1); }
    all = all.concat(data);
    if (data.length < PAGE) break;
  }
  return new Set(all.map((r) => String(r.month).slice(0, 7)));
}

const occMonths = await fetchAllMonths('occupancy');
const repMonths = await fetchAllMonths(report);

const missing = [...occMonths].filter((mk) => !repMonths.has(mk)).sort();
console.log(`occupancy: ${occMonths.size} months, ${report}: ${repMonths.size} months`);
console.log(`\nMonths present in occupancy but MISSING from ${report} entirely (${missing.length}):`);
for (const mk of missing) console.log(' ', mk);
console.log(`\nNOTE: these months were likely already attempted by a prior full repull (repull-report-all-months.js`);
console.log(`iterates every month occupancy has, not just ${report}'s own existing months) and failed silently —`);
console.log(`repull-report-all-months.js does NOT skip already-populated months, so blindly re-running the full`);
console.log(`122-month job again would take another 1-3 hours to fix a handful of months. Target just the missing`);
console.log(`ones instead, one at a time:`);
for (const mk of missing) console.log(`  node --env-file=.env scripts/repull-report-month.js ${report} ${mk}`);
process.exit(0);
