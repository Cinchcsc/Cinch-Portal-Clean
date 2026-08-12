// Weekly/Daily/Quarterly Snapshot (roadmap #5/#6, Michael's decision 9 Jul 2026: "live range query"
// — period totals, not a day-by-day trend chart). Writes ONE overwritten row to snapshot_payload,
// same single-row pattern as portal_payload — see supabase/schema.sql.
//
// Three periods, each capped at YESTERDAY (today is always in-progress/incomplete, same reasoning
// pull.js already applies to the current month):
//   daily     = yesterday only
//   weekly    = the 7 days ending yesterday (inclusive)
//   quarterly = quarter-to-date (start of the calendar quarter containing yesterday) through yesterday
//
// REVERTED 21 Jul 2026: briefly changed to run all three through TODAY instead (Michael: "its the
// daily snapshot so it needs to be enquiries and reservations today"), then reverted the same day
// (Michael: "no today needs to show yesterday") after seeing what that actually looked like in
// practice — this pull only runs ONCE a day on its scheduled hour, so "today" was frozen at whatever had
// happened by that one early-morning run and looked artificially near-zero for the rest of the day,
// exactly the "today is always in-progress/incomplete" problem the yesterday-anchor was originally
// chosen to avoid. Back to yesterday: a genuine, complete, finished day's total, not a partial one.
//
// CHANGED 27 Jul 2026 (deep audit): this no longer makes its own live SiteLink calls at all. It now
// derives daily/weekly/quarterly snapshot windows from the SAME stored raw_report month payloads the
// main portal uses (lead_funnel + move_ins_outs raw SOAP), then date-filters those raw rows locally.
// Reason: the old separate live snapshot pull could disagree with the monthly portal for the same
// last-complete-day window because it was effectively a different morning read of the same mutable
// SiteLink source. Reusing stored raw_report makes Snapshot and the rest of the portal reconcile to
// one shared source of truth while keeping the same visible formulas.
//
// Metrics: enquiries + reservations (InquiryTracking / lead_funnel parser), move-ins + sqft in/out
// (MoveInsAndMoveOuts / move_ins_outs parser). "Reservation backlog" (forward move-ins, Michael's
// pick) is NOT yet included — it depends on confirming whether InquiryTracking carries a usable
// target-move-in-date field. Keep it OUT of the payload until that source is confirmed so snapshot
// consumers never have to special-case a permanently-null pseudo-metric.
//
// Run manually: npm run pull:snapshot (no timeout — plain Node script).
// Or via HTTP: GET /api/pull-snapshot — now scheduled daily via vercel.json (0 4 * * * UTC); 300s
// duration fits the route's explicit serverless budget.
import { admin, createAdminClient } from './supabaseAdmin.js';
import { REPORTS } from './reportMap.js';
import { extractNamedTable } from './sitelink.js';
import { STALE_MS, checkPullLock, startPullLogLenient, finishPullLog, recordCompletedPullLog } from './pullLock.js';
import { describeError } from './describeError.js';
import { formatLocalYmd, lastCompleteDay } from './reportingPeriod.js';
import { isRetryableSupabaseMessage, retryOnStatementTimeout } from './supabaseRetry.js';

export const SNAPSHOT_PAYLOAD_BUILD_VERSION = '2026-08-04-raw-report-v2';

