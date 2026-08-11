// Cockpit Charting (task #174/#207, from Michael's live Qstrom DM screenshots: daily cumulative
// income-by-category within the current month, plotted against a 3-month-average pace line).
//
// Deliberately a DIFFERENT shape from lib/pullSnapshot.js's daily/weekly/quarterly "period query" —
// see supabase/schema.sql's daily_financial_snapshot comment for why. One FinancialSummary call per
// site per day, range = [start of that day's month, that day] — so the running month-to-date total
// on ANY given day is captured directly, and the full day-by-day curve builds up for free across the
// month purely by running once daily; no re-pulling of earlier days, no N-calls-per-day cost.
//
// "Yesterday", not "today": matches lib/pullSnapshot.js's existing convention exactly, and for the
// same reason — the day this cron actually runs (early morning) has barely started, so treating
// "today" as a data point would record a near-zero value that gets silently corrected the next day,
// looking like a discontinuity in the chart. Anchoring to yesterday means every stored point is a
// genuinely settled, complete day.
//
// Month-boundary behavior falls out naturally: on the 1st of a month, "yesterday" is the LAST day of
// the PREVIOUS month, so that day's row is [previous month start, previous month end] — a correct
// final settle point for the month that just closed. The day after that, "yesterday" is the 1st of
// the NEW month, so the window collapses to a single day and the curve restarts from zero — no
// special-cased "new month" branch needed anywhere below.
//
// Run manually: npm run pull:cockpit (no timeout — plain Node script).
// Or via HTTP: GET /api/pull-cockpit (scheduled daily via vercel.json).
import { admin } from './supabaseAdmin.js';
import { REPORTS } from './reportMap.js';
import { callReport } from './sitelink.js';
import { STALE_MS, checkPullLock, startPullLogLenient, finishPullLog } from './pullLock.js';
import { describeError } from './describeError.js';
import { formatLocalYmd, lastCompleteDay } from './reportingPeriod.js';
import { retryOnStatementTimeout } from './supabaseRetry.js';

const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const ymd = (d) => formatLocalYmd(d);
const MAX_BACKFILL_DATES_PER_RUN = 5;

function cockpitRepairWindowStart(yesterday) {
  const start = new Date(yesterday.getFullYear(), yesterday.getMonth(), 1);
  if (yesterday.getDate() <= MAX_BACKFILL_DATES_PER_RUN) {
    start.setDate(start.getDate() - MAX_BACKFILL_DATES_PER_RUN);
  }
  return start;
}

async function targetCockpitSnapshotDates(locations, repairStart, yesterday) {
  const { data, error } = await retryOnStatementTimeout(async () => admin
    .from('daily_financial_snapshot')
    .select('snapshot_date,site_code')
    .gte('snapshot_date', ymd(repairStart))
    .lte('snapshot_date', ymd(yesterday))
    .order('snapshot_date'));
  if (error) throw new Error(error.message);

  const completeDates = new Set();
  const byDate = new Map();
  for (const row of data || []) {
    const dateKey = String(row?.snapshot_date || '');
    if (!dateKey) continue;
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Set());
    if (row?.site_code) byDate.get(dateKey).add(row.site_code);
  }
  for (const [dateKey, siteCodes] of byDate.entries()) {
    if (siteCodes.size >= locations.length) completeDates.add(dateKey);
  }

  const missingOlderDates = [];
  for (const day = new Date(repairStart); day.getTime() < yesterday.getTime(); day.setDate(day.getDate() + 1)) {
    const dateKey = ymd(day);
    if (!completeDates.has(dateKey)) missingOlderDates.push(new Date(day));
  }

  const targetMap = new Map();
  for (const day of missingOlderDates.slice(0, MAX_BACKFILL_DATES_PER_RUN)) targetMap.set(ymd(day), new Date(day));
  targetMap.set(ymd(yesterday), new Date(yesterday));
  return [...targetMap.values()].sort((a, b) => a.getTime() - b.getTime());
}

