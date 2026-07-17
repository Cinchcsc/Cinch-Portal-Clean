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
import { checkPullLock, startPullLog, finishPullLog } from './pullLock.js';
import { describeError } from './describeError.js';

const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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

export async function runCockpitPull({ concurrency = Number(process.env.SITELINK_PULL_CONCURRENCY) || 1 } = {}) {
  // Shares the same overlap guard as every other pull path — see lib/pullLock.js's header for why a
  // Cockpit pull and a main/snapshot pull can't safely run at once (same SiteLink account, same -99
  // concurrent-logon conflict).
  const lock = await checkPullLock();
  if (lock.locked) { console.error('[pull-cockpit] ' + lock.message); return { status: 'skipped', message: lock.message }; }

  const started = Date.now();
  const logId = await startPullLog('cockpit');
  const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!locations.length) { await finishPullLog(logId, 'error', 'SITELINK_LOCATIONS not set'); throw new Error('SITELINK_LOCATIONS not set'); }

  try {
    const yesterday = dayOnly(addDays(new Date(), -1));
    const monthStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), 1);
    console.error(`[pull-cockpit] ${locations.length} sites — month-to-date ${ymd(monthStart)} to ${ymd(yesterday)}...`);

    let next = 0, ok = 0, failed = 0;
    const errors = [];   // ADDED 15 Jul 2026: refresh_log's detail only ever stored the "X ok, Y
    // failed" summary, not what actually went wrong — useless for diagnosing a 0-ok/29-failed run
    // without digging through Vercel's function logs. Mirrors lib/pull.js's own `errors` array/detail
    // convention so `npm run check:refresh-log` can show the real per-site error text going forward.
    const worker = async () => {
      while (next < locations.length) {
        const loc = locations[next++];
        try {
          const { rows } = await tryCall('FinancialSummary', loc, monthStart, yesterday);
          const parsed = REPORTS.financial.parse(rows);
          // total_credit — ADDED 17 Jul 2026 (task #312): REPORTS.financial.parse() already computes
          // this (see lib/reportMap.js's `financial` parser), it just wasn't being saved here. Needed
          // so the daily curve can compute the SAME "Revenue Collected" definition used everywhere
          // else on the portal (Charge minus Credit — see buildPayload.js's revenue.collected), not
          // just raw total_charge on its own.
          const { error } = await admin.from('daily_financial_snapshot').upsert(
            {
              site_code: loc, snapshot_date: ymd(yesterday),
              total_charge: parsed.total_charge, total_payment: parsed.total_payment,
              total_credit: parsed.total_credit || 0,
              categories: parsed.categories, pulled_at: new Date().toISOString(),
            },
            { onConflict: 'site_code,snapshot_date' },
          );
          if (error) throw new Error(error.message);
          ok++;
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
    const detail = `${ok} ok, ${failed} failed` + (errors.length ? ' | ' + errors.slice(0, 10).join(' | ') : '');
    await finishPullLog(logId, failed > ok ? 'error' : 'ok', detail);
    return { status: failed > ok ? 'error' : 'ok', durationMs: Date.now() - started, sites: locations.length, ok, failed, snapshotDate: ymd(yesterday) };
  } catch (e) {
    await finishPullLog(logId, 'error', describeError(e));
    throw e;
  }
}