const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const ymd = (d) => formatLocalYmd(d);
const SUPABASE_REST_BASE = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '')
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/rest\/v1$/i, '')
  .replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const timestampMs = (value) => {
  const ms = value ? new Date(value).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
};
const sourceDayKey = (v) => {
  const raw = String(v ?? '').trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : ymd(d);
};
// Keep snapshot channel bucketing aligned with the main monthly payload and report parser so
// punctuation variants like "Walk-in" do not split counts across visible vs hidden channels.
const inquiryChannelKey = (label) => String(label ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const SNAPSHOT_DB_QUERY_TIMEOUT_MS = 30_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function withQueryTimeout(promise, timeoutMs, label) {
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
async function withTransportRetry(fn, attempts = 5, delayMs = 2000) {
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
async function runRetriedQuery(fn, attempts = 3, delayMs = 2000) {
  return withTransportRetry(async () => {
    const result = await retryOnStatementTimeout(fn, 1, 0);
    if (result?.error) throw new Error(result.error.message || String(result.error));
    return result;
  }, attempts, delayMs);
}
async function runRetriedTimedQuery(fn, {
  attempts = 2,
  delayMs = 2000,
  timeoutMs = SNAPSHOT_DB_QUERY_TIMEOUT_MS,
  label = 'snapshot db query',
} = {}) {
  return withTransportRetry(async () => {
    const result = await withQueryTimeout(retryOnStatementTimeout(fn, 1, 0), timeoutMs, label);
    if (result?.error) throw new Error(result.error.message || String(result.error));
    return result;
  }, attempts, delayMs);
}
const isVisibleMarketingChannel = (label) => {
  const k = inquiryChannelKey(label);
  return k === 'phone' || k === 'walkin' || k === 'web';
};
const visibleSnapshotEnquiries = (lf) => {
  const allChannelRows = Object.entries(lf?.channels || {});
  const visibleChannelRows = allChannelRows.filter(([label]) => isVisibleMarketingChannel(label));
  if (visibleChannelRows.length) {
    return visibleChannelRows.reduce((sum, [, row]) => sum + (Number(row?.enquiries) || 0), 0);
  }
  if (allChannelRows.length) return 0;
  return (Number(lf?.phone) || 0) + (Number(lf?.walkin) || 0) + (Number(lf?.web) || 0);
};
// REPLACED 24 Jul 2026 (task #422, Michael: "the reservations are the exact same as yesterday, this is
// extremely unlikely"). The old visibleSnapshotReservations(lf) summed channels[label].converted —
// itself gated by dPlaced (enquiry PLACED day) + iInquiryConvertedToLease. Live-verified via
// scripts/probe-snapshot-reservation-daycompare.js that iInquiryConvertedToLease is VOLATILE, not a
// stable historical fact: re-querying the exact same already-closed day (23 Jul) hours after the
// morning pull had already run showed the portfolio total drop from 33 to 5 — an 85% swing for a day
// that was fully over. Evidently the flag reflects something like "has an active reservation/lease
// RIGHT NOW" — soft/online reservations that never get finalized drop back out within hours — so
// whatever number the once-daily pull happens to catch keeps drifting for the rest of that day, and a
// day that's mostly decayed by the time you look can easily resemble another equally-decayed day.
// isReservationStage/countReservationsInWindow below replace it: gated by dConverted_ToRsv (the date a
// row actually left raw Inquiry status — see task #406/#410's probe-reservation-converted-date.js)
// instead of dPlaced, and by sRentalType==="Reservation" instead of the volatile conversion flag.
// NOT yet independently confirmed stable under requery — that needs the same kind of same-day,
// hours-apart recheck that caught the old bug, just not done yet for this replacement. Deliberately
// kept LOCAL to this file (not folded into reportMap.js's shared lead_funnel.parse()/channels), same
// reasoning as the move_ins_outs local trim below: that shared parser also feeds the Marketing page's
// already-validated monthly Enquiry->Reservation ratio, a different, signed-off metric this change
// must not disturb.
const isReservationStage = (r) => String(r?.sRentalType ?? '').trim().toLowerCase() === 'reservation';
const countReservationsInWindow = (raw, start, end) => {
  const startDay = ymd(start), endDay = ymd(end);
  const activityRows = extractNamedTable(raw, 'Activity');
  let count = 0;
  for (const r of activityRows) {
    if (!isVisibleMarketingChannel(r.sInquiryType)) continue;
    if (!isReservationStage(r)) continue;
    const day = sourceDayKey(r.dConverted_ToRsv);
    if (day && day >= startDay && day <= endDay) count++;
  }
  return count;
};

async function waitForUnlocked(maxWaitMs = 4 * 60 * 1000, pollMs = 15 * 1000) {
  const started = Date.now();
  let lastMessage = null;
  for (;;) {
    const lock = await checkPullLock({ activeKinds: ['pull', 'snapshot'] });
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
    console.error(`[pull-snapshot] lock still held — waiting ${Math.round(nextWaitMs / 1000)}s before retrying...`);
    await sleep(nextWaitMs);
  }
}

export function snapshotPeriodWindows(now = new Date()) {
  const yesterday = dayOnly(lastCompleteDay(now));
  const daily = { start: yesterday, end: yesterday };
  const weekly = { start: addDays(yesterday, -6), end: yesterday };
  const qMonth = Math.floor(yesterday.getMonth() / 3) * 3;
  const quarterly = { start: new Date(yesterday.getFullYear(), qMonth, 1), end: yesterday };
  return { daily, weekly, quarterly };
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function monthKeysForWindow(start, end) {
  const out = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cur.getTime() <= last.getTime()) {
    out.push(monthKey(cur));
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}

async function fetchSnapshotSources(locations, windows, db = createAdminClient()) {
  const wantedMonths = [...new Set(
    Object.values(windows).flatMap((window) => monthKeysForWindow(window.start, window.end))
  )].sort();
  const out = new Map();
  const reports = ['lead_funnel', 'move_ins_outs'];
  for (const report of reports) {
    for (const wantedMonth of wantedMonths) {
      let data = null;
      try {
        const result = await runRetriedTimedQuery(async () => db.from('raw_report')
          .select('site_code,month,report,raw_response')
          .in('site_code', locations)
          .eq('report', report)
          .eq('month', wantedMonth), {
          attempts: 2,
          delayMs: 2500,
          timeoutMs: SNAPSHOT_DB_QUERY_TIMEOUT_MS,
          label: `snapshot raw_report fetch ${report} ${wantedMonth.slice(0, 7)}`,
        });
        data = result?.data || [];
      } catch (error) {
        throw new Error(`snapshot raw_report fetch failed for ${report} ${wantedMonth.slice(0, 7)}: ${error?.message || error}`);
      }
      for (const row of data) {
        if (!row?.raw_response) continue;
        const key = `${row.site_code}|${String(row.month).slice(0, 7)}|${row.report}`;
        out.set(key, row.raw_response || null);
      }
    }
  }
  return out;
}

export async function latestSnapshotSourcePulledAt(locations, windows, db = createAdminClient()) {
  const wantedMonths = [...new Set(
    Object.values(windows).flatMap((window) => monthKeysForWindow(window.start, window.end))
  )].sort();
  const { data } = await runRetriedTimedQuery(async () => db.from('raw_report')
    .select('pulled_at')
    .in('site_code', locations)
    .in('report', ['lead_funnel', 'move_ins_outs'])
    .in('month', wantedMonths)
    .order('pulled_at', { ascending: false })
    .limit(1), { attempts: 2, delayMs: 2500, timeoutMs: 10_000, label: 'snapshot freshness probe' });
  return data?.[0]?.pulled_at || null;
}

function validateSnapshotSourceCoverage(locations, windows, sourceMap) {
  const wantedMonths = [...new Set(
    Object.values(windows).flatMap((window) => monthKeysForWindow(window.start, window.end).map((mk) => String(mk).slice(0, 7)))
  )];
  const missing = [];
  for (const loc of locations) {
    for (const monthShort of wantedMonths) {
      for (const report of ['lead_funnel', 'move_ins_outs']) {
        const key = `${loc}|${monthShort}|${report}`;
        if (!sourceMap.has(key) || !sourceMap.get(key)) missing.push(key);
      }
    }
  }
  return missing;
}

function pullPeriodForSite(loc, { start, end }, sourceMap) {
  const startDay = ymd(start), endDay = ymd(end);
  let enquiries = 0, reservations = 0, moveIns = 0, moveOuts = 0, sqftIn = 0, sqftOut = 0;
  for (const mk of monthKeysForWindow(start, end)) {
    const monthShort = mk.slice(0, 7);
    const inqRaw = sourceMap.get(`${loc}|${monthShort}|lead_funnel`);
    if (inqRaw) {
      const lf = REPORTS.lead_funnel.parse([], start, end, inqRaw);
      enquiries += visibleSnapshotEnquiries(lf);
      reservations += countReservationsInWindow(inqRaw, start, end);
    }
    const mioRaw = sourceMap.get(`${loc}|${monthShort}|move_ins_outs`);
    if (mioRaw) {
      const mioRowsFixed = extractNamedTable(mioRaw, 'UnitMoveInsAndMoveOuts');
      const trimmedMioRows = mioRowsFixed.filter((r) => {
        if (!r.MoveDate) return false;
        const day = sourceDayKey(r.MoveDate);
        return !!day && day >= startDay && day <= endDay;
      });
      for (const row of trimmedMioRows) {
        if (String(row?.MoveIn ?? '').trim() === '1') {
          moveIns += 1;
          sqftIn += Number(row?.MovedInArea) || 0;
        }
        if (String(row?.MoveOut ?? '').trim() === '1') {
          moveOuts += 1;
          sqftOut += Number(row?.MovedOutArea) || 0;
        }
      }
    }
  }
  return {
    code: loc,
    enquiries,
    reservations,
    moveIns,
    moveOuts,
    sqftIn: round2(sqftIn),
    sqftOut: round2(sqftOut),
  };
}

function aggregate(sites) {
  const sum = (k) => sites.reduce((a, s) => a + (s[k] || 0), 0);
  return {
    enquiries: sum('enquiries'), reservations: sum('reservations'),
    moveIns: sum('moveIns'),
    moveOuts: sum('moveOuts'),
    sqftIn: round2(sum('sqftIn')),
    sqftOut: round2(sum('sqftOut')),
  };
}

// concurrency pool over locations (default sequential — SAME SiteLink login-conflict constraint as
// lib/pull.js: parallel calls on one account throw -99). Override with SITELINK_PULL_CONCURRENCY.
async function pullPeriod(locations, window, sourceMap, concurrency) {
  const results = new Array(locations.length);
  let next = 0;
  const worker = async () => { while (next < locations.length) { const i = next++; results[i] = pullPeriodForSite(locations[i], window, sourceMap); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, locations.length) }, worker));
  return { range: { start: ymd(window.start), end: ymd(window.end) }, sites: results, totals: aggregate(results) };
}

export async function buildSnapshotPayloadFromRawReport({
  now = new Date(),
  locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean),
  concurrency = Number(process.env.SITELINK_PULL_CONCURRENCY) || 1,
} = {}) {
  if (!locations.length) throw new Error('SITELINK_LOCATIONS not set');
  const windows = snapshotPeriodWindows(now);
  const snapshotReadClient = createAdminClient();
  const sourceMap = await fetchSnapshotSources(locations, windows, snapshotReadClient);
  const missingSources = validateSnapshotSourceCoverage(locations, windows, sourceMap);

  const daily = await pullPeriod(locations, windows.daily, sourceMap, concurrency);
  const weekly = await pullPeriod(locations, windows.weekly, sourceMap, concurrency);
  const quarterly = await pullPeriod(locations, windows.quarterly, sourceMap, concurrency);

  return {
    build_version: SNAPSHOT_PAYLOAD_BUILD_VERSION,
    generated_at: new Date().toISOString(),
    complete: missingSources.length === 0,
    missing_sources: missingSources,
    daily,
    weekly,
    quarterly,
  };
}

async function readStoredSnapshotStatus(now = new Date()) {
  const expectedDailyEnd = ymd(snapshotPeriodWindows(now).daily.end);
  const statusFromPayloadRow = (row) => {
    const payload = row?.payload && typeof row.payload === 'string' ? JSON.parse(row.payload) : row?.payload;
    const dailyEnd = payload?.daily?.range?.end || null;
    const complete = payload?.complete !== false;
    const buildVersionCurrent = payload?.build_version === SNAPSHOT_PAYLOAD_BUILD_VERSION;
    return {
      generatedAt: row?.generated_at || null,
      dailyEnd,
      complete,
      buildVersionCurrent,
      currentEnough: !!(row?.generated_at && dailyEnd === expectedDailyEnd && complete && buildVersionCurrent),
    };
  };
  const statusFromRefreshLogRow = (row) => {
    const detail = String(row?.detail || '');
    const m = detail.match(/daily (\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/);
    const dailyEnd = m?.[2] || null;
    const generatedAt = row?.finished_at || row?.started_at || null;
    return {
      generatedAt,
      dailyEnd,
      complete: true,
      buildVersionCurrent: true,
      currentEnough: !!(generatedAt && dailyEnd === expectedDailyEnd),
    };
  };
  const readSingleRestRow = async (path, label) => {
    if (!SUPABASE_REST_BASE || !SUPABASE_SERVICE_ROLE_KEY) return null;
    const response = await withTransportRetry(
      () => withQueryTimeout(fetch(`${SUPABASE_REST_BASE}/rest/v1/${path}`, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: 'application/json',
          Connection: 'close',
        },
        cache: 'no-store',
      }), 10_000, label),
      4,
      1500,
    );
    if (!response.ok) {
      throw new Error(`${label} failed (${response.status} ${response.statusText})`);
    }
    const data = await response.json();
    return Array.isArray(data) ? (data[0] || null) : data;
  };
  try {
    const db = createAdminClient();
    const { data } = await runRetriedTimedQuery(async () => db.from('snapshot_payload')
      .select('generated_at,payload')
      .eq('id', 1)
      .maybeSingle(), {
      attempts: 4,
      delayMs: 1500,
      timeoutMs: 10_000,
      label: 'stored snapshot status read',
    });
    return statusFromPayloadRow(data);
  } catch {}
  try {
    const db = createAdminClient();
    const { data } = await runRetriedTimedQuery(async () => db.from('refresh_log')
      .select('finished_at,started_at,detail')
      .eq('kind', 'snapshot')
      .eq('status', 'ok')
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle(), {
      attempts: 4,
      delayMs: 1500,
      timeoutMs: 10_000,
      label: 'snapshot success log read',
    });
    return statusFromRefreshLogRow(data);
  } catch {}
  try {
    const row = await readSingleRestRow('snapshot_payload?id=eq.1&select=generated_at,payload', 'stored snapshot status REST read');
    if (row) return statusFromPayloadRow(row);
  } catch {}
  try {
    const row = await readSingleRestRow(
      'refresh_log?kind=eq.snapshot&status=eq.ok&select=finished_at,started_at,detail&order=id.desc&limit=1',
      'snapshot success log REST read',
    );
    if (row) return statusFromRefreshLogRow(row);
  } catch {}
  return null;
}

