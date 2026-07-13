// check-realrate-closed-month.js's June result was 3x+ WORSE than the live July MTD test, and
// flipped from mixed-sign to overwhelmingly too HIGH (avg +217%, 25/26 sites over, some +300-600%).
// That's the opposite of what a "period mismatch" hypothesis predicts for a properly closed month —
// something about the STORED June true_revenue row itself looks inflated. Bicester's June
// trueRevenueNumerator (58404.82) is almost exactly 3x its known-correct July figure (19483.82) --
// a ~3x inflation smells like the stored row was captured with something like a 90-day window
// instead of 30, still annualized as if it were one month. true_revenue.parse() computes and stores
// `period_days` from whatever start/end dates were ACTUALLY used when this row was last captured --
// this reads that back directly, plus pulled_at, for a few sites, no live SiteLink calls.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-truerevenue-stored-period.js
import { admin } from '../lib/supabaseAdmin.js';

const SITES = ['L001', 'L002', 'L010', 'L029', 'L027']; // L027 was the one outlier that ran LOW instead of high
const MONTH = '2026-06-01';

for (const site of SITES) {
  const { data, error } = await admin
    .from('raw_report').select('data,pulled_at,raw_response').eq('report', 'true_revenue').eq('site_code', site).eq('month', MONTH).maybeSingle();
  if (error) { console.log(`${site}: read error — ${error.message}`); continue; }
  if (!data) { console.log(`${site}: no stored row for ${MONTH}.`); continue; }
  let d = data.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
  const byType = d?.by_type || [];
  const sum = byType.reduce((a, r) => a + (r.truePeriod || 0), 0);
  console.log(`${site}: pulled_at=${data.pulled_at}  period_days=${d?.period_days ?? '(not present -- pulled before 10 Jul field was added)'}  truePeriod sum=${sum.toFixed(2)}  has raw_response=${!!data.raw_response}`);
}
process.exit(0);
