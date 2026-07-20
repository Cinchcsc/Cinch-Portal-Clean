// Shared overlap guard for lib/pull.js (kind: 'pull') and lib/pullSnapshot.js (kind: 'snapshot').
// Added 10 Jul 2026 (roadmap task #93 — "add overlap guard to /api/pull before re-enabling cron").
//
// SiteLink throws -99 "General Exception from LogOn" when the same account logs on in parallel —
// this is an ACCOUNT-level constraint (see lib/pull.js's own comment), not specific to which script
// makes the call. That means a main pull and a snapshot pull running at the same time hit the exact
// same conflict as two main pulls overlapping, or a manual `npm run pull` colliding with a cron-
// triggered one. So this is ONE shared lock across both pull types, not two independent ones — both
// read/write the same refresh_log table, keyed by whichever the most recent row is regardless of kind.
//
// Deliberately a soft, time-based lock (not a hard DB constraint): a 'running' row older than
// STALE_MS is treated as an abandoned/crashed run rather than a live one, so a process that died
// without updating its own row (killed terminal, server restart mid-pull) can't wedge every future
// pull forever. 20 minutes is generous against real-world runtimes observed so far (~77s for the
// 174-call snapshot pull; the full ~378-call monthly pull runs longer but well under 20 min).
import { admin } from './supabaseAdmin.js';

const STALE_MS = 20 * 60 * 1000;

export async function checkPullLock() {
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
  const { data: runningRows } = await admin.from('refresh_log').select('id,kind,status,started_at').eq('status', 'running').order('started_at', { ascending: false });
  let active = null;
  for (const row of runningRows || []) {
    const ageMs = Date.now() - new Date(row.started_at).getTime();
    if (ageMs < STALE_MS) { if (!active) active = { row, ageMs }; continue; }
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
    const { error: markErr } = await admin.from('refresh_log').update({
      status: 'timeout',
      finished_at: new Date().toISOString(),
      detail: `auto-marked stale after ~${Math.round(ageMs / 60000)}m with no finish — likely Vercel's function timeout killing the run mid-buildPayload() (see lib/pull.js's runPull())`,
    }).eq('id', row.id);
    if (markErr) console.error('[pullLock] failed to mark stale running row as timeout:', markErr.message);
  }
  if (active) {
    const mins = Math.round(active.ageMs / 60000);
    return {
      locked: true,
      message: `Another ${active.row.kind || 'pull'} has been running for ~${mins}m (started ${active.row.started_at}) — refusing to start a second one. SiteLink rejects concurrent logons on the same account (-99), and overlapping writes to the same rows would race. If this is actually a stale/crashed run, it auto-clears ${STALE_MS / 60000} minutes after it started.`,
    };
  }
  return { locked: false };
}

export async function startPullLog(kind) {
  const { data: logRow } = await admin.from('refresh_log').insert({ status: 'running', kind }).select('id').single();
  return logRow?.id;
}

export async function finishPullLog(logId, status, detail) {
  if (!logId) return;
  await admin.from('refresh_log').update({ finished_at: new Date().toISOString(), status, detail: detail ?? null }).eq('id', logId);
}