async function resolveStoredSnapshotStatusAfterFailure({
  now = new Date(),
  initialStatus = null,
  attempts = 2,
  delayMs = 10_000,
} = {}) {
  if (initialStatus?.currentEnough) return initialStatus;
  let status = await readStoredSnapshotStatus(now);
  if (status?.currentEnough) return status;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.warn(`[pull-snapshot] stored snapshot status recheck ${attempt}/${attempts} after transient rebuild failure; waiting ${Math.round(delayMs / 1000)}s for DB pressure to clear...`);
    await sleep(delayMs);
    status = await readStoredSnapshotStatus(now);
    if (status?.currentEnough) return status;
  }
  return status || initialStatus;
}

async function buildSnapshotPayloadWithRetry(options, attempts = 3, delayMs = 15_000) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await buildSnapshotPayloadFromRawReport(options);
    } catch (error) {
      lastError = error;
      const message = describeError(error);
      if (!isRetryableSupabaseMessage(message) || attempt === attempts) throw error;
      console.warn(`[pull-snapshot] payload build attempt ${attempt}/${attempts} failed under transient DB pressure; retrying in ${Math.round(delayMs / 1000)}s: ${message}`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function waitForSnapshotSourceReadiness(locations, now = new Date(), attempts = 6, delayMs = 15_000) {
  const firstLocation = locations?.[0];
  if (!firstLocation) return true;
  const probeMonth = monthKeysForWindow(...(() => {
    const windows = snapshotPeriodWindows(now);
    return [windows.quarterly.start, windows.quarterly.end];
  })()).sort()[0];
  if (!probeMonth) return true;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const db = createAdminClient();
    try {
      const result = await runRetriedTimedQuery(async () => db.from('raw_report')
        .select('raw_response')
        .eq('site_code', firstLocation)
        .eq('report', 'lead_funnel')
        .eq('month', probeMonth)
        .maybeSingle(), { attempts: 2, delayMs: 2500, timeoutMs: 10_000, label: 'snapshot readiness probe' });
      return !!result;
    } catch (error) {
      const message = describeError(error);
      if (!isRetryableSupabaseMessage(message)) throw error;
      if (attempt === attempts) {
        console.warn(`[pull-snapshot] snapshot source readiness probe never stabilized for ${firstLocation} ${probeMonth} lead_funnel; continuing anyway because the payload build has its own retries: ${message}`);
        return false;
      }
      console.warn(`[pull-snapshot] snapshot source readiness probe failed for ${firstLocation} ${probeMonth} lead_funnel; retrying in ${Math.round(delayMs / 1000)}s (${attempt}/${attempts}): ${message}`);
      await sleep(delayMs);
    }
  }
  return false;
}

export async function runSnapshotPull({ concurrency = Number(process.env.SITELINK_PULL_CONCURRENCY) || 1, triggerLabel = null, skipLockCheck = false, disableLogging = false } = {}) {
  // Shares the same overlap guard as the main/cockpit/floor pulls — same SiteLink account, same
  // concurrent-logon (-99) failure mode if two refresh jobs run at once.
  const started = Date.now();
  const startedAtIso = new Date(started).toISOString();
  const finishOrBackfillLog = async (logId, status, detail) => {
    if (disableLogging) return;
    if (logId) return finishPullLog(logId, status, detail);
    return recordCompletedPullLog('snapshot', status, detail, startedAtIso);
  };
  if (!skipLockCheck) {
    const unlocked = await waitForUnlocked();
    if (!unlocked.ok) {
      const blockedLogId = disableLogging ? null : await startPullLogLenient('snapshot', 'snapshot skip');
      console.error('[pull-snapshot] ' + unlocked.message);
      await finishOrBackfillLog(blockedLogId, 'skipped', unlocked.message);
      return { status: 'skipped', message: unlocked.message };
    }
  }
  const logId = disableLogging ? null : await startPullLogLenient('snapshot', 'snapshot');
  if (!disableLogging && !logId) {
    console.warn('[pull-snapshot] refresh_log insert failed under transient DB pressure; continuing without a log row because the payload build has its own retries.');
  }
  if (!skipLockCheck) {
    const claimedLock = await checkPullLock({ activeKinds: ['pull', 'snapshot'], claimingLogId: logId });
    if (claimedLock.locked) {
      console.error('[pull-snapshot] ' + claimedLock.message);
      await finishOrBackfillLog(logId, 'skipped', claimedLock.message);
      return { status: 'skipped', message: claimedLock.message };
    }
  }
  const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!locations.length) { await finishOrBackfillLog(logId, 'error', 'SITELINK_LOCATIONS not set'); throw new Error('SITELINK_LOCATIONS not set'); }
  const storedStatusBeforeRun = await readStoredSnapshotStatus();

  try {
    // Do not block the whole snapshot refresh on a separate "are the source rows readable yet?"
    // probe. The real payload build below already does the authoritative bulk read with its own
    // retries/timeouts, and a single-site readiness hint proved able to fail independently even when
    // the actual build succeeded moments later.
    const payload = await buildSnapshotPayloadWithRetry({ locations, concurrency });
    const missingSources = Array.isArray(payload?.missing_sources) ? payload.missing_sources : [];
    if (missingSources.length) {
      console.warn(`[pull-snapshot] source coverage incomplete (${missingSources.length} missing raw_report row(s)); writing an explicitly incomplete snapshot instead of leaving yesterday's payload in place.`);
    }
    const daily = payload?.daily;
    const weekly = payload?.weekly;
    const quarterly = payload?.quarterly;
    await runRetriedTimedQuery(
      async () => admin.from('snapshot_payload').upsert({ id: 1, generated_at: payload.generated_at, payload }),
      { attempts: 2, delayMs: 2500, timeoutMs: SNAPSHOT_DB_QUERY_TIMEOUT_MS, label: 'snapshot_payload write' },
    );

    const status = missingSources.length ? 'partial' : 'ok';
    await finishOrBackfillLog(
      logId,
      status,
      [
        triggerLabel ? `trigger=${triggerLabel}` : null,
        `daily ${daily.range.start}..${daily.range.end}, weekly ${weekly.range.start}..${weekly.range.end}, quarterly ${quarterly.range.start}..${quarterly.range.end}, ${locations.length} sites${missingSources.length ? `, ${missingSources.length} missing source row(s)` : ''}`,
      ].filter(Boolean).join(' | '),
    );
    return { status, durationMs: Date.now() - started, sites: locations.length, missingSources: missingSources.length };
  } catch (e) {
    const retryableFailure = isRetryableSupabaseMessage(describeError(e));
    const storedStatus = retryableFailure
      ? await resolveStoredSnapshotStatusAfterFailure({ initialStatus: storedStatusBeforeRun })
      : ((await readStoredSnapshotStatus()) || storedStatusBeforeRun);
    if (storedStatus?.currentEnough) {
      const detail = [
        triggerLabel ? `trigger=${triggerLabel}` : null,
        `stored snapshot already current through ${storedStatus.dailyEnd}; raw_report rebuild failed under transient DB pressure (${describeError(e)})`,
      ].filter(Boolean).join(' | ');
      await finishOrBackfillLog(logId, 'partial', detail);
      return {
        status: 'partial',
        durationMs: Date.now() - started,
        sites: locations.length,
        missingSources: 0,
        alreadyCurrent: true,
      };
    }
    await finishOrBackfillLog(logId, 'error', describeError(e));
    throw e;
  }
}
