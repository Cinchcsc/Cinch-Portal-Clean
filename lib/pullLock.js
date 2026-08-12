// Shared overlap guard for lib/pull.js (kind: 'pull'), lib/pullSnapshot.js (kind: 'snapshot'),
// lib/pullCockpit.js (kind: 'cockpit'), lib/pullFloorOccupancy.js (kind: 'floor'), and
// lib/rebuildPayload.js (kind: 'rebuild').
// Added 10 Jul 2026 (roadmap task #93 — "add overlap guard to /api/pull before re-enabling cron").
// UPDATED 21 Jul 2026: this docstring said only 'pull'/'snapshot' shared the guard, which was true
// when written but went stale the moment cockpit (task #210) and rebuild (task #297/#328) started
// importing checkPullLock/startPullLog/finishPullLog too — all four now go through the exact same
// lock and the exact same refresh_log table.
//
// SiteLink throws -99 "General Exception from LogOn" when the same account logs on in parallel —
// this is an ACCOUNT-level constraint (see lib/pull.js's own comment), not specific to which script
// makes the call. The true SiteLink callers (`pull`, `cockpit`, and `floor`) therefore still share
// one mutual-exclusion group. Snapshot/rebuild no longer call SiteLink directly, but they still use
// this helper so they can block only on the specific running kinds that would make their own reads
// unsafe (today: just `pull`, because it writes the raw_report rows they depend on).
//
// Deliberately a soft, time-based lock (not a hard DB constraint): a 'running' row older than
// STALE_MS is treated as an abandoned/crashed run rather than a live one, so a process that died
// without updating its own row (killed terminal, server restart mid-pull) can't wedge every future
// pull forever. 20 minutes is generous against real-world runtimes observed so far (~77s for the
// 174-call snapshot pull; the full ~378-call monthly pull runs longer but well under 20 min).
import { admin, createAdminClient } from './supabaseAdmin.js';
import { describeError } from './describeError.js';
import { isRetryableSupabaseMessage, retryOnStatementTimeout } from './supabaseRetry.js';

export const STALE_MS = 20 * 60 * 1000;
const REFRESH_LOG_READ_TIMEOUT_MS = 15000;
const REFRESH_LOG_WRITE_TIMEOUT_MS = 15000;

async function withRefreshLogTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTransportRetry(fn, attempts = 5, delayMs = 1500) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error?.message || String(error);
      if (!isRetryableSupabaseMessage(message) || attempt === attempts) throw error;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function runRetriedRefreshLogQuery(fn, timeoutMs, label, attempts = 5, delayMs = 1500) {
  return withTransportRetry(async () => {
    const result = await withRefreshLogTimeout(retryOnStatementTimeout(fn, 1, 0), timeoutMs, label);
    if (result?.error) throw new Error(result.error.message || String(result.error));
    return result;
  }, attempts, delayMs);
}

