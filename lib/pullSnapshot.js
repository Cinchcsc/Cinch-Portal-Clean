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
import { admin } from './supabaseAdmin.js';
import { REPORTS } from './reportMap.js';
import { extractNamedTable } from './sitelink.js';
import { STALE_MS, checkPullLock, startPullLogLenient, finishPullLog } from './pullLock.js';
import { describeError } from './describeError.js';
import { formatLocalYmd, lastCompleteDay } from './reportingPeriod.js';
import { retryOnStatementTimeout } from './supabaseRetry.js';

export const SNAPSHOT_PAYLOAD_BUILD_VERSION = '2026-08-04-raw-report-v2';

const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const ymd = (d) => formatLocalYmd(d);
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
    await new Promise((res) => setTimeout(res, nextWaitMs));
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

async function fetchSnapshotSources(locations, windows) {
  const wantedMonths = [...new Set(
    Object.values(windows).flatMap((window) => monthKeysForWindow(window.start, window.end))
  )];
  const mergeRowsIntoMap = (rows, out, chosenAt) => {
    for (const row of rows || []) {
      const key = `${row.site_code}|${String(row.month).slice(0, 7)}|${row.report}`;
      const atMs = timestampMs(row.pulled_at);
      if (chosenAt.has(key) && atMs <= (chosenAt.get(key) || 0)) continue;
      chosenAt.set(key, atMs);
      out.set(key, row.raw_response || null);
    }
  };
  const fetchRowsForReports = async (reports, pageSize = 100) => {
    const rows = [];
    try {
      let lastId = 0;
      for (;;) {
        const { data, error } = await retryOnStatementTimeout(async () => admin.from('raw_report')
          .select('id,site_code,month,report,raw_response,pulled_at')
          .in('site_code', locations)
          .in('report', reports)
          .in('month', wantedMonths)
          .gt('id', lastId)
          .order('id')
          .limit(pageSize));
        if (error) throw new Error(error.message);
        rows.push(...(data || []));
        if (!data || data.length < pageSize) break;
        lastId = data[data.length - 1].id;
      }
      return rows;
    } catch (error) {
      const nextPageSize = Math.max(10, Math.floor(pageSize / 2));
      if (nextPageSize < pageSize) {
        console.warn(`[pullSnapshot] snapshot source fetch for ${reports.join(', ')} failed at pageSize=${pageSize}; retrying with smaller pages (${nextPageSize}):`, error?.message || error);
        return fetchRowsForReports(reports, nextPageSize);
      }
      if (reports.length > 1) {
        console.warn(`[pullSnapshot] combined snapshot source fetch failed for ${reports.join(', ')}; retrying report-by-report:`, error?.message || error);
        const out = [];
        for (const report of reports) {
          out.push(...(await fetchRowsForReports([report], 50)));
        }
        return out;
      }
      throw error;
    }
  };
  const out = new Map();
  const chosenAt = new Map();
  mergeRowsIntoMap(await fetchRowsForReports(['lead_funnel', 'move_ins_outs']), out, chosenAt);
  return out;
}

export async function latestSnapshotSourcePulledAt(locations, windows) {
  const wantedMonths = [...new Set(
    Object.values(windows).flatMap((window) => monthKeysForWindow(window.start, window.end))
  )];
  const { data, error } = await retryOnStatementTimeout(async () => admin.from('raw_report')
    .select('pulled_at')
    .in('site_code', locations)
    .in('report', ['lead_funnel', 'move_ins_outs'])
    .in('month', wantedMonths)
    .order('pulled_at', { ascending: false })
    .limit(1));
  if (error) throw new Error(error.message);
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
  const sourceMap = await fetchSnapshotSources(locations, windows);
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

export async function runSnapshotPull({ concurrency = Number(process.env.SITELINK_PULL_CONCURRENCY) || 1, triggerLabel = null } = {}) {
  // Shares the same overlap guard as the main/cockpit/floor pulls — same SiteLink account, same
  // concurrent-logon (-99) failure mode if two refresh jobs run at once.
  const started = Date.now();
  const unlocked = await waitForUnlocked();
  if (!unlocked.ok) {
    const blockedLogId = await startPullLogLenient('snapshot', 'snapshot skip');
    console.error('[pull-snapshot] ' + unlocked.message);
    await finishPullLog(blockedLogId, 'skipped', unlocked.message);
    return { status: 'skipped', message: unlocked.message };
  }
  const logId = await startPullLogLenient('snapshot', 'snapshot');
  const claimedLock = await checkPullLock({ activeKinds: ['pull', 'snapshot'], claimingLogId: logId });
  if (claimedLock.locked) {
    console.error('[pull-snapshot] ' + claimedLock.message);
    await finishPullLog(logId, 'skipped', claimedLock.message);
    return { status: 'skipped', message: claimedLock.message };
  }
  const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!locations.length) { await finishPullLog(logId, 'error', 'SITELINK_LOCATIONS not set'); throw new Error('SITELINK_LOCATIONS not set'); }

  try {
    const payload = await buildSnapshotPayloadFromRawReport({ locations, concurrency });
    const missingSources = Array.isArray(payload?.missing_sources) ? payload.missing_sources : [];
    if (missingSources.length) {
      console.warn(`[pull-snapshot] source coverage incomplete (${missingSources.length} missing raw_report row(s)); writing an explicitly incomplete snapshot instead of leaving yesterday's payload in place.`);
    }
    const daily = payload?.daily;
    const weekly = payload?.weekly;
    const quarterly = payload?.quarterly;
    const { error } = await retryOnStatementTimeout(async () => admin.from('snapshot_payload').upsert({ id: 1, generated_at: payload.generated_at, payload }));
    if (error) throw new Error('snapshot_payload write failed: ' + error.message);

    const status = missingSources.length ? 'partial' : 'ok';
    await finishPullLog(
      logId,
      status,
      [
        triggerLabel ? `trigger=${triggerLabel}` : null,
        `daily ${daily.range.start}..${daily.range.end}, weekly ${weekly.range.start}..${weekly.range.end}, quarterly ${quarterly.range.start}..${quarterly.range.end}, ${locations.length} sites${missingSources.length ? `, ${missingSources.length} missing source row(s)` : ''}`,
      ].filter(Boolean).join(' | '),
    );
    return { status, durationMs: Date.now() - started, sites: locations.length, missingSources: missingSources.length };
  } catch (e) {
    await finishPullLog(logId, 'error', describeError(e));
    throw e;
  }
}
