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
// practice — this pull only runs ONCE a day (0 6 * * *), so "today" was frozen at whatever had
// happened by that one early-morning run and looked artificially near-zero for the rest of the day,
// exactly the "today is always in-progress/incomplete" problem the yesterday-anchor was originally
// chosen to avoid. Back to yesterday: a genuine, complete, finished day's total, not a partial one.
//
// Deliberately makes a SEPARATE SiteLink call per period per report per site (3 x 2 x 29 = 174
// calls), rather than fetching one wide (quarterly) window and slicing it three ways client-side.
// Reason: REPORTS.lead_funnel.parse's enquiries AND reservation counters are both date-filtered
// internally (isPlacedInWindow, gated as of task #308's 17 Jul fix) so slicing would actually work
// for lead_funnel's own fields now — but REPORTS.move_ins_outs.parse (moveIns/moveOuts/sqftIn/
// sqftOut) still has no date-window filter of its own (confirmed 23 Jul, task #406/#407) and trusts
// the SOAP-level range entirely. Slicing one wide fetch three ways would silently give the SAME
// (quarter-total) move-in/move-out figures for all three periods. Three separate properly-scoped
// calls reuse the existing, already-verified parsers completely unmodified — correct by
// construction, at the cost of more calls. Can be optimized later if move_ins_outs gains its own
// date filter (see pullPeriodForSite's local MoveDate trim below for why that wasn't done inside
// the shared parser itself).
//
// Metrics: enquiries + reservations (InquiryTracking / lead_funnel parser), move-ins + sqft in/out
// (MoveInsAndMoveOuts / move_ins_outs parser). "Reservation backlog" (forward move-ins, Michael's
// pick) is NOT yet included — it depends on confirming whether InquiryTracking carries a usable
// target-move-in-date field. Add once confirmed; every other metric here doesn't need it.
//
// Run manually: npm run pull:snapshot (no timeout — plain Node script).
// Or via HTTP: GET /api/pull-snapshot — now scheduled daily via vercel.json (0 6 * * *); 300s duration
// works fine on Hobby too (see that route's comment for why the old "needs Pro" note was outdated).
import { admin } from './supabaseAdmin.js';
import { REPORTS } from './reportMap.js';
import { callReport, extractNamedTable } from './sitelink.js';
import { checkPullLock, startPullLog, finishPullLog } from './pullLock.js';
import { describeError } from './describeError.js';

const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

function periodWindows() {
  const yesterday = dayOnly(addDays(new Date(), -1));
  const daily = { start: yesterday, end: yesterday };
  const weekly = { start: addDays(yesterday, -6), end: yesterday };
  const qMonth = Math.floor(yesterday.getMonth() / 3) * 3;
  const quarterly = { start: new Date(yesterday.getFullYear(), qMonth, 1), end: yesterday };
  return { daily, weekly, quarterly };
}

