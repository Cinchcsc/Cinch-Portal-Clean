// Targeted fix for the Insurance Conversion "stuck at 0" bug: pull.js's month-lock mechanism means
// once a month becomes "previous" (closed) and gets captured ONCE, it is NEVER re-pulled again —
// including when the underlying parse logic in reportMap.js changes. June's insurance_roll rows were
// captured (and locked) BEFORE the dMovedIn-based insured_new_customers fix was written, so every
// `npm run pull` since then correctly skips re-pulling June's insurance_roll — silently leaving the
// OLD (broken) parsed output in place forever. This is the same class of bug as the earlier Customer
// Churn fix (delete the stale locked rows, then re-pull just that report/month so the CURRENT parser
// code runs against fresh raw SiteLink data).
// This script deletes raw_report rows for one report+month across every site, re-pulls just that
// report for that month (NOT a full 27x16 pull — much faster), then rebuilds portal_payload.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/repull-report-month.js <report> <YYYY-MM>
// Example: node --env-file=.env scripts/repull-report-month.js insurance_roll 2026-06
import { admin } from '../lib/supabaseAdmin.js';
import { pullReport } from '../lib/reportMap.js';
import { buildPayload } from '../lib/buildPayload.js';

const reportKey = process.argv[2];
const monthArg = process.argv[3]; // YYYY-MM
if (!reportKey || !monthArg) {
  console.error('Usage: node scripts/repull-report-month.js <report> <YYYY-MM>');
  process.exit(1);
}
const [y, m] = monthArg.split('-').map(Number);
const monthStart = new Date(y, m - 1, 1);
// FIXED 7 Jul 2026, then tightened 24 Jul 2026: cap the CURRENT in-progress month at the START of
// TODAY, not "right now", so manual healing matches the portal's "last complete day only" rule from
// lib/pull.js. Using the literal current timestamp here would let a mid-day repull silently pull a
// partial current day back into the live month even after the main production pull path was fixed.
// FIXED 23 Jul 2026 (production-readiness audit): for CLOSED months, SiteLink's end bound is
// exclusive of the calendar day it lands on, so `new Date(y, m, 0)` would drop the month's final
// day exactly like the old lib/pull.js bug did. Historical healing must therefore end at the START
// of the following day, not midnight at the start of the last day itself.
const now = new Date();
const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const isCurrentMonth = y === now.getFullYear() && m === now.getMonth() + 1;
const closedMonthEndExclusive = new Date(y, m, 1);
const monthEnd = isCurrentMonth ? startOfToday : closedMonthEndExclusive;
const parseEndDate = new Date(monthEnd.getTime() - 1);
const monthKey = `${y}-${String(m).padStart(2, '0')}-01`;

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!locations.length) { console.error('SITELINK_LOCATIONS not set'); process.exit(1); }

console.log(`Deleting existing raw_report rows: report=${reportKey} month=${monthKey}...`);
const { error: delErr, count } = await admin.from('raw_report').delete({ count: 'exact' }).eq('report', reportKey).eq('month', monthKey);
if (delErr) { console.error('Delete failed:', delErr.message); process.exit(1); }
console.log(`Deleted ${count ?? '?'} rows.\n`);

let ok = 0, failed = 0;
for (const loc of locations) {
  try {
    // raw ADDED 7 Jul 2026 (raw-storage change) — see schema.sql / scripts/reparse-report.js.
    const { data, raw } = await pullReport(reportKey, loc, monthStart, monthEnd, { parseEndDate });
    const { error } = await admin.from('raw_report').upsert(
      { site_code: loc, month: monthKey, report: reportKey, data, raw_response: raw ?? null, pulled_at: new Date().toISOString() },
      { onConflict: 'site_code,month,report' });
    if (error) throw new Error(error.message);
    ok++;
    process.stderr.write(`  ${loc}: ok\n`);
  } catch (e) {
    failed++;
    console.error(`  ${loc}: FAILED — ${e.message}`);
  }
}
console.log(`\nRe-pulled ${ok}/${locations.length} sites (${failed} failed).`);

console.log('Rebuilding portal_payload...');
const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const payload = await buildPayload(currentMonthStart, prevMonthStart);
const { error: ppErr } = await admin.from('portal_payload').upsert({ id: 1, generated_at: new Date().toISOString(), payload });
if (ppErr) { console.error('portal_payload write failed:', ppErr.message); process.exit(1); }
console.log('Done — portal_payload rebuilt.');
