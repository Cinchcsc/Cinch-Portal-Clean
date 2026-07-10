// Task #59 — combines check-rentroll-gaps.js (find months where a report is entirely missing,
// using occupancy's full month coverage as the reference — same logic, same definition of "gap") with
// repull-report-month.js (re-pull one report/month across all sites) into a single script, so
// backfilling doesn't mean copy-pasting N individual repull commands by hand.
// Defaults to rent_roll; check-backfill-coverage.js found several OTHER reports short of occupancy's
// full history too (scheduled_outs, marketing, rate_changes, true_revenue, reservations) — pass one of
// those as an argument to backfill ITS gaps the same way.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/backfill-rentroll-gaps.js [report]
// Example: node --env-file=.env scripts/backfill-rentroll-gaps.js true_revenue
import { admin } from '../lib/supabaseAdmin.js';
import { pullReport } from '../lib/reportMap.js';
import { buildPayload } from '../lib/buildPayload.js';
import { checkPullLock, startPullLog, finishPullLog } from '../lib/pullLock.js';

const reportKey = process.argv[2] || 'rent_roll';
const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!locations.length) { console.error('SITELINK_LOCATIONS not set'); process.exit(1); }

// Shares the same lock as npm run pull / pull:snapshot (10 Jul 2026 — this script didn't have it when
// first written, an oversight given SiteLink rejects concurrent logons on the same account exactly
// like those two do). Multi-hour backfill runs are exactly the case this guard exists for.
const lock = await checkPullLock();
if (lock.locked) { console.error('[backfill-rentroll-gaps] ' + lock.message); process.exit(1); }
const logId = await startPullLog('backfill-rentroll-gaps');

// Everything below runs inside a try/catch so ANY failure — including ones that used to call
// process.exit(1) directly mid-function (e.g. fetchAllMonths' Supabase error path) — still reaches
// finishPullLog() before the process exits. Without this, a failure would leave the refresh_log row
// stuck at status:'running' for up to 20min (checkPullLock()'s staleness auto-clear), needlessly
// blocking a legitimate npm run pull / pull:snapshot in the meantime.
try {
  const PAGE = 1000;
  async function fetchAllMonths(rep) {
    let all = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin.from('raw_report').select('month').eq('report', rep).range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      all = all.concat(data);
      if (!data || data.length < PAGE) break;
    }
    return new Set(all.map((r) => String(r.month).slice(0, 7)));
  }

  console.log(`Scanning for months missing '${reportKey}' entirely (vs occupancy's full coverage)...`);
  const occMonths = await fetchAllMonths('occupancy');
  const repMonths = await fetchAllMonths(reportKey);
  const missing = [...occMonths].filter((mk) => !repMonths.has(mk)).sort();
  console.log(`occupancy: ${occMonths.size} months, ${reportKey}: ${repMonths.size} months — ${missing.length} missing month(s) to backfill.\n`);
  if (!missing.length) {
    console.log('Nothing to do.');
    await finishPullLog(logId, 'ok', 'no gaps found');
    process.exit(0);
  }
  console.log(missing.join(', ') + '\n');
  console.log(`${locations.length} sites x ${missing.length} months = ${locations.length * missing.length} calls (sequential — SiteLink rejects parallel logons).\n`);

  const now = new Date();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function tryPull(key, loc, start, end) {
    const backoff = [0, 2000, 5000];
    for (let attempt = 1; ; attempt++) {
      try { return await pullReport(key, loc, start, end); }
      catch (e) { if (attempt >= backoff.length) throw e; await sleep(backoff[attempt]); }
    }
  }

  let ok = 0, failed = 0;
  const startedAt = Date.now();
  for (const mk of missing) {
    const [y, m] = mk.split('-').map(Number);
    const monthStart = new Date(y, m - 1, 1);
    // Same "cap the in-progress current month at today" rule as pull.js/repull-report-month.js — a
    // gap this old is very unlikely to BE the current month, but keep the guard for correctness anyway.
    const isCurrentMonth = y === now.getFullYear() && m === now.getMonth() + 1;
    const fullMonthEnd = new Date(y, m, 0);
    const monthEnd = isCurrentMonth && fullMonthEnd > now ? now : fullMonthEnd;
    const monthKey = `${y}-${String(m).padStart(2, '0')}-01`;

    for (const loc of locations) {
      try {
        const { data, raw } = await tryPull(reportKey, loc, monthStart, monthEnd);
        const { error } = await admin.from('raw_report').upsert(
          { site_code: loc, month: monthKey, report: reportKey, data, raw_response: raw ?? null, pulled_at: new Date().toISOString() },
          { onConflict: 'site_code,month,report' });
        if (error) throw new Error(error.message);
        ok++;
      } catch (e) {
        failed++;
        console.error(`  ${mk}/${loc}: FAILED — ${e.message}`);
      }
    }
    console.log(`[${mk}] done — ${ok} ok / ${failed} failed so far (${((Date.now() - startedAt) / 60000).toFixed(1)}min elapsed)`);
  }

  console.log(`\nBackfill complete: ${ok} ok, ${failed} failed. Rebuilding portal_payload...`);
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const payload = await buildPayload(currentMonthStart, prevMonthStart);
  const { error: ppErr } = await admin.from('portal_payload').upsert({ id: 1, generated_at: new Date().toISOString(), payload });
  if (ppErr) throw new Error(`portal_payload write failed: ${ppErr.message}`);
  console.log('Done — portal_payload rebuilt.');
  await finishPullLog(logId, failed > ok ? 'error' : 'ok', `${ok} ok, ${failed} failed`);
  process.exit(failed > ok ? 1 : 0);
} catch (e) {
  console.error('[backfill-rentroll-gaps] fatal:', e.message);
  await finishPullLog(logId, 'error', e.message);
  process.exit(1);
}
