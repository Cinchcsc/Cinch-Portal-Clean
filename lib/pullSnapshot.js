// Weekly/Daily/Quarterly Snapshot (roadmap #5/#6, Michael's decision 9 Jul 2026: "live range query"
// — period totals, not a day-by-day trend chart). Writes ONE overwritten row to snapshot_payload,
// same single-row pattern as portal_payload — see supabase/schema.sql.
//
// CHANGED 21 Jul 2026 (Michael: "its the daily snapshot so it needs to be enquiries and reservations
// today") — all three periods now run through TODAY, not yesterday. Originally capped at yesterday
// on the reasoning that "today is always in-progress/incomplete" (the same call pull.js makes for the
// current calendar month's OWN figures) — but "Daily" reading as "the last fully-finished day" instead
// of "today's numbers" wasn't what Michael expected, so this now matches that expectation instead,
// same "live, in-progress, to-date" treatment pull.js already gives the current month elsewhere.
//   daily     = today so far
//   weekly    = the 7 days ending today (inclusive)
//   quarterly = quarter-to-date (start of the calendar quarter containing today) through today
//
// CAVEAT this creates, worth knowing: this pull still only runs ONCE a day (0 6 * * * — see below).
// "Today so far" is only as fresh as that one morning run: an enquiry logged at 2pm won't appear until
// TOMORROW morning's pull, at which point "today" rolls over to the next calendar day and briefly
// shows a near-empty number again before filling back in over the following 24h. If this needs to stay
// current through the day, pull-snapshot has to run more than once a day (each run is ~60-70s per
// refresh_log, well within budget to repeat a few times) — flagged, not done here, since adding cron
// runs is more of an infra/SiteLink-call-volume decision than a date-math fix.
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
// Or via HTTP: GET /api/pull-snapshot — now scheduled daily via vercel.json (0 6 * * *); 300s duration
// works fine on Hobby too (see that route's comment for why the old "needs Pro" note was outdated).
import { admin } from './supabaseAdmin.js';
import { REPORTS } from './reportMap.js';
import { callReport } from './sitelink.js';
import { checkPullLock, startPullLog, finishPullLog } from './pullLock.js';
import { describeError } from './describeError.js';

const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function periodWindows() {
  const today = dayOnly(new Date());
  const daily = { start: today, end: today };
  const weekly = { start: addDays(today, -6), end: today };
  const qMonth = Math.floor(today.getMonth() / 3) * 3;
  const quarterly = { start: new Date(today.getFullYear(), qMonth, 1), end: today };
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
  const lf = REPORTS.lead_funnel.parse(inq.rows, start, end, inq.raw);
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
