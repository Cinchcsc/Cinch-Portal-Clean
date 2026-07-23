// PROBE (23 Jul 2026), task #406/#410 — Michael flagged Abingdon showing 0 reservations for 22 Jul
// despite a real reservation happening that day (chat: "100 sq ft reserved... in abingdon", 17:46).
// Found it in Michael's own native export: Fitch-Hickson's 100sqft unit (row 13) has dPlaced=21 Jul
// 10:35 but dConverted_ToRsv=22 Jul 17:48 — placed one day, converted the next. reportMap.js's
// lead_funnel parser gates reservation_stage_count by isPlacedInWindow (dPlaced-based, see
// isReservationStage/isPlacedInWindow), so this row is attributed to the 21st (still just an inquiry
// that day) and invisible on the 22nd (when it actually became a reservation) -- any inquiry taking
// >0 days to convert falls into this same gap, both under- AND over-counting depending which day you
// query.
//
// Before touching reservation_stage_count (which is ALSO the numerator for the Marketing page's
// Enquiry->Reservation conversion rate, validated 17 Jul against legacy's June 19.8% -- ours came out
// 23.9% raw, "accepted gap" attributed to our enquiry count already running ~10% below legacy's), this
// tests whether switching the DATE FIELD (dPlaced -> dConverted_ToRsv) for JUST this counter moves that
// already-validated June ratio closer to or further from 19.8%, across the whole portfolio -- not just
// a guess, an actual side-by-side comparison, same discipline as every other rate change this project.
//
// Also directly re-checks Abingdon/22 Jul under the proposed fix, to confirm it would show 1 (Fitch-
// Hickson), not 0.
//
// Run:  node --env-file=.env scripts/probe-reservation-converted-date.js
import { callReport, extractNamedTable } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY', 'SITELINK_LOCATIONS'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

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

const locations = process.env.SITELINK_LOCATIONS.split(',').map((s) => s.trim()).filter(Boolean);

// Wide query window: far enough back that a June-converted row placed in an earlier month is still
// captured, far enough forward (today) that we're not truncating anything mid-conversion.
const wideStart = new Date(2026, 3, 1);  // 1 Apr 2026
const wideEnd = new Date();              // today

// BUG FIXED 23 Jul 2026 (2nd bug caught before reporting, this time by checking my own CURRENT-method
// output against the ALREADY-KNOWN-GOOD baseline before trusting the PROPOSED comparison at all): this
// previously counted EVERY row placed in window as an "enquiry", with no channel classification --
// production's actual total_enquiries (reportMap.js's lead_funnel parser) is `phone+walkin+web+email`,
// EXPLICITLY EXCLUDING "other"-classified rows. Inflating the denominator with "other" rows deflates the
// computed ratio relative to production's true one -- likely why CURRENT read 10.5% here instead of the
// already-validated 23.9%. Rewritten to mirror reportMap.js's lead_funnel classification EXACTLY (same
// str()/toLowerCase() logic, same 4-bucket-plus-other split), so `enquiries` here means the same thing
// production's total_enquiries does. Only the ONE thing actually under test -- which date field gates
// reservation_stage_count -- is allowed to differ from production.
async function siteCounts(site, monthStart, monthEnd) {
  const { raw } = await callReport('InquiryTracking', site, wideStart, wideEnd);
  const rows = extractNamedTable(raw, 'Activity');
  let phone = 0, walkin = 0, web = 0, email = 0; // "other" deliberately NOT counted into enquiries, same as production
  let resCurrent = 0;               // CURRENT (production) method: isPlacedInWindow(dPlaced) && isReservationStage
  let resProposed = 0;              // PROPOSED fix: isReservationStage still required -- ONLY the date field changes
  for (const r of rows) {
    const placedInWindow = inWindow(r.dPlaced, monthStart, monthEnd);
    if (placedInWindow) {
      const k = str(r.sInquiryType).toLowerCase();
      if (k === 'phone') phone++;
      else if (k === 'walkin') walkin++;
      else if (k === 'web') web++;
      else if (k === 'email') email++;
      // else: "other" -- excluded from enquiries, exactly like production's total_enquiries
      if (isReservationStage(r)) resCurrent++;
    }
    // dConverted_ToRsv looks like a generic "left raw Inquiry status" timestamp (also set for walk-ins
    // that convert straight to Move-In), not specifically "became a Reservation" -- isReservationStage
    // must stay required; only the date field driving window-membership changes.
    if (isReservationStage(r) && inWindow(r.dConverted_ToRsv, monthStart, monthEnd)) resProposed++;
  }
  const enquiries = phone + walkin + web + email;
  return { enquiries, resCurrent, resProposed, rowCount: rows.length };
}

