// PROBE (23 Jul 2026), task #406/#410 — 3 straight live-query attempts (probe-reservation-converted-
// date.js) all failed to reproduce the already-validated June 23.9% baseline, even after fixing the
// enquiries-classification bug and matching pull.js's exact endOf() convention (dEnd=30 Jun). Root
// cause, confirmed via reparse-report.js's own header comment: SiteLink's InquiryTracking has no true
// historical "as of" snapshot -- every live query returns CURRENT/mutable record state (sRentalType,
// dConverted_ToRsv, etc reflect whatever they are RIGHT NOW), filtered by some date logic that isn't a
// strict dPlaced-between-X-and-Y filter (confirmed earlier: a single-day query still returned rows with
// dPlaced a month earlier). Re-querying TODAY (23+ days after June ended) inherently sees more "matured"
// records than a query run back when the 23.9% figure was actually captured (~17 Jul, per buildPayload.js's
// task #310 comment) -- there is no way to ask SiteLink "what did this look like on 30 June" freshly.
//
// BUT: raw_report.raw_response already stores the untouched SOAP response from whenever June was
// ACTUALLY pulled (while June was still the "previous complete month", per pull.js's own immutability
// rule: locked once and never re-pulled since). That frozen response is EXACTLY what produced the
// 23.9% figure -- reading it directly (zero SiteLink calls, same technique reparse-report.js already
// uses for exactly this kind of "replay stored data through different logic" need) sidesteps the
// mutable-state problem entirely, since nothing about a frozen row in Supabase can have "kept evolving"
// since it was captured.
//
// This reads June's stored lead_funnel raw_response for every site, recomputes CURRENT (dPlaced-based,
// should closely reproduce 23.9% since it's the same frozen input that already produced it) and
// PROPOSED (dConverted_ToRsv-based) side by side, on IDENTICAL data -- a true apples-to-apples test.
//
// Run:  node --env-file=.env scripts/probe-reservation-reparse-check.js
import { admin } from '../lib/supabaseAdmin.js';
import { extractNamedTable } from '../lib/sitelink.js';

const str = (v) => String(v ?? '').trim();
const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const isReservationStage = (r) => str(r.sRentalType).toLowerCase() === 'reservation';
const inWindow = (dateVal, start, end) => {
  if (!dateVal) return false;
  const d = new Date(dateVal);
  if (Number.isNaN(d.getTime())) return false;
  const day = dayOnly(d);
  return day >= dayOnly(start) && day <= dayOnly(end);
};

const juneStart = new Date(2026, 5, 1), juneEnd = new Date(2026, 5, 30);

const { data: rows, error } = await admin
  .from('raw_report')
  .select('site_code,raw_response,data')
  .eq('report', 'lead_funnel')
  .eq('month', '2026-06-01');
if (error) { console.error('Supabase read failed:', error.message); process.exit(1); }
if (!rows?.length) { console.error('No stored lead_funnel rows for June 2026 -- nothing to reparse.'); process.exit(1); }

console.log(`${'='.repeat(90)}\nFound ${rows.length} stored June lead_funnel row(s). Recomputing CURRENT vs PROPOSED\nfrom the SAME frozen raw_response that already produced the 23.9% baseline.\n${'='.repeat(90)}`);

let totalEnq = 0, totalResCurrent = 0, totalResProposed = 0;
let storedEnqSum = 0, storedResSum = 0; // sanity cross-check against what's already saved in `data`
for (const r of rows) {
  if (!r.raw_response) { console.log(`  ${r.site_code}: no raw_response stored -- skipped`); continue; }
  const activityRows = extractNamedTable(r.raw_response, 'Activity');
  let phone = 0, walkin = 0, web = 0, email = 0, resCurrent = 0, resProposed = 0;
  for (const row of activityRows) {
    const placedInWindow = inWindow(row.dPlaced, juneStart, juneEnd);
    if (placedInWindow) {
      const k = str(row.sInquiryType).toLowerCase();
      if (k === 'phone') phone++;
      else if (k === 'walkin') walkin++;
      else if (k === 'web') web++;
      else if (k === 'email') email++;
      if (isReservationStage(row)) resCurrent++;
    }
    if (isReservationStage(row) && inWindow(row.dConverted_ToRsv, juneStart, juneEnd)) resProposed++;
  }
  const enquiries = phone + walkin + web + email;
  totalEnq += enquiries; totalResCurrent += resCurrent; totalResProposed += resProposed;
  const storedEnq = r.data?.total_enquiries ?? 0;
  const storedRes = r.data?.reservation_stage_count ?? 0;
  storedEnqSum += storedEnq; storedResSum += storedRes;
  const matchesStored = enquiries === storedEnq && resCurrent === storedRes;
  console.log(`  ${r.site_code}: enq=${enquiries} resCurrent=${resCurrent} resProposed=${resProposed}  (stored: enq=${storedEnq} res=${storedRes}${matchesStored ? ', MATCH' : ', *** MISMATCH vs already-saved data ***'})`);
}

const ratioCurrent = totalEnq ? (100 * totalResCurrent / totalEnq).toFixed(1) : 'n/a';
const ratioProposed = totalEnq ? (100 * totalResProposed / totalEnq).toFixed(1) : 'n/a';
const storedRatio = storedEnqSum ? (100 * storedResSum / storedEnqSum).toFixed(1) : 'n/a';
console.log(`\nJune portfolio totals (from FROZEN stored data): enquiries=${totalEnq}`);
console.log(`  Already-saved data:              reservations=${storedResSum}  ratio=${storedRatio}%  (should equal or closely explain the recorded 23.9%)`);
console.log(`  CURRENT recomputed (dPlaced):    reservations=${totalResCurrent}  ratio=${ratioCurrent}%`);
console.log(`  PROPOSED (dConverted_ToRsv):     reservations=${totalResProposed}  ratio=${ratioProposed}%`);

const currentMatchesStored = Math.abs(Number(ratioCurrent) - Number(storedRatio)) < 0.5;
console.log(`\n  Self-check: recomputed CURRENT (${ratioCurrent}%) vs already-saved ratio (${storedRatio}%) -- ${currentMatchesStored ? 'MATCH, this is now a trustworthy apples-to-apples comparison' : '*** STILL DOES NOT MATCH -- something else is going on, do not trust the verdict below ***'}`);
if (currentMatchesStored) {
  console.log(`\n  ${Math.abs(Number(ratioProposed) - 19.8) < Math.abs(Number(ratioCurrent) - 19.8) ? 'PROPOSED is CLOSER to legacy\'s 19.8% -- switching looks like a real improvement.' : 'PROPOSED is FURTHER from legacy\'s 19.8% -- switching would make the validated monthly metric worse; needs more thought before wiring in.'}`);
}
process.exit(0);
