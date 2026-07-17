// Orchestrates a refresh: for each location pull the configured reports, store the aggregated
// (no-PII) rows, then rebuild the portal payload. Locations run concurrently (pool) to fit the cron
// time budget; per-call failures are logged and skipped. Occupancy is pulled for the last complete
// month AND the month before (MoM deltas + trend history); the other reports for the last complete
// month only. Override with { reports, concurrency } if needed.
import { admin } from './supabaseAdmin.js';
import { pullReport, REPORTS } from './reportMap.js';
import { buildPayload } from './buildPayload.js';
import { checkPullLock, startPullLog, finishPullLog } from './pullLock.js';
import { describeError } from './describeError.js';

const firstOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; // local YYYY-MM-01 (avoid UTC day-shift)
const DEFAULT_REPORTS = ['occupancy', 'rent_roll', 'management', 'move_ins_outs', 'past_due', 'scheduled_outs',
  'insurance_roll', 'insurance_activity', 'lead_funnel', 'marketing', 'merchandise', 'financial', 'rate_changes',
  'reservations', 'true_revenue', 'rental_activity', 'discounts'];
// occupancy: pulled for prev month too (deltas + trend). management/lead_funnel/move_ins_outs:
// pulled for prev month too because these are FLOW/count metrics (Enquiries, Move-ins & Move-outs)
// that the legacy portal reports for the LAST COMPLETE MONTH, not the in-progress current month —
// confirmed 2 Jul 2026 (Michael): target numbers were tagged "JUN 2026" while "current month" here
// was already July, so the in-progress month's 1-2 days of data could never match. See buildPayload.js.
// insurance_activity/merchandise/rent_roll ADDED 3 Jul 2026 — found while digging into "Ancillaries
// numbers all over the place": buildPayload.js's sites-loop overrides s.enquiries/moveIns/moveOuts
// to the previous complete month, but Insurance Conversion (insuranceActivity), Merchandise Sales/
// Income (merchandise), and Autobill Conversion's new-customer denominator (rent_roll's
// autobill_tenant_ids, cross-referenced against move_ins_outs) were STILL being read from the
// in-progress current month — a numerator/denominator month mismatch (e.g. Insurance Conversion's
// newPolicies from ~3 days of July over moveIns from all of June) that would explain badly-off
// Ancillaries figures independent of any formula bug. These reports must be pulled for the previous
// month too before buildPayload.js can override them the same way.
// true_revenue ADDED 3 Jul 2026 (found while chasing "True Revenue values off by £1M+"): same class
// of bug as insurance_activity/merchandise/rent_roll above — it's ALSO a full-calendar-month flow
// metric (SiteLink's own "Daily Pro Rate" custom report, summed across the days in the period), but
// was being read from the in-progress CURRENT month (2-3 days of data) while Michael's legacy
// comparison screenshots are for the last COMPLETE month (June). Confirmed via
// probe:true-revenue-scope that the report itself correctly respects date params (totals scale down
// with a narrower window) — the bug was which month we asked for, not the report's own scoping.
// rental_activity ADDED 3 Jul 2026 (new "Unit Mix Detail" page, built from Michael's uploaded
// Rental Activity export): its MovedIn/MovedOut/Transfers/Net columns are the same class of
// full-calendar-month flow metric as Enquiries/Move-ins, so it needs the previous complete month too.
// financial ADDED 6 Jul 2026: Merchandise Sales switched to FinancialSummary's own "Merchandise"
// charge category (see buildPayload.js's chargeFromFinancial) to match the legacy portal's
// confirmed source — same full-calendar-month flow metric class, needs the previous complete month.
// insurance_roll ADDED 6 Jul 2026: Insurance Premiums (New Customers) switched from
// InsuranceActivity's unreliable `sNewPolicy` flag to a TenantID cross-reference against
// InsuranceRoll's per-tenant premium/coverage (see buildPayload.js's insuredNewCustomers) — that
// cross-reference needs THIS report for the previous complete month too, same as move_ins_outs.
// discounts ADDED 9 Jul 2026 (Discount Summary page + Move-in Variance KPI widget, Michael's
// "monthly flow" decision): same class as rental_activity/financial above — plan usage/£ discount
// and the move-in variance figure are both full-calendar-month flow metrics, need the previous
// complete month too so buildPayload.js can override the in-progress current month the same way.
const TWO_MONTH = new Set(['occupancy', 'management', 'lead_funnel', 'move_ins_outs', 'insurance_activity', 'merchandise', 'rent_roll', 'true_revenue', 'rental_activity', 'financial', 'insurance_roll', 'discounts']);