console.log(`${'='.repeat(90)}\nSTEP 1: direct re-check -- Abingdon (L029), 22 Jul specifically\n${'='.repeat(90)}`);
{
  const day = new Date(2026, 6, 22);
  const c = await siteCounts('L029', day, day);
  console.log(`Abingdon 22 Jul: enquiries=${c.enquiries}  reservations CURRENT(dPlaced)=${c.resCurrent}  reservations PROPOSED(dConverted_ToRsv)=${c.resProposed}  (rows scanned=${c.rowCount})`);
  console.log(c.resProposed >= 1 ? '*** PROPOSED method recovers the missing reservation ***' : 'Proposed method still shows 0 -- needs more digging.');
}

console.log(`\n${'='.repeat(90)}\nSTEP 2: portfolio-wide June 2026 -- does switching the date field move the already-\nvalidated 23.9%-vs-legacy's-19.8% ratio closer or further away?\n${'='.repeat(90)}`);
{
  const juneStart = new Date(2026, 5, 1), juneEnd = new Date(2026, 5, 30);
  let totalEnq = 0, totalResCurrent = 0, totalResProposed = 0;
  for (const site of locations) {
    const c = await siteCounts(site, juneStart, juneEnd);
    totalEnq += c.enquiries; totalResCurrent += c.resCurrent; totalResProposed += c.resProposed;
    console.log(`  ${site}: enq=${c.enquiries} resCurrent=${c.resCurrent} resProposed=${c.resProposed}`);
  }
  const ratioCurrent = totalEnq ? (100 * totalResCurrent / totalEnq).toFixed(1) : 'n/a';
  const ratioProposed = totalEnq ? (100 * totalResProposed / totalEnq).toFixed(1) : 'n/a';
  console.log(`\nJune portfolio totals: enquiries=${totalEnq}`);
  console.log(`  CURRENT (dPlaced-based):        reservations=${totalResCurrent}  ratio=${ratioCurrent}%  (legacy target 19.8%, our prior recorded figure 23.9%)`);
  console.log(`  PROPOSED (dConverted_ToRsv-based): reservations=${totalResProposed}  ratio=${ratioProposed}%`);

  // SANITY CHECK, added 23 Jul 2026 after 2 straight bugs in this same script were caught only by
  // noticing CURRENT didn't match the known-good 23.9% baseline. Don't trust ANY conclusion below this
  // line unless CURRENT is at least close to 23.9% -- if it isn't, this probe's methodology still
  // doesn't match production's (e.g. the wide fixed query window vs whatever window pull.js actually
  // used, or something else not yet accounted for), and the PROPOSED comparison is meaningless until
  // that's resolved.
  const currentMatchesBaseline = Math.abs(Number(ratioCurrent) - 23.9) < 3; // loose tolerance, not exact
  console.log(`\n  Self-check: CURRENT (${ratioCurrent}%) vs prior recorded baseline (23.9%) -- ${currentMatchesBaseline ? 'close enough, this probe\'s methodology looks trustworthy' : '*** DOES NOT MATCH -- do not trust the comparison below, something about this probe\'s query still differs from production ***'}`);
  if (currentMatchesBaseline) {
    console.log(`\n  ${Math.abs(ratioProposed - 19.8) < Math.abs(ratioCurrent - 19.8) ? 'PROPOSED is CLOSER to legacy\'s 19.8% -- switching looks like a real improvement.' : 'PROPOSED is FURTHER from legacy\'s 19.8% -- switching would make the validated monthly metric worse; needs more thought before wiring in.'}`);
  }
}

console.log(`\n${'='.repeat(90)}\nIf STEP 1 confirms the fix recovers Abingdon's missing reservation AND STEP 2 shows\nPROPOSED at least as close to 19.8% as CURRENT, switching reservation_stage_count to\ndConverted_ToRsv-based filtering is safe to wire into both the Snapshot page and the\nMarketing page's conversion rate. If STEP 2 goes the other way, the daily Snapshot and\nmonthly conversion-rate metrics may need to use DIFFERENT date fields rather than one\nshared counter.\n${'='.repeat(90)}`);
process.exit(0);
