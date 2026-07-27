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
import { buildPayload, buildPayloadRange, PORTAL_PAYLOAD_BUILD_VERSION, PORTAL_SITE_CODES } from './buildPayload.js';
import { isPortalPayloadShapeUsable, mergeFreshCurrentMonth, payloadFromLiveCurrent, readPortalPayload } from './portalPayload.js';
import { STALE_MS, checkPullLock, startPullLog, finishPullLog } from './pullLock.js';
import { describeError } from './describeError.js';
import { reportingCurrentMonthStart, reportingPreviousMonthStart } from './reportingPeriod.js';
import { retryOnStatementTimeout } from './supabaseRetry.js';

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

async function waitForUnlocked(maxWaitMs = 4 * 60 * 1000, pollMs = 15 * 1000) {
  const started = Date.now();
  let lastMessage = null;
  for (;;) {
    const lock = await checkPullLock({ activeKinds: ['pull', 'rebuild'] });
    if (!lock.locked) return { ok: true };
    lastMessage = lock.message || 'Another refresh job is still running.';
    const waitedMs = Date.now() - started;
    const remainingBudgetMs = maxWaitMs - waitedMs;
    const staleRemainingMs = typeof lock.ageMs === 'number'
      ? Math.max(0, (lock.staleMs || STALE_MS) - lock.ageMs)
      : null;
    // If the only blocker is a row that's about to self-expire as stale anyway, keep waiting long
    // enough to let the sweep happen instead of skipping a rebuild seconds before the lock would
    // naturally clear. This matters most now that the post-fix fast path is cheap — a needless skip
    // can leave the live deployment stuck on the old behavior for another whole cron window.
    const nextWaitMs = staleRemainingMs == null
      ? pollMs
      : Math.min(pollMs, Math.max(1000, staleRemainingMs + 1000));
    if (remainingBudgetMs < nextWaitMs) return { ok: false, message: lastMessage };
    console.error(`[rebuild-payload] lock still held — waiting ${Math.round(nextWaitMs / 1000)}s before retrying...`);
    await new Promise((res) => setTimeout(res, nextWaitMs));
  }
}