async function waitForUnlocked(maxWaitMs = 4 * 60 * 1000, pollMs = 15 * 1000) {
  const started = Date.now();
  let lastMessage = null;
  for (;;) {
    const lock = await checkPullLock({ activeKinds: ['pull', 'cockpit', 'floor'] });
    if (!lock.locked) return { ok: true };
    lastMessage = lock.message || 'Another refresh job is still running.';
    const waitedMs = Date.now() - started;
    const remainingBudgetMs = maxWaitMs - waitedMs;
    const staleRemainingMs = typeof lock.ageMs === 'number'
      ? Math.max(0, (lock.staleMs || STALE_MS) - lock.ageMs)
      : null;
    const nextWaitMs = staleRemainingMs == null
      ? pollMs
      : Math.min(pollMs, Math.max(1000, staleRemainingMs + 1000));
    if (remainingBudgetMs < nextWaitMs) return { ok: false, message: lastMessage };
    console.error(`[pull-cockpit] lock still held — waiting ${Math.round(nextWaitMs / 1000)}s before retrying...`);
    await new Promise((res) => setTimeout(res, nextWaitMs));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Same one-retry backoff as lib/pull.js / lib/pullSnapshot.js — absorbs SiteLink's transient -99
// logon / -90 busy / timeouts.
async function tryCall(method, loc, start, end) {
  const backoff = [0, 2000, 5000];
  for (let attempt = 1; ; attempt++) {
    try { return await callReport(method, loc, start, end); }
    catch (e) { if (attempt >= backoff.length) throw e; await sleep(backoff[attempt]); }
  }
}

export async function runCockpitPull({ concurrency = Number(process.env.SITELINK_PULL_CONCURRENCY) || 1, triggerLabel = null } = {}) {
  // Shares the same overlap guard as every other pull path — see lib/pullLock.js's header for why a
  // Cockpit pull and a main/snapshot pull can't safely run at once (same SiteLink account, same -99
  // concurrent-logon conflict).
  const started = Date.now();
  const unlocked = await waitForUnlocked();
  if (!unlocked.ok) {
    const blockedLogId = await startPullLogLenient('cockpit', 'cockpit skip');
    console.error('[pull-cockpit] ' + unlocked.message);
    await finishPullLog(blockedLogId, 'skipped', unlocked.message);
    return { status: 'skipped', message: unlocked.message };
  }
  const logId = await startPullLogLenient('cockpit', 'cockpit');
  const claimedLock = await checkPullLock({ activeKinds: ['pull', 'cockpit', 'floor'], claimingLogId: logId });
  if (claimedLock.locked) {
    console.error('[pull-cockpit] ' + claimedLock.message);
    await finishPullLog(logId, 'skipped', claimedLock.message);
    return { status: 'skipped', message: claimedLock.message };
  }
  const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!locations.length) { await finishPullLog(logId, 'error', 'SITELINK_LOCATIONS not set'); throw new Error('SITELINK_LOCATIONS not set'); }

  try {
    const yesterday = dayOnly(lastCompleteDay(new Date()));
    const repairStart = cockpitRepairWindowStart(yesterday);
    const targetDates = await targetCockpitSnapshotDates(locations, repairStart, yesterday);
    console.error(`[pull-cockpit] ${locations.length} sites — repair window ${ymd(repairStart)} to ${ymd(yesterday)} across ${targetDates.map((d) => ymd(d)).join(', ')}...`);

    let next = 0, ok = 0, failed = 0;
    const errors = [];   // ADDED 15 Jul 2026: refresh_log's detail only ever stored the "X ok, Y
    // failed" summary, not what actually went wrong — useless for diagnosing a 0-ok/29-failed run
    // without digging through Vercel's function logs. Mirrors lib/pull.js's own `errors` array/detail
    // convention so `npm run check:refresh-log` can show the real per-site error text going forward.
    const worker = async () => {
      while (next < locations.length) {
        const loc = locations[next++];
        try {
          for (const targetDate of targetDates) {
            const targetMonthStart = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
            const { rows } = await tryCall('FinancialSummary', loc, targetMonthStart, targetDate);
            const parsed = REPORTS.financial.parse(rows);
            // total_credit — ADDED 17 Jul 2026 (task #312): REPORTS.financial.parse() already computes
            // this (see lib/reportMap.js's `financial` parser), it just wasn't being saved here. Needed
            // so the daily curve can compute the SAME "Revenue Collected" definition used everywhere
            // else on the portal (Charge minus Credit — see buildPayload.js's revenue.collected), not
            // just raw total_charge on its own.
            const { error } = await retryOnStatementTimeout(async () => admin.from('daily_financial_snapshot').upsert(
              {
                site_code: loc, snapshot_date: ymd(targetDate),
                total_charge: parsed.total_charge, total_payment: parsed.total_payment,
                total_credit: parsed.total_credit || 0,
                categories: parsed.categories, pulled_at: new Date().toISOString(),
              },
              { onConflict: 'site_code,snapshot_date' },
            ));
            if (error) throw new Error(error.message);
            ok++;
          }
        } catch (e) {
          failed++;
          const msg = describeError(e);
          console.error(`  ${loc}: FAILED — ${msg}`);
          errors.push(`${loc}: ${msg}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, locations.length) }, worker));

    console.error(`[pull-cockpit] done — ${ok} ok, ${failed} failed`);
    const status = failed > ok ? 'error' : (failed ? 'partial' : 'ok');
    const detail = [
      triggerLabel ? `trigger=${triggerLabel}` : null,
      `dates=${targetDates.map((d) => ymd(d)).join(',')}`,
      `${ok} ok, ${failed} failed`,
      errors.length ? errors.slice(0, 10).join(' | ') : null,
    ].filter(Boolean).join(' | ');
    await finishPullLog(logId, status, detail);
    return { status, durationMs: Date.now() - started, sites: locations.length, ok, failed, snapshotDate: ymd(yesterday), repairedDates: targetDates.map((d) => ymd(d)) };
  } catch (e) {
    await finishPullLog(logId, 'error', describeError(e));
    throw e;
  }
}
