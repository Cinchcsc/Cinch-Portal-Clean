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

// ADDED 20 Jul 2026: buildPayload()+the upsert below started failing with "canceling statement due to
// statement timeout" — first inline at the tail of a reparse-report.js run (2059 raw_report updates
// just before it), then AGAIN minutes later on a completely fresh, standalone `npm run rebuild:payload`
// (31809ms) with nothing else running — ruling out "just contention from those updates" as the sole
// explanation, since the second attempt had no updates running alongside it. Likely contributor:
// buildIndex()'s fetchAllRaw() (lib/buildPayload.js) intentionally scans raw_report's ENTIRE unfiltered
// history on every single call — `monthly`/`history` need every month ever pulled, and that table only
// grows (daily crons + every backfill), so the scan+transfer gets heavier over time with no ceiling,
// and is apparently now sitting close enough to Supabase's statement-timeout edge that it sometimes
// crosses it (see probe-rawreport-growth.js for the actual row-count/size evidence). The clean
// 49.575s success earlier the same day (via the live /api/rebuild-payload curl test) vs. a FASTER
// 31809ms failure afterward points to load-dependent variance rather than a fixed cost line always
// being crossed — exactly the kind of failure a retry rides out, same pattern already proven for this
// identical error in reparse-report.js and probe-leadfunnel-table-selection.js. This is a mitigation,
// not a fix for the underlying full-history-scan cost growing indefinitely — see that probe script and
// task #329 for the real long-term architecture question.
async function withRetry(fn, attempts = 3, delayMs = 3000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        console.error(`[rebuild-payload] attempt ${i + 1}/${attempts} failed (${e.message}) — retrying in ${delayMs}ms...`);
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }
  }
  throw lastErr;
}

export async function runRebuildPayload() {
  const lock = await checkPullLock();
  if (lock.locked) { console.error('[rebuild-payload] ' + lock.message); return { status: 'skipped', message: lock.message }; }

  const started = Date.now();
  const logId = await startPullLog('rebuild');
  try {
    const now = new Date();
    const curStart = firstOfMonth(now);
    const prevStart = firstOfMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    // Retries the WHOLE build+write together (not just the upsert) — cheap to just recompute the
    // payload fresh on a retry, and self-correcting if underlying data changed between attempts.
    // 3 attempts x up to ~60s observed worst case + 2 x 3s delays comfortably fits the route's 300s
    // maxDuration even in the worst case where every attempt is slow.
    await withRetry(async () => {
      const payload = await buildPayload(curStart, prevStart);
      const { error } = await admin.from('portal_payload').upsert({ id: 1, generated_at: new Date().toISOString(), payload });
      if (error) throw new Error(error.message);
    });
    await finishPullLog(logId, 'ok', null);
    return { status: 'ok', durationMs: Date.now() - started };
  } catch (e) {
    await finishPullLog(logId, 'error', describeError(e));
    return { status: 'error', message: e.message, durationMs: Date.now() - started };
  }
}