export async function checkPullLock(options = {}) {
  const activeKinds = Array.isArray(options.activeKinds) && options.activeKinds.length
    ? new Set(options.activeKinds.map((v) => String(v)))
    : null;
  const activeKindList = activeKinds ? [...activeKinds] : null;
  const claimingLogId = Number.isFinite(Number(options.claimingLogId)) ? Number(options.claimingLogId) : null;
  const relevantRunningSince = new Date(Date.now() - (STALE_MS * 2)).toISOString();
  // FIXED 20 Jul 2026 (debug audit of the auto-update pipeline): this only ever looked at the SINGLE
  // MOST RECENT refresh_log row. A stuck 'running' row (Vercel hard-killing a cron mid-run — can't be
  // caught by any try/catch, same mechanism as the 14-16 Jul incidents below) got cleaned up fine AS
  // LONG AS it was still the latest row when the next checkPullLock() call happened — but the moment a
  // LATER cron of a DIFFERENT kind started and inserted its own newer row, the older stuck row was
  // never looked at again and sat as 'running' with no finished_at forever, since every later check
  // only ever asked "what's the single latest row" and got an answer that wasn't the stuck one anymore.
  // Confirmed via check:refresh-log 20 Jul: BOTH that day's and the previous day's 5am pull batch
  // (true_revenue/rental_activity/discounts — task #327) were stuck 'running' for hours, invisible to
  // this cleanup because the 6am/7am/8am crons had each since become "the latest row" in turn. This
  // didn't cause any INCORRECT locking (a fresh row from a different kind correctly isn't stale, so
  // nothing was ever wrongly blocked) — it's purely an observability gap that made refresh_log
  // misleading and hid exactly how often/long task #327's batch was actually dying. Now sweeps EVERY
  // 'running' row each call, not just the latest, marking every stale one 'timeout' — identical
  // locking behavior (only a genuinely-recent running row still blocks), just no longer blind to
  // stale rows once they stop being the most recent.
  let runningRows = null;
  let readErr = null;
  try {
    const result = await runRetriedRefreshLogQuery(async () => {
        const db = createAdminClient();
        let query = db
          .from('refresh_log')
          .select('id,kind,status,started_at')
          .eq('status', 'running')
          .gte('started_at', relevantRunningSince);
        if (activeKindList?.length) query = query.in('kind', activeKindList);
        return query
          .order('started_at', { ascending: false })
          .limit(50);
      },
      REFRESH_LOG_READ_TIMEOUT_MS,
      'refresh_log lock read',
    );
    runningRows = result?.data || [];
    readErr = result?.error || null;
  } catch (error) {
    readErr = error;
  }
  // Continued audit hardening (10 Aug 2026): only rows that started within the last ~40 minutes can
  // possibly matter here. Anything older than STALE_MS is already non-blocking, and keeping another
  // full STALE_MS of headroom still leaves a window to auto-mark freshly-stale rows as timeout. This
  // bounds the lock read to the only rows that can affect the current decision instead of sorting
  // across historical "running" debris forever.
  // ADDED 21 Jul 2026 (cron-timeout investigation follow-up, prompted by Michael's check:refresh-log
  // output): this read had NO error handling at all — `data` on a failed query is undefined, and
  // `runningRows || []` below silently turned that into "nothing is running, go ahead." Real-world
  // evidence this matters: on 20 Jul, TWO 'pull' rows (ids 128/129) started 71s apart (10:44:19 and
  // 10:45:30 UTC) — both later hard-killed by Vercel's maxDuration and stuck at status:'running' for
  // over 21 HOURS before finally being swept (by the 21 Jul 08:13 rebuild cron), instead of the ~20min
  // this lock is designed to self-heal within. Two rows starting that close together is exactly what
  // "the guard didn't block a second start" looks like, and refresh_log independently shows Supabase
  // was genuinely erroring on other queries against this SAME table minutes earlier that morning (rows
  // 125/126, 10:03-10:15 UTC, "canceling statement due to statement timeout") — i.e. Supabase was
  // demonstrably unwell right before this happened, which is exactly when a silent-fail-open read
  // guard is most likely to matter and least likely to be noticed. Failing CLOSED here (treat "can't
  // tell if something's running" as "assume yes, skip this invocation") costs at most one skipped cron
  // hour on the rare occasions the read itself fails — self-healing, since every report group gets
  // pulled again on its next scheduled day regardless — versus the alternative of silently allowing a
  // second heavy pull to start on top of one that may still be running.
  if (readErr) {
    console.error('[pullLock] refresh_log read failed — failing closed (treating as locked):', readErr.message);
    return { locked: true, message: `Could not confirm whether another pull is already running (refresh_log read failed: ${readErr.message}) — refusing to start rather than risk two overlapping pulls.` };
  }
  let active = null;
  for (const row of runningRows || []) {
    const rowKind = String(row.kind || 'pull');
    const rowId = Number(row.id) || 0;
    if (claimingLogId && rowId === claimingLogId) continue;
    // When a caller has already inserted its own running row and is re-checking the lock to break
    // a near-simultaneous-start race, only EARLIER rows are allowed to block it. Later rows are
    // sibling claimants that started after this caller and should lose to the earlier claimant.
    if (claimingLogId && rowId > claimingLogId) continue;
    const ageMs = Date.now() - new Date(row.started_at).getTime();
    if (ageMs < STALE_MS) {
      if (!active && (!activeKinds || activeKinds.has(rowKind))) active = { row: { ...row, kind: rowKind }, ageMs };
      continue;
    }
    // FIXED 16 Jul 2026 (task #295 follow-up): a 'running' row past STALE_MS was already treated as
    // not-locked (see the fall-through below) but was left at status='running' in the DB forever —
    // diagnosing task #295 (Autobill Conversion stale samples) meant piecing this together by hand
    // from refresh_log timestamps because nothing recorded that these runs had actually died. Found 3
    // so far (14, 15, and 16 Jul), always the day's last pull batch to fire — almost certainly Vercel's
    // maxDuration killing the function mid-buildPayload(): the per-site raw_report writes earlier in
    // the same run consistently finish fine (confirmed via their pulled_at timestamps), it's
    // specifically the final portfolio-payload rebuild at the end of runPull() that runs out of
    // budget, and a hard platform kill can't be caught by any try/catch to call finishPullLog() itself.
    // Mark it explicitly instead of leaving it to rot, best-effort — this only touches a row already
    // being treated as unlocked, so it can't introduce a new blocking/race behavior.
    try {
      const db = createAdminClient();
      await runRetriedRefreshLogQuery(async () => db.from('refresh_log').update({
          status: 'timeout',
          finished_at: new Date().toISOString(),
          detail: `auto-marked stale after ~${Math.round(ageMs / 60000)}m with no finish — likely Vercel's function timeout killing the run mid-buildPayload() (see lib/pull.js's runPull())`,
        }).eq('id', row.id),
        REFRESH_LOG_WRITE_TIMEOUT_MS,
        'refresh_log stale-row update',
      );
    } catch (error) {
      console.error('[pullLock] failed to mark stale running row as timeout:', error?.message || error);
    }
  }
  if (active) {
    const mins = Math.round(active.ageMs / 60000);
    return {
      locked: true,
      kind: active.row.kind || 'pull',
      startedAt: active.row.started_at,
      ageMs: active.ageMs,
      staleMs: STALE_MS,
      message: `Another ${active.row.kind || 'pull'} has been running for ~${mins}m (started ${active.row.started_at}) — refusing to start a second one. SiteLink rejects concurrent logons on the same account (-99), and overlapping writes to the same rows would race. If this is actually a stale/crashed run, it auto-clears ${STALE_MS / 60000} minutes after it started.`,
    };
  }
  return { locked: false };
}