// SiteLink throws -99 "General Exception from LogOn" when the same account logs on in parallel, so
// default to SEQUENTIAL (concurrency 1) — proven reliable. Override with SITELINK_PULL_CONCURRENCY.
// rebuildPayload — ADDED 17 Jul 2026 (task #297 fix): the buildPayload()+portal_payload upsert below
// used to run unconditionally at the end of EVERY runPull() call, competing with that same call's own
// SiteLink report-pulling for ONE shared 300s Vercel maxDuration budget. refresh_log shows this dying
// mid-rebuild on 3 consecutive days (14-16 Jul), always the day's LAST cron pull batch to fire — a
// hard platform timeout kill happens OUTSIDE the JS runtime, so it can't be caught by the try/catch
// below, finishPullLog() never runs, and that day's portal_payload rebuild silently doesn't happen
// (the per-site raw_report writes earlier in the same run are unaffected — they complete before this
// step is ever reached). Upgrading to Vercel Pro doesn't raise the ceiling either — 300s is already
// Hobby's default AND max (see app/api/pull/route.js's own comment) — so the real fix is architectural:
// stop asking one invocation to do both jobs. Defaults to true so scripts/run-pull.js (plain local
// Node, no timeout) keeps its existing all-in-one behavior with an immediate reconciliation printout.
// The Vercel-cron path (app/api/pull/route.js) now always passes false and relies entirely on the new
// dedicated /api/rebuild-payload cron (its own untouched 300s budget, scheduled after every report-
// pulling batch has had its own hour to finish) — see vercel.json.
export async function runPull({ reports, concurrency = Number(process.env.SITELINK_PULL_CONCURRENCY) || 1, rebuildPayload = true } = {}) {
  const lock = await checkPullLock();
  if (lock.locked) { console.error('[pull] ' + lock.message); return { status: 'skipped', message: lock.message }; }
  const started = Date.now();
  const logId = await startPullLog('pull');

  const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!locations.length) throw new Error('SITELINK_LOCATIONS not set');
  const { error: sErr } = await admin.from('sites').upsert(locations.map(code => ({ code, name: code })), { onConflict: 'code', ignoreDuplicates: true });
  if (sErr) throw new Error('sites seed failed (run `npm run init:sites` to see why): ' + sErr.message);

  const now = new Date();
  // Display the LIVE, IN-PROGRESS month — the old portal shows the current month (month-to-date),
  // not the last complete one. endOf() caps the range at "now" so flows are month-to-date. The previous
  // (last complete) month drives MoM deltas and stays available in the selector.
  const months = [firstOfMonth(now), firstOfMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1))];
  const reportKeys = (reports || DEFAULT_REPORTS).filter(k => REPORTS[k]);

  const errors = []; let ok = 0;
  const endOf = (month) => { let e = new Date(month.getFullYear(), month.getMonth() + 1, 0); if (e > now) e = now; return e; };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // one retry absorbs SiteLink's transient "server busy" (-90) and call timeouts
  async function tryPull(key, loc, month) {
    const backoff = [0, 2000, 5000];   // absorb transient -99 logon / -90 busy / timeouts
    for (let attempt = 1; ; attempt++) {
      try { return await pullReport(key, loc, month, endOf(month)); }
      catch (e) { if (attempt >= backoff.length) throw e; await sleep(backoff[attempt]); }
    }
  }

  // Once the "previous" month is CLOSED, its data must be set in stone — never re-pulled or
  // overwritten again (confirmed 6 Jul 2026: Michael noticed Rate/ft² for "Jun 2026" changing
  // between two same-day pulls, because RentRoll/OccupancyStatistics are point-in-time snapshots,
  // not real historical "as of" reports — every pull silently re-captured TODAY's live state under
  // June's label. Fix: only the CURRENT (in-progress) month is ever pulled fresh; the previous
  // month is pulled/written exactly once — the first time it's seen as "previous" — and every pull
  // after that skips it entirely (both the SiteLink call and the DB write), locking in whatever was
  // last captured while it was still the live current month. This applies to every report, not just
  // rent_roll/occupancy — flow metrics were already effectively frozen via buildPayload.js's
  // override, but this makes the underlying stored data itself immutable too, belt-and-braces.
  const prevMonthKey = ymd(months[1]);
  // FIXED 13 Jul 2026 (pre-go-live re-audit): was a single unpaginated .select() — same bug class
  // already fixed elsewhere (buildPayload.js's fetchAllRaw()/autobill_daily, the backfill script).
  // Currently ~29 sites × ~17 reports ≈ 493 rows, under the 1000-row cap, but this feeds prevLocked —
  // the very mechanism that keeps a CLOSED month immutable — so a silent truncation here would let
  // some (site,report) pairs be wrongly treated as "not yet locked" and re-pulled/overwritten, exactly
  // what this code exists to prevent. Paginated preemptively, ahead of the ~59-site threshold where
  // this would start truncating for real.
  const existingPrev = []; const PREV_PAGE = 1000;
  for (let from = 0; ; from += PREV_PAGE) {
    const { data, error } = await admin.from('raw_report').select('site_code,report').eq('month', prevMonthKey).order('id').range(from, from + PREV_PAGE - 1);
    if (error) throw new Error(error.message);
    existingPrev.push(...(data || []));
    if (!data || data.length < PREV_PAGE) break;
  }
  const prevLocked = new Set(existingPrev.map(r => `${r.site_code}|${r.report}`));

  // AUTOBILL DAILY SAMPLE data dependency — FIXED 16 Jul 2026 (task #295, Michael: "the autobill and
  // insurance conversion look like they have problems"): this used to rely on curMoveInsOuts/
  // curRentRoll captured ONLY from THIS invocation's own report pulls below, which silently required
  // 'rent_roll' AND 'move_ins_outs' to both be in reportKeys TOGETHER in the same run. That held back
  // when cron ran a single daily pull, but the 13 Jul cron split (4a0b708, done to dodge the 300s
  // function timeout on the full 17-report pull) put rent_roll in the 1am LIGHT batch and
  // move_ins_outs in the 2am batch — no scheduled invocation has included both since, so
  // autobill_daily silently stopped getting new samples PORTFOLIO-WIDE from 14 Jul onward. Confirmed
  // via Supabase: every one of the 29 sites shows exactly 3 samples (dated 9/10/13 Jul, all from
  // manual/ad-hoc full pulls before or during that day's cron-split rollout) and none since — even on
  // 16 Jul, when both the 1am and 2am cron runs completed with zero errors, because the condition
  // below could structurally never be true again. Fix: read the CURRENT month's already-persisted
  // move_ins_outs/rent_roll back from raw_report (one small query each, current month + single report
  // key, well under any pagination concern) instead of relying on this run's own in-memory captures —
  // works no matter which reports this particular invocation pulled, and is robust to any future
  // re-splitting of the cron schedule.
  const curMonthKey = ymd(months[0]);
  const { data: micRows } = await admin.from('raw_report').select('site_code,data').eq('month', curMonthKey).eq('report', 'move_ins_outs');
  const { data: rrRows } = await admin.from('raw_report').select('site_code,data').eq('month', curMonthKey).eq('report', 'rent_roll');
  const micMap = new Map((micRows || []).map(r => [r.site_code, r.data]));
  const rrMap = new Map((rrRows || []).map(r => [r.site_code, r.data]));

  async function pullLoc(loc) {
    for (const key of reportKeys) {                                  // reports sequential within a location
      const ms = TWO_MONTH.has(key) ? months : [months[0]];
      for (const month of ms) {
        const isPrev = month === months[1];
        if (isPrev && prevLocked.has(`${loc}|${key}`)) continue;     // already captured while it was current — locked, skip
        try {
          // raw ADDED 7 Jul 2026 (raw-storage change): stores the untouched SiteLink response
          // alongside the parsed `data` so a future parser fix can be replayed via
          // scripts/reparse-report.js instead of requiring another live SiteLink pull.
          const { data, raw } = await tryPull(key, loc, month);
          const { error } = await admin.from('raw_report').upsert(
            { site_code: loc, month: ymd(month), report: key, data, raw_response: raw ?? null, pulled_at: new Date().toISOString() },
            { onConflict: 'site_code,month,report' });
          if (error) throw new Error('DB write: ' + error.message);
          ok++;
          if (!isPrev && key === 'move_ins_outs') micMap.set(loc, data);   // keep the map current if THIS run refreshed it
          if (!isPrev && key === 'rent_roll') rrMap.set(loc, data);
        } catch (e) { errors.push(`${loc}/${ymd(month).slice(0, 7)}/${key}: ${describeError(e)}`); }
      }
    }
    // AUTOBILL DAILY SAMPLE (ADDED 9 Jul 2026, Michael's decision after the Autobill Conversion
    // investigation): RentRoll is a live "today only" snapshot with no true historical "as of" report
    // (confirmed repeatedly), so Autobill Conversion's move-in-TenantIDs-vs-autobill-set cross-
    // reference is really just one point-in-time sample, not a stable monthly figure — confirmed
    // legacy's own equivalent widget has the exact same day-to-day volatility. Instead of freezing
    // whichever single day the current month happens to close on, record one sample per site per
    // calendar day (while the month is still current) and average them once the month closes — see
    // lib/buildPayload.js's applyAutobillDailyAverage(). Upserts on (site_code,month,sample_date) so
    // re-running the pull twice in one day (or from different cron batches) just overwrites that same
    // day's row instead of creating duplicates.
    const curMoveInsOuts = micMap.get(loc);
    const curRentRoll = rrMap.get(loc);
    if (curMoveInsOuts && curRentRoll) {
      const moveInIds = Array.isArray(curMoveInsOuts.move_in_tenant_ids) ? curMoveInsOuts.move_in_tenant_ids : [];
      const autobillIds = new Set(curRentRoll.autobill_tenant_ids || []);
      const autobillNewTotal = moveInIds.length;
      const autobillNewCount = moveInIds.filter((id) => autobillIds.has(id)).length;
      const pct = autobillNewTotal ? Math.round((autobillNewCount / autobillNewTotal * 100 + Number.EPSILON) * 100) / 100 : null;
      const sampleDate = new Date().toISOString().slice(0, 10);   // today, YYYY-MM-DD (local pull-run date)
      const { error: adErr } = await admin.from('autobill_daily').upsert(
        { site_code: loc, month: ymd(months[0]), sample_date: sampleDate, autobill_new_count: autobillNewCount, autobill_new_total: autobillNewTotal, pct },
        { onConflict: 'site_code,month,sample_date' });
      if (adErr) errors.push(`${loc}/autobill_daily: ${adErr.message}`);
    }
  }

  // concurrency pool over locations, with progress to stderr so a long run is visibly working
  let next = 0, done = 0;
  console.error(`[pull] ${locations.length} sites x ${reportKeys.length} reports, concurrency ${concurrency}…`);
  const worker = async () => { while (next < locations.length) { const loc = locations[next++]; await pullLoc(loc); console.error(`[pull] ${++done}/${locations.length} sites done (last ${loc})`); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, locations.length) }, worker));
  console.error('[pull] all sites done — assembling payload…');

  let payloadError = null;
  if (rebuildPayload) {
    try {
      const payload = await buildPayload(months[0], months[1]);
      const { error: ppErr } = await admin.from('portal_payload').upsert({ id: 1, generated_at: new Date().toISOString(), payload });
      if (ppErr) throw new Error(ppErr.message);
    } catch (e) { payloadError = e.message; }
  } else {
    console.error('[pull] rebuildPayload:false — skipping portal_payload rebuild here, /api/rebuild-payload handles it separately.');
  }

  const status = (errors.length || payloadError) ? (ok ? 'partial' : 'error') : 'ok';
  const detail = [payloadError && ('payload: ' + payloadError), !rebuildPayload && 'payload rebuild skipped by design (rebuildPayload:false) — see /api/rebuild-payload', ...errors].filter(Boolean).slice(0, 50).join(' | ');
  await finishPullLog(logId, status, detail);
  return { status, pulled: ok, failed: errors.length, durationMs: Date.now() - started, errors: errors.slice(0, 10) };
}
