// Orchestrates a refresh: for each location pull the configured reports, store the aggregated
// (no-PII) rows, then rebuild the portal payload. Locations run concurrently (pool) to fit the cron
// time budget; per-call failures are logged and skipped. Occupancy is pulled for the last complete
// month AND the month before (MoM deltas + trend history); the other reports for the last complete
// month only. Override with { reports, concurrency } if needed.
import { admin } from './supabaseAdmin.js';
import { pullReport, REPORTS } from './reportMap.js';
import { buildPayload } from './buildPayload.js';

const firstOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; // local YYYY-MM-01 (avoid UTC day-shift)
const DEFAULT_REPORTS = ['occupancy', 'rent_roll', 'management', 'move_ins_outs', 'past_due', 'scheduled_outs',
  'insurance_roll', 'insurance_activity', 'lead_funnel', 'marketing', 'merchandise', 'financial', 'rate_changes',
  'reservations', 'true_revenue', 'rental_activity'];
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
const TWO_MONTH = new Set(['occupancy', 'management', 'lead_funnel', 'move_ins_outs', 'insurance_activity', 'merchandise', 'rent_roll', 'true_revenue', 'rental_activity', 'financial', 'insurance_roll']);

// SiteLink throws -99 "General Exception from LogOn" when the same account logs on in parallel, so
// default to SEQUENTIAL (concurrency 1) — proven reliable. Override with SITELINK_PULL_CONCURRENCY.
export async function runPull({ reports, concurrency = Number(process.env.SITELINK_PULL_CONCURRENCY) || 1 } = {}) {
  const started = Date.now();
  const { data: logRow } = await admin.from('refresh_log').insert({ status: 'running' }).select('id').single();
  const logId = logRow?.id;

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
  const { data: existingPrev } = await admin.from('raw_report').select('site_code,report').eq('month', prevMonthKey);
  const prevLocked = new Set((existingPrev || []).map(r => `${r.site_code}|${r.report}`));

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
        } catch (e) { errors.push(`${loc}/${ymd(month).slice(0, 7)}/${key}: ${e.message}`); }
      }
    }
  }

  // concurrency pool over locations, with progress to stderr so a long run is visibly working
  let next = 0, done = 0;
  console.error(`[pull] ${locations.length} sites x ${reportKeys.length} reports, concurrency ${concurrency}…`);
  const worker = async () => { while (next < locations.length) { const loc = locations[next++]; await pullLoc(loc); console.error(`[pull] ${++done}/${locations.length} sites done (last ${loc})`); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, locations.length) }, worker));
  console.error('[pull] all sites done — assembling payload…');

  let payloadError = null;
  try {
    const payload = await buildPayload(months[0], months[1]);
    const { error: ppErr } = await admin.from('portal_payload').upsert({ id: 1, generated_at: new Date().toISOString(), payload });
    if (ppErr) throw new Error(ppErr.message);
  } catch (e) { payloadError = e.message; }

  const status = (errors.length || payloadError) ? (ok ? 'partial' : 'error') : 'ok';
  const detail = [payloadError && ('payload: ' + payloadError), ...errors].filter(Boolean).slice(0, 50).join(' | ');
  if (logId) await admin.from('refresh_log').update({ finished_at: new Date().toISOString(), status, detail }).eq('id', logId);
  return { status, pulled: ok, failed: errors.length, durationMs: Date.now() - started, errors: errors.slice(0, 10) };
}