// FIXED 23 Jul 2026 (task #406/#407, Michael: "abingdon shows 0 reservations in the daily
// snapshot"). Confirmed via probe-daily-window-boundary.js (a real, known 10:35am reservation
// silently dropped by a same-day start=end query) and probe-monthend-exclusive-bug.js (same
// exclusion at full-range scale, for InquiryTracking): SiteLink's dReportDateEnd excludes the
// ENTIRE calendar day it falls on, not "up through" that day. `daily`'s start=end=yesterday is
// exactly the degenerate zero-width case this hits hardest, but weekly/quarterly lose their last
// day the same way. Only the SOAP call's end bound needs to move to the start of the day AFTER
// the period's true last day — parse()-level start/end below stay as the period's REAL boundaries,
// so reportMap.js's own date-window filters (lead_funnel's isPlacedInWindow, and the local
// MoveInsAndMoveOuts trim added below) correctly discard the extra day again rather than also
// counting it. NOTE: this is the opposite conclusion from today's Real Rate investigation (task
// #405), where the same SiteLink behaviour turned out to be baked into legacy's own historical
// figures too and "fixing" it made the legacy comparison worse — that reasoning doesn't apply
// here, since this page has no legacy equivalent to match; it just needs to show what actually
// happened yesterday, complete.
const soapEndBound = (end) => addDays(dayOnly(end), 1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// same one-retry backoff as lib/pull.js — absorbs SiteLink's transient -99 logon / -90 busy / timeouts
async function tryCall(method, loc, start, end) {
  const backoff = [0, 2000, 5000];
  for (let attempt = 1; ; attempt++) {
    try { return await callReport(method, loc, start, end); }
    catch (e) { if (attempt >= backoff.length) throw e; await sleep(backoff[attempt]); }
  }
}

async function pullPeriodForSite(loc, { start, end }) {
  // soapEndBound(end), not end, for the actual SiteLink calls — see soapEndBound's comment above.
  // start is untouched: only the end bound was ever confirmed exclusive.
  const soapEnd = soapEndBound(end);
  const [inq, mio] = await Promise.all([
    tryCall('InquiryTracking', loc, start, soapEnd),
    tryCall('MoveInsAndMoveOuts', loc, start, soapEnd),
  ]);
  // FIXED 21 Jul 2026 (Michael: "my enquiries and reservation are empty" on the Weekly/Daily/Quarterly
  // Snapshot page). lead_funnel's parser reads its working rows via
  // `extractNamedTable(raw, 'Activity')` (see lib/reportMap.js), NOT the `rows` arg passed in below —
  // that changed when task #325 fixed InquiryTracking's multi-table selection reliability, and every
  // OTHER caller goes through reportMap.js's pullReport() helper, which already threads `raw` through
  // (`r.parse(rows, startDate, endDate, raw)`). This file calls REPORTS.lead_funnel.parse() directly,
  // bypassing that helper, and was never updated when the parser grew its 4th argument — so `raw` was
  // always undefined here, extractNamedTable(undefined, 'Activity') returned nothing, and every
  // counter this parser produces (enquiries, reservation_stage_count, channels, etc.) silently came
  // out as 0 for all three periods. tryCall()/callReport() (lib/sitelink.js) already returns
  // `{ rows, raw }`, so `inq.raw` was sitting right there unused. Move-ins/Move-outs and Sqft In/Out
  // on this same page were unaffected — move_ins_outs's parser only ever needed `rows`.
  //
  // start/end here (NOT soapEnd) — lead_funnel's isPlacedInWindow re-trims by dPlaced's own calendar
  // date regardless of how wide the underlying SOAP response is, so passing the true period bounds
  // correctly discards whatever the widened soapEnd call above pulled in beyond `end`.
  const lf = REPORTS.lead_funnel.parse(inq.rows, start, end, inq.raw);
  // ADDED 23 Jul 2026 (task #406/#407, same fix as above): REPORTS.move_ins_outs.parse() (lib/
  // reportMap.js) has no date-window filter of its own — confirmed it's only ever called two other
  // ways: this file (previously bare `rows`) and reportMap.js's own generic pullReport() dispatcher,
  // which calls every report's parse() as `r.parse(rows, startDate, endDate, raw)` regardless of
  // what the target function declares. Adding a filter INSIDE move_ins_outs.parse() itself would
  // silently start affecting that generic path too — the main historical pipeline behind
  // buildPayload.js's move-ins/move-outs figures, not just this page. That's a much bigger, unverified
  // change than this bug needs, so the trim stays local to this file instead: soapEnd above may pull
  // in one extra day beyond `end` (to satisfy SiteLink), so cut rows back to the true [start, end]
  // window by MoveDate before handing off to the unmodified shared parser.
  //
  // UPDATED 23 Jul 2026 (task #406/#409): mio.rows (extractRows()'s pick, lib/sitelink.js) can never
  // see a single real row — node-soap/xml2js doesn't array-wrap a repeated element that occurs exactly
  // once, so a lone real move event comes through as a bare object, invisible to extractRows()
  // (confirmed live: Abingdon/22 Jul's Boyles/125sqft move-in — see probe-mio-single-row-fields.js).
  // extractNamedTable() (lib/sitelink.js, same date) is now fixed to also recognize that bare-object
  // shape, so re-derive from mio.raw directly instead of trusting mio.rows. Still trimmed locally by
  // MoveDate exactly as before, and still passed to REPORTS.move_ins_outs.parse() as a bare `rows` arg
  // with no `raw` — that function now prefers re-deriving from `raw` via extractNamedTable() whenever
  // raw IS passed (see its own comment), which would undo this file's local trim by going back to the
  // wider soapEnd-bounded response. Passing only the already-extracted-and-trimmed array keeps this
  // page's date-window handling exactly as it was, while fixing the single-row blind spot underneath it.
  const startDay = ymd(start), endDay = ymd(end);
  const mioRowsFixed = extractNamedTable(mio.raw, 'UnitMoveInsAndMoveOuts');
  const trimmedMioRows = mioRowsFixed.filter((r) => {
    if (!r.MoveDate) return false;
    const day = sourceDayKey(r.MoveDate);
    return !!day && day >= startDay && day <= endDay;
  });
  const mo = REPORTS.move_ins_outs.parse(trimmedMioRows);
  return {
    code: loc,
    // FIXED 24 Jul 2026 (deep audit): snapshot enquiries/reservations were still using the broader
    // all-channel InquiryTracking totals (Email included for enquiries; aggregate conversion table for
    // reservations) after the visible Marketing page was corrected to the deployed legacy page's
    // displayed Phone/Web/Walk-in basis. That let snapshot windows contradict Marketing for the same
    // stores and dates. Align snapshot counts to the same visible basis: enquiries = Phone + Walk-in
    // + Web, reservations = visible converted enquiries across those same 3 channels.
    enquiries: visibleSnapshotEnquiries(lf),
    // SWITCHED 24 Jul 2026 (task #422) from visibleSnapshotReservations(lf) (dPlaced + volatile
    // iInquiryConvertedToLease flag — see that removed function's comment, kept above for the full
    // history) to countReservationsInWindow(inq.raw, start, end): dConverted_ToRsv + sRentalType===
    // "Reservation", computed directly from inq.raw rather than through lf/reportMap.js's shared
    // channels object, so the Marketing page's monthly ratio (a different, already-validated metric
    // built from the same parser) is untouched by this change.
    reservations: countReservationsInWindow(inq.raw, start, end),
    reservationBacklog: null,   // TODO: add once InquiryTracking exposes a reliable move-in target date
    moveIns: mo.move_ins,
    moveOuts: mo.move_outs,
    sqftIn: mo.moved_in_area,
    sqftOut: mo.moved_out_area,
  };
}

function aggregate(sites) {
  const sum = (k) => sites.reduce((a, s) => a + (s[k] || 0), 0);
  return {
    enquiries: sum('enquiries'), reservations: sum('reservations'), reservationBacklog: null,
    moveIns: sum('moveIns'), moveOuts: sum('moveOuts'), sqftIn: sum('sqftIn'), sqftOut: sum('sqftOut'),
  };
}

// concurrency pool over locations (default sequential — SAME SiteLink login-conflict constraint as
// lib/pull.js: parallel calls on one account throw -99). Override with SITELINK_PULL_CONCURRENCY.
async function pullPeriod(locations, window, concurrency) {
  const results = new Array(locations.length);
  let next = 0;
  const worker = async () => { while (next < locations.length) { const i = next++; results[i] = await pullPeriodForSite(locations[i], window); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, locations.length) }, worker));
  return { range: { start: ymd(window.start), end: ymd(window.end) }, sites: results, totals: aggregate(results) };
}