function storedHistoryNeedsFullRebuild(payload) {
  if (!payload?.monthly || typeof payload.monthly !== 'object') return true;
  const expectedCodes = PORTAL_SITE_CODES;
  for (const rows of Object.values(payload.monthly)) {
    if (!Array.isArray(rows)) return true;
    if (!rows.length) continue;
    const codes = new Set(rows.map((row) => row?.code).filter(Boolean));
    for (const code of expectedCodes) {
      if (!codes.has(code)) return true;
    }
    // Historical payload hardening (27 Jul 2026): older stored lead_funnel-derived monthly rows can
    // carry an impossible hybrid shape where move-in conversion COUNT survives (`conversions > 0`)
    // but every visible enquiry count/base/channel is zeroed out. buildPayloadRange() can rebuild the
    // correct month directly from raw_report, but the cheap merge-current-month refresh path would
    // otherwise leave that malformed historical row in place forever because the row count/codes still
    // look "complete". Treat that as structurally incomplete history so the next scheduled rebuild
    // forces one full-history pass and re-normalizes the affected month from raw raw_response.
    for (const row of rows) {
      const e = row?.enquiries;
      if (!e) continue;
      const impossibleLeadShape =
        (e.conversions || 0) > 0 &&
        (e.total || 0) === 0 &&
        (e.phone || 0) === 0 &&
        (e.walkin || 0) === 0 &&
        ((e.webOnly ?? e.web ?? 0) === 0) &&
        !(e.channels && Object.keys(e.channels).length) &&
        (e.reservationConversions || 0) === 0 &&
        (e.reservationConversionBase || 0) === 0;
      if (impossibleLeadShape) return true;
      // Historical real-rate hardening (27 Jul 2026): older stored monthly rows can retain a final
      // realRate/ssReal number while dropping every denominator field the current payload contract is
      // meant to carry alongside it (`realRateArea` plus the older fallback `areaTotalAll`, same for
      // self storage). The page now defends against that by showing the stored value instead of
      // blanking it, but the singleton history is still incomplete and should be rebuilt from
      // raw_report once so charts/exports/debugging all share the full modern shape again.
      const missingTotalRealRateSupport =
        (row?.realRate || 0) > 0 &&
        (row?.realRateArea || 0) === 0 &&
        (row?.areaTotalAll || 0) === 0;
      if (missingTotalRealRateSupport) return true;
      const ssReal = row?.ssReal ?? row?.ss?.real ?? 0;
      const missingSelfStorageRealRateSupport =
        ssReal > 0 &&
        (row?.ssRealArea || 0) === 0 &&
        (row?.ssAreaTotalAll || 0) === 0;
      if (missingSelfStorageRealRateSupport) return true;
      // Customer-insights hardening: older monthly rows can retain only the rounded display average
      // stay figure while dropping the raw stay-count/day/rent sums the current payload shape uses
      // for truthful per-store averages and exports. The page now falls back defensively, but the
      // stored history should still be rebuilt once so downstream consumers all share the raw basis.
      const missingStaySupport =
        (row?.avgStayDays || 0) > 0 &&
        (row?.stayCount == null || row?.stayDaysSum == null || row?.stayRentSum == null);
      if (missingStaySupport) return true;
      // Autobill conversion hardening: historical rows can keep only the rounded monthly average
      // `autobillNewCount` while omitting the exact sampled average field added later. We already
      // fall back to the rounded count in the UI, but the persisted shape is still incomplete and
      // should be rebuilt from raw autobill_daily-derived history when detected.
      const missingAutobillExactSupport =
        (row?.autobillNewTotal || 0) > 0 &&
        (row?.autobillNewCount || 0) > 0 &&
        row?.autobillNewCountExact == null;
      if (missingAutobillExactSupport) return true;
    }
  }
  return false;
}

