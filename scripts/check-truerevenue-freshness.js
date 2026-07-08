// Checks whether True Revenue's stored raw_report data for the current month is STALE relative to
// today — added 8 Jul 2026 while chasing "why is Real Rate low for basically every site, even
// though the formula/columns/report were validated earlier today via probe-rate-both-formulas.js".
//
// Traced the code by hand first (not guessing): probe-rate-both-formulas.js calls
// REPORTS.true_revenue.parse() from lib/reportMap.js DIRECTLY — the exact same parser, same 9
// column names (InvoicedThisPeriod..TruePeriod), same groupBy — that the production buildPayload()
// path uses. It also computes total_area_all_units with logic byte-for-byte identical to what was
// just added to reportMap.js's rent_roll parser (same num()/isSS() calls, same "before the
// bRented continue" placement). So the FORMULA, COLUMNS, and REPORT are confirmed identical between
// the validated probe and production — that part is not in question.
//
// What's different: the probe makes a FRESH live SiteLink call every time it runs. Production reads
// raw_report.data, populated whenever `npm run pull` (or a targeted repull) last ran for that
// report/month — NOT re-pulled by today's rent_roll reparse (reparse-report.js replays already-
// stored raw_response through the current parser; it does not call SiteLink again). true_revenue is
// a "Daily Pro Rate" report for the CURRENT, in-progress month — if it was last actually pulled
// several days ago, TruePeriod reflects revenue accrued only up to THAT day, not up to today, while
// Rate (dcStdRate, a point-in-time field) doesn't have this staleness problem at all. That would
// explain low Real Rate almost everywhere while plain Rate stays roughly normal, with no bug in the
// formula/columns/report itself.
// Read-only, no writes, no PII (site codes + timestamps + row/column counts only).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-truerevenue-freshness.js
import { admin } from '../lib/supabaseAdmin.js';

const now = new Date();
const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

const { data, error } = await admin.from('raw_report')
  .select('site_code,report,pulled_at')
  .in('report', ['rent_roll', 'true_revenue'])
  .eq('month', monthKey)
  .order('site_code');
if (error) { console.error(error.message); process.exit(1); }

const bySite = {};
for (const r of data || []) {
  (bySite[r.site_code] ??= {})[r.report] = r.pulled_at;
}

console.log(`=== rent_roll vs true_revenue pulled_at, ${monthKey} (today is ${now.toISOString().slice(0, 10)}) ===\n`);
console.log('code   rent_roll pulled_at          true_revenue pulled_at      gap (true_revenue behind rent_roll)');
let maxGapHrs = 0, maxGapSite = null, staleCount = 0;
for (const code of Object.keys(bySite).sort()) {
  const rr = bySite[code].rent_roll, tr = bySite[code].true_revenue;
  let gapStr = 'n/a';
  if (rr && tr) {
    const gapHrs = (new Date(rr) - new Date(tr)) / 3600000;
    gapStr = `${gapHrs.toFixed(1)}h`;
    if (gapHrs > maxGapHrs) { maxGapHrs = gapHrs; maxGapSite = code; }
  }
  const daysSinceTrPull = tr ? ((now - new Date(tr)) / 86400000).toFixed(1) : 'n/a';
  if (tr && (now - new Date(tr)) / 86400000 > 1) staleCount++;
  console.log(`${code}  ${(rr || 'MISSING').padEnd(28)}  ${(tr || 'MISSING').padEnd(26)}  ${gapStr}   (true_revenue is ${daysSinceTrPull} day(s) old)`);
}
console.log(`\nBiggest rent_roll-vs-true_revenue pull gap: ${maxGapSite || 'n/a'} at ${maxGapHrs.toFixed(1)} hours.`);
console.log(`Sites where true_revenue is >1 day old: ${staleCount} of ${Object.keys(bySite).length}.`);
console.log(`\nIf true_revenue's pulled_at is DAYS behind rent_roll's (or behind today), that's very likely`);
console.log(`why Real Rate reads low almost everywhere: TruePeriod reflects revenue accrued only up to`);
console.log(`whenever true_revenue was last actually pulled, not up to today. Fix: re-pull just`);
console.log(`true_revenue for the current month with the existing targeted repull tool (a real SiteLink`);
console.log(`call, not a reparse — reparse-report.js can't help here since there's nothing newer already`);
console.log(`stored to replay):`);
console.log(`  node --env-file=.env scripts/repull-report-month.js true_revenue ${monthKey.slice(0, 7)}`);
process.exit(0);
