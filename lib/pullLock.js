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
  const { data: last } = await admin.from('refresh_log').select('id,kind,status,started_at').order('started_at', { ascending: false }).limit(1).maybeSingle();
  if (last && last.status === 'running' && (Date.now() - new Date(last.started_at).getTime()) < STALE_MS) {
    const mins = Math.round((Date.now() - new Date(last.started_at).getTime()) / 60000);
    return {
      locked: true,
      message: `Another ${last.kind || 'pull'} has been running for ~${mins}m (started ${last.started_at}) — refusing to start a second one. SiteLink rejects concurrent logons on the same account (-99), and overlapping writes to the same rows would race. If this is actually a stale/crashed run, it auto-clears ${STALE_MS / 60000} minutes after it started.`,
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
