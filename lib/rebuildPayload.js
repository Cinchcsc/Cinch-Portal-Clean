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
import { buildCurrentMonthPayload, buildPayload, buildPayloadRange, PORTAL_PAYLOAD_BUILD_VERSION, PORTAL_SITE_CODES } from './buildPayload.js';
import { buildHistoryPoint, isPortalPayloadShapeUsable, mergeFreshCurrentMonth, normalizePortalPayloadForStorage, payloadFromLiveCurrent, readPortalPayload, summarizeHistoricalMonthlyCoverage } from './portalPayload.js';
import { STALE_MS, checkPullLock, startPullLog, startPullLogLenient, finishPullLog } from './pullLock.js';
import { describeError } from './describeError.js';
import { reportingCurrentMonthStart, reportingPreviousMonthStart } from './reportingPeriod.js';
import { isRetryableSupabaseMessage, retryOnStatementTimeout } from './supabaseRetry.js';

const VALID_MONTH_KEY_RE = /^\d{4}-\d{2}$/;
function isValidMonthKey(month) {
  if (!VALID_MONTH_KEY_RE.test(String(month || ''))) return false;
  const mm = Number(String(month).slice(5, 7));
  return Number.isInteger(mm) && mm >= 1 && mm <= 12;
}

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

function installInterruptCleanup(logId) {
  if (!logId || typeof process?.on !== 'function') return () => {};
  let cleaned = false;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const cleanup = async (signal) => {
    if (cleaned) return;
    cleaned = true;
    try {
      await finishPullLog(logId, 'error', `manual rebuild interrupted by ${signal}`);
    } catch {}
  };
  const handlers = signals.map((signal) => {
    const handler = () => {
      cleanup(signal).finally(() => process.exit(130));
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  return () => {
    cleaned = true;
    for (const { signal, handler } of handlers) process.off(signal, handler);
  };
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

function analyzeStoredHistory(payload, currentMonthKey = null) {
  if (!payload?.monthly || typeof payload.monthly !== 'object') return { repairMonths: null, requiresFullRebuild: true };
  const repairMonths = new Set();
  for (const rows of Object.values(payload.monthly)) {
    if (!Array.isArray(rows)) return { repairMonths: null, requiresFullRebuild: true };
  }
  const coverage = summarizeHistoricalMonthlyCoverage(payload, { excludeMonth: currentMonthKey });
  for (const month of coverage.incompleteMonths) repairMonths.add(month);
  return { repairMonths: [...repairMonths].sort(), requiresFullRebuild: false };
}

async function latestCurrentMonthRawPulledAt(currentMonthStart) {
  const nextMonthStart = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() + 1, 1);
  const startKey = `${currentMonthStart.getFullYear()}-${String(currentMonthStart.getMonth() + 1).padStart(2, '0')}-01`;
  const endKey = `${nextMonthStart.getFullYear()}-${String(nextMonthStart.getMonth() + 1).padStart(2, '0')}-01`;
  const { data, error } = await retryOnStatementTimeout(async () => admin
    .from('raw_report')
    .select('pulled_at')
    .gte('month', startKey)
    .lt('month', endKey)
    .order('pulled_at', { ascending: false })
    .limit(1));
  if (error) throw new Error(error.message);
  return data?.[0]?.pulled_at || null;
}

function contiguousMonthSpans(months) {
  if (!months?.length) return [];
  const out = [];
  let start = months[0];
  let prev = months[0];
  const nextMonthKey = (mk) => {
    const [y, m] = String(mk || '').split('-').map(Number);
    const d = new Date(y, m, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  for (let i = 1; i < months.length; i++) {
    if (nextMonthKey(prev) === months[i]) {
      prev = months[i];
      continue;
    }
    out.push({ start, end: prev });
    start = prev = months[i];
  }
  out.push({ start, end: prev });
  return out;
}

function splitSpanIntoChunks({ start, end }, maxMonths = 2) {
  const parseMonthKey = (mk) => {
    const [y, m] = String(mk || '').split('-').map(Number);
    return (y && m) ? { year: y, month: m } : null;
  };
  const monthKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;
  const addMonths = (year, month, delta) => {
    const d = new Date(Date.UTC(year, month - 1 + delta, 1));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  };
  const compareMonthKeys = (a, b) => String(a || '').localeCompare(String(b || ''));
  const out = [];
  const startParts = parseMonthKey(start);
  const endParts = parseMonthKey(end);
  if (!startParts || !endParts) return out;
  let cur = monthKey(startParts.year, startParts.month);
  const finalKey = monthKey(endParts.year, endParts.month);
  while (compareMonthKeys(cur, finalKey) <= 0) {
    const chunkStartParts = parseMonthKey(cur);
    const rawChunkEndParts = addMonths(chunkStartParts.year, chunkStartParts.month, maxMonths - 1);
    const rawChunkEnd = monthKey(rawChunkEndParts.year, rawChunkEndParts.month);
    const chunkEnd = compareMonthKeys(rawChunkEnd, finalKey) > 0 ? finalKey : rawChunkEnd;
    const chunkEndParts = parseMonthKey(chunkEnd);
    out.push({
      start: new Date(chunkStartParts.year, chunkStartParts.month - 1, 1),
      end: new Date(chunkEndParts.year, chunkEndParts.month - 1, 1),
    });
    const next = addMonths(chunkEndParts.year, chunkEndParts.month, 1);
    cur = monthKey(next.year, next.month);
  }
  return out;
}

function mergeHistoricalMonthlySlices(payload, repairedMonthly, opts = {}) {
  if (!payload || !repairedMonthly || typeof repairedMonthly !== 'object') return payload;
  const nextBuildVersion = opts?.nextBuildVersion || null;
  const monthly = { ...(payload.monthly || {}) };
  const repairedMonths = Object.keys(repairedMonthly);
  for (const month of repairedMonths) monthly[month] = repairedMonthly[month];
  const months = [...new Set([...(payload.months || []), ...Object.keys(monthly)])].sort();
  const historyByMonth = new Map((Array.isArray(payload.history) ? payload.history : []).map((row) => [row?.month, row]));
  for (const month of repairedMonths) {
    historyByMonth.set(month, buildHistoryPoint(month, monthly[month] || []));
  }
  const history = [...historyByMonth.values()]
    .filter((row) => row?.month)
    .sort((a, b) => String(a?.month || '').localeCompare(String(b?.month || '')));
  return {
    ...payload,
    build_version: nextBuildVersion || payload.build_version || null,
    monthly,
    months,
    history,
  };
}

function normalizeRepairMonths(input, currentMonthKey) {
  if (!Array.isArray(input)) return [];
  return [...new Set(
    input
      .map((month) => String(month || '').slice(0, 7))
      .filter((month) => isValidMonthKey(month) && month !== currentMonthKey),
  )].sort();
}

export async function runRebuildPayload(opts = {}) {
  const forceHistoricalRepair = !!opts.forceHistoricalRepair;
  const skipLockCheck = !!opts.skipLockCheck;
  const triggerLabel = opts.triggerLabel ? String(opts.triggerLabel) : null;
  const started = Date.now();
  const now = new Date();
  // The portal's visible "current month" is the month containing the LAST COMPLETE DAY, not the
  // literal calendar month at this instant. Example: on 1 Aug in the morning, the latest complete
  // day is still 31 Jul, so the rebuilt payload should keep Jul as current_month and hide any Aug
  // rows that were only seeded for tomorrow's first true day-of-month view.
  const curStart = reportingCurrentMonthStart(now);
  const prevStart = reportingPreviousMonthStart(now);
  const prevKey = `${prevStart.getFullYear()}-${String(prevStart.getMonth() + 1).padStart(2, '0')}`;
  const curKey = `${curStart.getFullYear()}-${String(curStart.getMonth() + 1).padStart(2, '0')}`;
  const requestedRepairMonths = normalizeRepairMonths(opts.repairMonths, curKey);
  const literalCalendarMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthBoundaryFinalizationNeeded = curKey !== literalCalendarMonthKey;
  const stored = await readPortalPayload().catch(() => null);
  const canUseFastRefresh = isPortalPayloadShapeUsable(stored?.payload);
  const historyAnalysis = canUseFastRefresh ? analyzeStoredHistory(stored?.payload, curKey) : { repairMonths: null, requiresFullRebuild: true };
  const repairMonths = historyAnalysis.repairMonths || [];
  const repairMonthsAffectingActiveWindow = repairMonths.filter((month) => month >= prevKey);
  const olderRepairMonthsBacklog = repairMonths.filter((month) => month < prevKey);
  const opportunisticRepairMonths = [];
  const hasOnlyOlderHistoricalRepairs = repairMonths.length > 0 && repairMonthsAffectingActiveWindow.length === 0;
  const allHistoricalMonths = (stored?.payload?.months || Object.keys(stored?.payload?.monthly || {}))
    .filter((month) => isValidMonthKey(month) && month !== curKey)
    .sort();
  const requestedHistoricalMonths = requestedRepairMonths.filter((month) => allHistoricalMonths.includes(month));
  const storedHistoryComplete = canUseFastRefresh && !historyAnalysis.requiresFullRebuild && repairMonths.length === 0;
  const storedAlreadyCurrent = canUseFastRefresh && stored?.payload?.current_month === curKey;
  const storedBuildVersionCurrent = stored?.payload?.build_version === PORTAL_PAYLOAD_BUILD_VERSION;
  const storedNeedsNormalizationWrite = canUseFastRefresh && (() => {
    try {
      return JSON.stringify(stored?.rawPayload || null) !== JSON.stringify(stored?.payload || null);
    } catch {
      return true;
    }
  })();
  let storedCoversLatestRaw = false;
  if (canUseFastRefresh && storedAlreadyCurrent && stored?.generatedAt) {
    try {
      const latestRawPulledAt = await latestCurrentMonthRawPulledAt(curStart);
      const storedAtMs = new Date(stored.generatedAt).getTime();
      const latestRawAtMs = latestRawPulledAt ? new Date(latestRawPulledAt).getTime() : 0;
      storedCoversLatestRaw = !latestRawPulledAt || (Number.isFinite(storedAtMs) && Number.isFinite(latestRawAtMs) && storedAtMs >= latestRawAtMs);
    } catch (error) {
      console.warn('[rebuild-payload] current-month freshness probe failed; treating stored payload as stale so cron refresh still repairs it:', error?.message || error);
    }
  }

  if (!skipLockCheck) {
    const unlocked = await waitForUnlocked();
    if (!unlocked.ok) {
      console.error('[rebuild-payload] ' + unlocked.message);
      const blockedLogId = await startPullLogLenient('rebuild', 'rebuild skip');
      await finishPullLog(blockedLogId, 'skipped', unlocked.message);
      return { status: 'skipped', message: unlocked.message };
    }
  }

  let logId = null;
  try {
    logId = skipLockCheck
      ? await startPullLogLenient('rebuild', 'rebuild')
      : await startPullLog('rebuild');
  } catch (error) {
    if (!isRetryableSupabaseMessage(error?.message || error)) throw error;
    console.warn('[rebuild-payload] refresh_log insert failed under transient DB pressure; continuing rebuild without a log row:', error?.message || error);
  }
  const removeInterruptCleanup = installInterruptCleanup(logId);
  if (!skipLockCheck) {
    const claimedLock = await checkPullLock({ activeKinds: ['pull', 'rebuild'], claimingLogId: logId });
    if (claimedLock.locked) {
      console.error('[rebuild-payload] ' + claimedLock.message);
      await finishPullLog(logId, 'skipped', claimedLock.message);
      removeInterruptCleanup();
      return { status: 'skipped', message: claimedLock.message };
    }
  }
  try {
    // Daily cron hardening (27 Jul 2026, continued): the default portal read path now merges a live
    // current-month slice at request time, so the scheduled rebuild does NOT need to rewrite the full
    // stored singleton on every ordinary in-month day just to keep dashboard values fresh. That daily
    // 10MB-ish rewrite is exactly the operation still hitting statement timeouts. The rebuild should
    // only do heavy work when:
    //   1. stored history is structurally broken and needs repair/full rebuild, or
    //   2. we're in the month-boundary window (for example 1 Aug showing 31 Jul as the last complete
    //      day), where the just-closed month's FINAL slice must be persisted into stored history
    //      before the read path moves on to the new month.
    // On normal days inside the same calendar month, read-time live merge owns freshness and this
    // cron can safely no-op instead of rewriting the singleton.
    // Retries the WHOLE build+write together (not just the upsert) — cheap to just recompute the
    // payload fresh on a retry, and self-correcting if underlying data changed between attempts.
    // 3 attempts x up to ~60s observed worst case + 2 x 3s delays comfortably fits the route's 300s
    // maxDuration even in the worst case where every attempt is slow.
    const result = await withRetry(async () => {
      if (!forceHistoricalRepair && canUseFastRefresh && !historyAnalysis.requiresFullRebuild && !monthBoundaryFinalizationNeeded) {
        // Ordinary in-month days should not force a full portal_payload rewrite just because new raw
        // rows arrived today. The default read path already merges the visible current month live
        // from raw_report on demand; the heavy singleton write only needs to happen at month
        // boundaries or when the persisted historical shape itself needs repair.
        if (storedHistoryComplete && storedBuildVersionCurrent && !storedNeedsNormalizationWrite && storedCoversLatestRaw) {
          return {
            skippedWrite: true,
            mode: 'read-time-live-current',
            storedAlreadyCurrent,
            storedCoversLatestRaw,
          };
        }
        if (!requestedHistoricalMonths.length && hasOnlyOlderHistoricalRepairs && !opportunisticRepairMonths.length) {
          return { skippedWrite: true, mode: 'deferred-historical-repair' };
        }
      }
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
      let deferredRepairMonths = [];
      const monthsToRepair = requestedHistoricalMonths.length
        ? requestedHistoricalMonths
        : (forceHistoricalRepair
            ? allHistoricalMonths
            : (repairMonthsAffectingActiveWindow.length ? repairMonthsAffectingActiveWindow : opportunisticRepairMonths));
      const repairingAllHistoricalMonths =
        allHistoricalMonths.length > 0 &&
        monthsToRepair.length === allHistoricalMonths.length &&
        monthsToRepair.every((month, idx) => month === allHistoricalMonths[idx]);
      const shouldRepairHistoryThisRun = canUseFastRefresh && !historyAnalysis.requiresFullRebuild && monthsToRepair.length > 0;
      let mode = (canUseFastRefresh && !historyAnalysis.requiresFullRebuild)
        ? (shouldRepairHistoryThisRun ? 'repair-history' : 'merge-current-month')
        : 'full-rebuild';
      if (canUseFastRefresh && !historyAnalysis.requiresFullRebuild) {
        payload = stored.payload;
        if (shouldRepairHistoryThisRun) {
          const repairedMonthly = {};
          const repairChunks = contiguousMonthSpans(monthsToRepair).flatMap((span) => splitSpanIntoChunks(span, 2));
          for (const chunk of repairChunks) {
            let repaired;
            try {
              repaired = await withRetry(
                () => buildPayloadRange(chunk.start, chunk.end, { includeMonthly: true }),
                2,
                1500,
              );
            } catch (error) {
              const chunkMonths = Object.keys(stored?.payload?.monthly || {})
                .filter((month) => isValidMonthKey(month))
                .filter((month) => month >= `${chunk.start.getFullYear()}-${String(chunk.start.getMonth() + 1).padStart(2, '0')}` && month <= `${chunk.end.getFullYear()}-${String(chunk.end.getMonth() + 1).padStart(2, '0')}`)
                .sort();
              const canDeferRepair = !forceHistoricalRepair && !requestedHistoricalMonths.length;
              if (!canDeferRepair) throw error;
              deferredRepairMonths.push(...chunkMonths);
              console.warn('[rebuild-payload] historical repair chunk failed; deferring those month(s) and continuing current-month refresh:', error?.message || error);
              continue;
            }
            Object.assign(repairedMonthly, repaired.monthly || {});
          }
          deferredRepairMonths = [...new Set(deferredRepairMonths)].sort();
          payload = mergeHistoricalMonthlySlices(payload, repairedMonthly, {
            nextBuildVersion: repairingAllHistoricalMonths ? PORTAL_PAYLOAD_BUILD_VERSION : null,
          });
        }
        let liveCurrent;
        try {
          liveCurrent = await buildCurrentMonthPayload(curStart, prevStart);
        } catch (error) {
          const canDeferCurrentMonthRewrite =
            canUseFastRefresh &&
            !forceHistoricalRepair &&
            !monthBoundaryFinalizationNeeded &&
            !requestedHistoricalMonths.length;
          if (!canDeferCurrentMonthRewrite) throw error;
          console.warn('[rebuild-payload] current-month live rebuild failed; deferring stored rewrite and leaving read-time live merge to keep the portal current:', error?.message || error);
          return {
            skippedWrite: true,
            mode: 'deferred-current-month-refresh',
            deferredRepairMonths,
          };
        }
        payload = mergeFreshCurrentMonth(payload, liveCurrent) || payloadFromLiveCurrent(liveCurrent);
        if (!payload) throw new Error('fresh current-month rebuild returned no usable payload');
        const storedPayloadJson = JSON.stringify(stored.payload);
        const rebuiltPayloadJson = JSON.stringify(payload);
        if (storedAlreadyCurrent && storedBuildVersionCurrent && storedHistoryComplete && !storedNeedsNormalizationWrite && storedPayloadJson === rebuiltPayloadJson) {
          mode = 'already-current';
          return { skippedWrite: true, mode, deferredRepairMonths };
        }
      } else {
        payload = await buildPayload(curStart, prevStart);
      }
      const writeRow = { id: 1, generated_at: new Date().toISOString(), payload: normalizePortalPayloadForStorage(payload) };
      const { error } = stored?.payload
        ? await retryOnStatementTimeout(async () => admin.from('portal_payload').update(writeRow).eq('id', 1))
        : await retryOnStatementTimeout(async () => admin.from('portal_payload').upsert(writeRow));
      if (error) throw new Error(error.message);
      return { skippedWrite: false, mode, deferredRepairMonths };
    });
    const baseDetail = result?.skippedWrite
      ? (result?.mode === 'read-time-live-current'
          ? `stored portal_payload history is structurally usable and ordinary ${curKey} freshness is now served by the read-time live current-month merge, so no daily full-row rewrite was needed${result?.storedAlreadyCurrent ? (result?.storedCoversLatestRaw ? ' because the stored fallback already covers the latest raw pull' : ' even though fresher raw pulls exist') : ' while the persisted singleton remains on the prior stored current-month marker'}.`
          : result?.mode === 'deferred-historical-repair'
            ? `default portal routes already merge the ${curKey} current-month slice at read time, so this daily rebuild deferred older historical repair-only months (${repairMonths.slice(0, 3).join(', ')}${repairMonths.length > 3 ? ', …' : ''}) instead of risking another timeout on a full-row rewrite.`
            : result?.mode === 'deferred-current-month-refresh'
              ? `the stored portal_payload remains structurally usable, so this daily rebuild deferred rewriting the ${curKey} current-month slice after a transient live rebuild failure and left read-time live merging to keep the portal current instead.`
            : `stored portal_payload already matches the freshly rebuilt ${curKey} current-month slice; no rewrite was needed.`)
      : result?.mode === 'merge-current-month'
        ? `refreshed stored portal_payload for ${curKey} by rebuilding the live current-month slice from raw_report and merging it into persisted history${result?.deferredRepairMonths?.length ? `, while deferring historical repair-only month(s) that still failed to rebuild (${result.deferredRepairMonths.slice(0, 3).join(', ')}${result.deferredRepairMonths.length > 3 ? ', …' : ''})` : ''}.`
      : result?.mode === 'repair-history'
          ? `refreshed stored portal_payload for ${curKey} by repairing stale historical month slices from raw_report${forceHistoricalRepair ? ' via a forced manual repair run' : ''}${result?.deferredRepairMonths?.length ? `, deferring month(s) still blocked by missing raw coverage or DB pressure (${result.deferredRepairMonths.slice(0, 3).join(', ')}${result.deferredRepairMonths.length > 3 ? ', …' : ''})` : ''}, then rebuilding and merging the live current-month slice.`
        : `refreshed stored portal_payload for ${curKey} with a full rebuild from raw_report because the stored payload was missing, structurally unusable, or historically incomplete for the current site universe.`;
    const detail = [triggerLabel ? `trigger=${triggerLabel}` : null, baseDetail].filter(Boolean).join(' | ');
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
  } finally {
    removeInterruptCleanup();
  }
}