export async function runRebuildPayload() {
  const started = Date.now();
  const now = new Date();
  // The portal's visible "current month" is the month containing the LAST COMPLETE DAY, not the
  // literal calendar month at this instant. Example: on 1 Aug in the morning, the latest complete
  // day is still 31 Jul, so the rebuilt payload should keep Jul as current_month and hide any Aug
  // rows that were only seeded for tomorrow's first true day-of-month view.
  const curStart = reportingCurrentMonthStart(now);
  const prevStart = reportingPreviousMonthStart(now);
  const curKey = `${curStart.getFullYear()}-${String(curStart.getMonth() + 1).padStart(2, '0')}`;
  const stored = await readPortalPayload().catch(() => null);
  const canUseFastRefresh = isPortalPayloadShapeUsable(stored?.payload);
  const storedHistoryComplete = canUseFastRefresh && !storedHistoryNeedsFullRebuild(stored?.payload);
  const storedAlreadyCurrent = canUseFastRefresh && stored?.payload?.current_month === curKey;
  const storedBuildVersionCurrent = stored?.payload?.build_version === PORTAL_PAYLOAD_BUILD_VERSION;

  const unlocked = await waitForUnlocked();
  if (!unlocked.ok) {
    console.error('[rebuild-payload] ' + unlocked.message);
    const logId = await startPullLog('rebuild');
    await finishPullLog(logId, 'skipped', unlocked.message);
    return { status: 'skipped', message: unlocked.message };
  }

  const logId = await startPullLog('rebuild');
  const claimedLock = await checkPullLock({ activeKinds: ['pull', 'rebuild'], claimingLogId: logId });
  if (claimedLock.locked) {
    console.error('[rebuild-payload] ' + claimedLock.message);
    await finishPullLog(logId, 'skipped', claimedLock.message);
    return { status: 'skipped', message: claimedLock.message };
  }
  try {
    // Daily cron hardening (27 Jul 2026): keep the rebuild on the CHEAP current-month-only path when
    // the stored historical singleton is structurally usable, but do not blindly skip it just because
    // the row already says "current month". We observed real store-level drift where the stored row
    // still differed from the live merged current-month slice at 14 stores even though its
    // generated_at timestamp was newer than raw_report's own latest pulled_at. So the only safe skip
    // rule is semantic: rebuild the cheap current-month slice, merge it, and only skip the write if
    // that merged payload is actually identical to what's already stored.
    // Retries the WHOLE build+write together (not just the upsert) — cheap to just recompute the
    // payload fresh on a retry, and self-correcting if underlying data changed between attempts.
    // 3 attempts x up to ~60s observed worst case + 2 x 3s delays comfortably fits the route's 300s
    // maxDuration even in the worst case where every attempt is slow.
    const result = await withRetry(async () => {
      // Daily auto-refresh should stay cheap and reliable: rebuild only the current visible month
      // from raw_report, then merge that authoritative slice into the already-persisted historical
      // singleton whenever the stored shape is still structurally usable. That lets already-live
      // deployments migrate immediately onto the fast path after a code deploy instead of requiring
      // one successful full-history rebuild first — critical because the whole bug here is that the
      // expensive full rebuild can be exactly what keeps timing out every morning. We only fall back
      // to a full-history rebuild when the stored payload is missing or structurally unusable.
      //
      // Note: PORTAL_PAYLOAD_BUILD_VERSION is still stamped onto the merged payload so subsequent
      // reads/rebuilds know which code path produced the currently stored singleton, but version
      // drift alone is not allowed to force the heavy path on an otherwise healthy deployment.
      let payload;
      let mode = (canUseFastRefresh && storedHistoryComplete) ? 'merge-current-month' : 'full-rebuild';
      if (canUseFastRefresh && storedHistoryComplete) {
        const liveCurrent = await buildPayloadRange(curStart, curStart);
        payload = mergeFreshCurrentMonth(stored.payload, liveCurrent) || payloadFromLiveCurrent(liveCurrent);
        if (!payload) throw new Error('fresh current-month rebuild returned no usable payload');
        const storedPayloadJson = JSON.stringify(stored.payload);
        const mergedPayloadJson = JSON.stringify(payload);
        if (storedAlreadyCurrent && storedBuildVersionCurrent && storedPayloadJson === mergedPayloadJson) {
          mode = 'already-current';
          return { skippedWrite: true, mode };
        }
      } else {
        payload = await buildPayload(curStart, prevStart);
      }
      const writeRow = { id: 1, generated_at: new Date().toISOString(), payload };
      const { error } = stored?.payload
        ? await retryOnStatementTimeout(async () => admin.from('portal_payload').update(writeRow).eq('id', 1))
        : await retryOnStatementTimeout(async () => admin.from('portal_payload').upsert(writeRow));
      if (error) throw new Error(error.message);
      return { skippedWrite: false, mode };
    });
    const detail = result?.skippedWrite
      ? `stored portal_payload already matches the freshly rebuilt ${curKey} current-month slice; no rewrite was needed.`
      : result?.mode === 'merge-current-month'
        ? `refreshed stored portal_payload for ${curKey} by rebuilding the live current-month slice from raw_report and merging it into persisted history.`
        : `refreshed stored portal_payload for ${curKey} with a full rebuild from raw_report because the stored payload was missing, structurally unusable, or historically incomplete for the current site universe.`;
    await finishPullLog(logId, 'ok', detail);
    return {
      status: 'ok',
      durationMs: Date.now() - started,
      refreshedCurrentMonth: !result?.skippedWrite,
      mode: result?.mode || ((canUseFastRefresh && storedHistoryComplete) ? 'merge-current-month' : 'full-rebuild'),
    };
  } catch (e) {
    await finishPullLog(logId, 'error', describeError(e));
    return { status: 'error', message: e.message, durationMs: Date.now() - started };
  }
}
