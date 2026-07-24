// Full historical re-pull for ONE report across EVERY stored month — built to fix the Self Storage
// / Total Real Rate gap: rent_roll.parse() didn't compute self_storage.area_sum/rent_sum/std_rent_sum/
// real_rate_per_sqft_ann until 6 Jul 2026, so every month locked before that date is missing those
// fields forever (see check-rentroll-raw-shape.js). Michael confirmed (6 Jul) that SiteLink's
// RentRoll report DOES return genuine historical "as of" data for a requested past date/range — so,
// unlike the earlier "point-in-time snapshot only" assumption, re-pulling old months is safe and will
// capture real historical numbers, not today's live state relabelled.
// This is the same delete+re-pull technique as repull-report-month.js, just looped over every month
// currently in raw_report instead of one. Runs SEQUENTIALLY (concurrency 1) — SiteLink throws -99
// "General Exception from LogOn" on parallel logons for the same account, confirmed in lib/pull.js —
// with the same [0, 2000, 5000]ms retry backoff used there. With ~122 months x 27 sites this is a LOT
// of SiteLink calls and will take a long time (likely 1-3+ hours) — expect it to run for a while and
// consider running it in the background / overnight.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/repull-report-all-months.js <report>
// Example: node --env-file=.env scripts/repull-report-all-months.js rent_roll
import { admin } from '../lib/supabaseAdmin.js';
import { pullReport } from '../lib/reportMap.js';
import { buildPayload, listStoredMonths } from '../lib/buildPayload.js';

const reportKey = process.argv[2];
if (!reportKey) { console.error('Usage: node scripts/repull-report-all-months.js <report>'); process.exit(1); }

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!locations.length) { console.error('SITELINK_LOCATIONS not set'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tryPull(key, loc, start, end) {
  const backoff = [0, 2000, 5000];
  const parseEndDate = new Date(end.getTime() - 1);
  for (let attempt = 1; ; attempt++) {
    try { return await pullReport(key, loc, start, end, { parseEndDate }); }
    catch (e) { if (attempt >= backoff.length) throw e; await sleep(backoff[attempt]); }
  }
}

const months = await listStoredMonths();
console.log(`Re-pulling '${reportKey}' for ${months.length} stored months x ${locations.length} sites = ${months.length * locations.length} calls.`);
console.log('This runs sequentially and will take a while — progress is logged per month.\n');

// FIXED 7 Jul 2026, then tightened 24 Jul 2026: cap the CURRENT in-progress month at the START of
// TODAY, not "right now", so a manual full-history healing run cannot reintroduce partial-current-day
// data into the live month after lib/pull.js was fixed to stop at the last complete day. This still
// prevents the older "future date" corruption too.
// FIXED 23 Jul 2026 (production-readiness audit): for CLOSED months, SiteLink's end bound is
// exclusive of the calendar day it lands on, so `new Date(y, m, 0)` would re-import every past month
// with its final day missing — the exact bug this script is often used to heal. Closed months must
// therefore end at the start of the FOLLOWING day instead.
const now0 = new Date();
const startOfToday = new Date(now0.getFullYear(), now0.getMonth(), now0.getDate());
let totalOk = 0, totalFailed = 0;
const startedAt = Date.now();
for (let i = 0; i < months.length; i++) {
  const mk = months[i];
  const [y, m] = mk.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const isCurrentMonth = y === now0.getFullYear() && m === now0.getMonth() + 1;
  const closedMonthEndExclusive = new Date(y, m, 1);
  const monthEnd = isCurrentMonth ? startOfToday : closedMonthEndExclusive;
  const monthKey = `${y}-${String(m).padStart(2, '0')}-01`;

  const { error: delErr } = await admin.from('raw_report').delete().eq('report', reportKey).eq('month', monthKey);
  if (delErr) { console.error(`[${mk}] delete failed: ${delErr.message} — skipping month`); continue; }

  let ok = 0, failed = 0;
  for (const loc of locations) {
    try {
      // raw ADDED 7 Jul 2026 (raw-storage change) — see schema.sql / scripts/reparse-report.js.
      const { data, raw } = await tryPull(reportKey, loc, monthStart, monthEnd);
      const { error } = await admin.from('raw_report').upsert(
        { site_code: loc, month: monthKey, report: reportKey, data, raw_response: raw ?? null, pulled_at: new Date().toISOString() },
        { onConflict: 'site_code,month,report' });
      if (error) throw new Error(error.message);
      ok++;
    } catch (e) { failed++; console.error(`  [${mk}] ${loc}: FAILED — ${e.message}`); }
  }
  totalOk += ok; totalFailed += failed;
  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`[${i + 1}/${months.length}] ${mk}: ${ok}/${locations.length} sites ok (${failed} failed)  — ${elapsedMin}min elapsed`);
}

console.log(`\nDone. ${totalOk} site-months ok, ${totalFailed} failed. Rebuilding portal_payload...`);
const now = new Date();
const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const payload = await buildPayload(currentMonthStart, prevMonthStart);
const { error: ppErr } = await admin.from('portal_payload').upsert({ id: 1, generated_at: new Date().toISOString(), payload });
if (ppErr) { console.error('portal_payload write failed:', ppErr.message); process.exit(1); }
console.log('portal_payload rebuilt.');
process.exit(0);
