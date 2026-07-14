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
// Deliberately makes a SEPARATE SiteLink call per period per report per site (3 x 2 x 29 = 174
// calls), rather than fetching one wide (quarterly) window and slicing it three ways client-side.
// Reason: REPORTS.lead_funnel.parse's enquiries counter IS already date-filtered internally
// (isPlacedInWindow) so slicing would work for that one field — but its reservation counter
// (reservationStageCount) is NOT date-filtered, it trusts the SOAP-level range entirely. Slicing one
// wide fetch three ways would silently give the SAME (quarter-total) reservation count for all three
// periods. Three separate properly-scoped calls reuse the existing, already-verified parsers
// completely unmodified — correct by construction, at the cost of more calls. Can be optimized later
// if a reliable per-row date field turns up for client-side slicing.
//
// Metrics: enquiries + reservations (InquiryTracking / lead_funnel parser), move-ins + sqft in/out
// (MoveInsAndMoveOuts / move_ins_outs parser). "Reservation backlog" (forward move-ins, Michael's
// pick) is NOT yet included — it depends on confirming whether InquiryTracking carries a usable
// target-move-in-date field. Add once confirmed; every other metric here doesn't need it.
//
// Run manually: npm run pull:snapshot (no timeout — plain Node script).
// Or via HTTP: GET /api/pull-snapshot (needs Vercel Pro for maxDuration=300; see that route's comment).
import { admin } from './supabaseAdmin.js';
import { REPORTS } from './reportMap.js';
import { callReport } from './sitelink.js';
import { checkPullLock, startPullLog, finishPullLog } from './pullLock.js';
import { describeError } from './describeError.js';

const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function periodWindows() {
  const yesterday = dayOnly(addDays(new Date(), -1));
  const daily = { start: yesterday, end: yesterday };
  const weekly = { start: addDays(yesterday, -6), end: yesterday };
  const qMonth = Math.floor(yesterday.getMonth() / 3) * 3;
  const quarterly = { start: new Date(yesterday.getFullYear(), qMonth, 1), end: yesterday };
  return { daily, weekly, quarterly };
}

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
  const [inq, mio] = await Promise.all([
    tryCall('InquiryTracking', loc, start, end),
    tryCall('MoveInsAndMoveOuts', loc, start, end),
  ]);
  const lf = REPORTS.lead_funnel.parse(inq.rows, start, end);
  const mo = REPORTS.move_ins_outs.parse(mio.rows);
  return {
    code: loc,
    enquiries: lf.total_enquiries,
    reservations: lf.reservation_stage_count,
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