export async function startPullLog(kind) {
  // Stamp started_at from the same app clock that finishPullLog() uses for finished_at so refresh_log
  // durations cannot go negative when Supabase's clock is a second ahead of the runtime host.
  const db = createAdminClient();
  const { data: logRow } = await runRetriedRefreshLogQuery(
    async () => db.from('refresh_log').insert({ status: 'running', kind, started_at: new Date().toISOString() }).select('id').single(),
    REFRESH_LOG_WRITE_TIMEOUT_MS,
    'refresh_log insert',
  );
  return logRow?.id;
}

export async function startPullLogLenient(kind, contextLabel = kind) {
  try {
    return await startPullLog(kind);
  } catch (error) {
    const message = describeError(error);
    if (!isRetryableSupabaseMessage(message)) throw error;
    // Production hardening (28 Jul 2026): transient Supabase/Cloudflare 52x failures against the
    // observability table should not prevent the REAL refresh work from even starting. We still try
    // to log every run, but if the refresh_log insert itself is what's failing under temporary DB
    // pressure, proceed without a row and let the underlying pull/rebuild succeed rather than leaving
    // the portal stale for a whole day. finishPullLog() already no-ops on a missing logId.
    console.warn(`[pullLock] ${contextLabel} refresh_log insert failed under transient DB pressure; continuing without a log row: ${message}`);
    return null;
  }
}

export async function finishPullLog(logId, status, detail) {
  if (!logId) return;
  try {
    const db = createAdminClient();
    await runRetriedRefreshLogQuery(
      async () => db.from('refresh_log').update({ finished_at: new Date().toISOString(), status, detail: detail ?? null }).eq('id', logId),
      REFRESH_LOG_WRITE_TIMEOUT_MS,
      'refresh_log finish update',
    );
  } catch (error) {
    console.error('[pullLock] failed to finish refresh_log row:', error.message);
  }
}

export async function recordCompletedPullLog(kind, status, detail, startedAt = new Date().toISOString()) {
  try {
    const db = createAdminClient();
    await runRetriedRefreshLogQuery(
      async () => db.from('refresh_log').insert({
        kind,
        status,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        detail: detail ?? null,
      }),
      REFRESH_LOG_WRITE_TIMEOUT_MS,
      'refresh_log completed-row insert',
    );
  } catch (error) {
    console.error('[pullLock] failed to backfill completed refresh_log row:', error?.message || error);
  }
}
