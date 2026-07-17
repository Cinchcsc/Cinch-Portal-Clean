// Dedicated portal_payload rebuild, split out of lib/pull.js's runPull() — task #297 fix, 17 Jul 2026.
// See lib/pull.js's `rebuildPayload` option comment for the full root-cause explanation: this used to
// run inline at the end of every runPull() cron invocation, sharing that same call's 300s Vercel
// maxDuration budget with its SiteLink report-pulling — and has been observed dying mid-rebuild on the
// day's last cron batch 3 days running (14-16 Jul, refresh_log). buildPayload() makes ZERO SiteLink
// calls (it only reads already-stored raw_report rows and recomputes), so it doesn't share pull.js's
// reason for needing the shared lock (SiteLink's -99 concurrent-logon conflict) — but this still checks
// it defensively, logged under its own 'rebuild' kind, so it never reads a half-written raw_report row
// out from under a pull that's unexpectedly still running, and shows up distinctly in
// npm run check:refresh-log rather than blending into 'pull'.
import { admin } from './supabaseAdmin.js';
import { buildPayload } from './buildPayload.js';
import { checkPullLock, startPullLog, finishPullLog } from './pullLock.js';
import { describeError } from './describeError.js';

const firstOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

export async function runRebuildPayload() {
  const lock = await checkPullLock();
  if (lock.locked) { console.error('[rebuild-payload] ' + lock.message); return { status: 'skipped', message: lock.message }; }

  const started = Date.now();
  const logId = await startPullLog('rebuild');
  try {
    const now = new Date();
    const curStart = firstOfMonth(now);
    const prevStart = firstOfMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const payload = await buildPayload(curStart, prevStart);
    const { error } = await admin.from('portal_payload').upsert({ id: 1, generated_at: new Date().toISOString(), payload });
    if (error) throw new Error(error.message);
    await finishPullLog(logId, 'ok', null);
    return { status: 'ok', durationMs: Date.now() - started };
  } catch (e) {
    await finishPullLog(logId, 'error', describeError(e));
    return { status: 'error', message: e.message, durationMs: Date.now() - started };
  }
}