export async function runSnapshotPull({ concurrency = Number(process.env.SITELINK_PULL_CONCURRENCY) || 1 } = {}) {
  // Overlap guard (10 Jul 2026, roadmap #93): shares ONE lock with lib/pull.js's main pull — see
  // lib/pullLock.js's header for why a snapshot pull and a main pull can't safely run at the same
  // time either (same SiteLink account, same -99 concurrent-logon conflict).
  const lock = await checkPullLock();
  if (lock.locked) { console.error('[pull-snapshot] ' + lock.message); return { status: 'skipped', message: lock.message }; }

  const started = Date.now();
  const logId = await startPullLog('snapshot');
  const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!locations.length) { await finishPullLog(logId, 'error', 'SITELINK_LOCATIONS not set'); throw new Error('SITELINK_LOCATIONS not set'); }

  try {
    const windows = periodWindows();
    console.error(`[pull-snapshot] ${locations.length} sites x 3 periods x 2 reports = ${locations.length * 6} calls…`);

    const daily = await pullPeriod(locations, windows.daily, concurrency);
    console.error('[pull-snapshot] daily done');
    const weekly = await pullPeriod(locations, windows.weekly, concurrency);
    console.error('[pull-snapshot] weekly done');
    const quarterly = await pullPeriod(locations, windows.quarterly, concurrency);
    console.error('[pull-snapshot] quarterly done');

    const payload = { generated_at: new Date().toISOString(), daily, weekly, quarterly };
    const { error } = await admin.from('snapshot_payload').upsert({ id: 1, generated_at: payload.generated_at, payload });
    if (error) throw new Error('snapshot_payload write failed: ' + error.message);

    await finishPullLog(logId, 'ok', null);
    return { status: 'ok', durationMs: Date.now() - started, sites: locations.length };
  } catch (e) {
    await finishPullLog(logId, 'error', describeError(e));
    throw e;
  }
}
