// PROBE (24 Jul 2026, task #422) — Michael: "the reservations are the exact same as yesterday, this
// is extremely unlikely" (Weekly/Daily Snapshot page).
//
// ROUND 1 (this script's original form) found something bigger than the original question: OLD
// (dPlaced-gated iInquiryConvertedToLease, exactly what lib/pullSnapshot.js's now-removed
// visibleSnapshotReservations() computed) gave WILDLY different totals for the SAME already-closed
// day (23 Jul) depending on when you asked — 33 from the 06:58 UTC production pull that morning, just
// 5 from a live requery hours later that same afternoon. iInquiryConvertedToLease is evidently
// VOLATILE/mutable state (something like "has an active reservation/lease RIGHT NOW"), not a stable
// historical fact — soft/online reservations that never finalize appear to drop back out within hours.
//
// FIX APPLIED (lib/pullSnapshot.js, task #422): reservations now computed by countReservationsInWindow()
// — gated by dConverted_ToRsv (the date a row actually left raw Inquiry status, per task #406/#410's
// probe-reservation-converted-date.js) falling in the target window, AND sRentalType === "Reservation",
// instead of dPlaced + iInquiryConvertedToLease. Deliberately does NOT require iInquiryConvertedToLease
// at all, since that's the flag proven volatile above.
//
// ROUND 2 (this version) — NOT YET RUN. Adds a THIRD column, FIXED, that exactly matches the new
// production formula, so re-running this (ideally at two different times of day, same target dates)
// tells us whether the FIX is actually stable under requery, or whether sRentalType/dConverted_ToRsv
// have their own version of the same volatility (e.g. if a reservation later cancels and sRentalType
// reverts to something other than "Reservation"). OLD and the original PROPOSED (dConverted_ToRsv +
// iInquiryConvertedToLease, still volatile-flag-dependent) are kept for reference/comparison only —
// production no longer computes either.
//
// Run:  node --env-file=.env scripts/probe-snapshot-reservation-daycompare.js
// Live SiteLink calls (2 days x 29 sites x 1 report = 58 calls, sequential) — don't run at the same
// time as a real pull/snapshot/cockpit/rebuild cron (same account-level -99 concurrent-logon conflict
// every other pull in this codebase avoids). Run it again later today or tomorrow and compare the FIXED
// column across runs for the SAME target dates — if FIXED stays constant, the new formula is stable;
// if it moves, sRentalType/dConverted_ToRsv have their own volatility and this needs another look.
import { callReport, extractNamedTable } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY', 'SITELINK_LOCATIONS'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const str = (v) => String(v ?? '').trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sourceDayKey = (v) => {
  const raw = str(v);
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : ymd(d);
};
const onDay = (v, dayKey) => sourceDayKey(v) === dayKey;
const isVisibleMarketingChannel = (label) => {
  const k = str(label).toLowerCase();
  return k === 'phone' || k === 'walkin' || k === 'web';
};
const isReservationStage = (r) => str(r?.sRentalType).toLowerCase() === 'reservation';
// soapEndBound — same exclusive-end-date widening pullSnapshot.js already applies (task #406/#407).
const soapEndBound = (d) => addDays(dayOnly(d), 1);

const locations = process.env.SITELINK_LOCATIONS.split(',').map((s) => s.trim()).filter(Boolean);

async function countsForDay(site, day) {
  const dayKey = ymd(day);
  const { raw } = await callReport('InquiryTracking', site, day, soapEndBound(day));
  const activityRows = extractNamedTable(raw, 'Activity');
  let old = 0, proposed = 0, fixed = 0, enquiries = 0;
  for (const r of activityRows) {
    const placedOnDay = onDay(r.dPlaced, dayKey);
    const convertedOnDay = onDay(r.dConverted_ToRsv, dayKey);
    const visible = isVisibleMarketingChannel(r.sInquiryType);
    const converted = yes(r.iInquiryConvertedToLease);
    const reservationStage = isReservationStage(r);
    if (placedOnDay && visible) enquiries++;
    if (placedOnDay && visible && converted) old++;                    // OLD (removed) production logic — proven volatile
    if (convertedOnDay && visible && converted) proposed++;            // original PROPOSED — still volatile-flag-dependent, reference only
    if (convertedOnDay && visible && reservationStage) fixed++;        // FIXED — exactly matches current production (countReservationsInWindow)
  }
  return { enquiries, old, proposed, fixed, rowCount: activityRows.length };
}

async function main() {
  const yesterday = dayOnly(addDays(new Date(), -1));      // "yesterday" relative to right now
  const dayBefore = addDays(yesterday, -1);                  // the day before that

  console.log(`${'='.repeat(110)}`);
  console.log(`Comparing ${ymd(dayBefore)} vs ${ymd(yesterday)} — OLD (removed) vs PROPOSED (reference only) vs FIXED (current production formula)`);
  console.log(`${'='.repeat(110)}`);
  console.log('site'.padEnd(6), 'enq(D-1)'.padEnd(9), 'old(D-1)'.padEnd(9), 'fix(D-1)'.padEnd(9), '|', 'enq(D)'.padEnd(7), 'old(D)'.padEnd(7), 'fix(D)'.padEnd(7));

  let tEnq1 = 0, tOld1 = 0, tProp1 = 0, tFix1 = 0, tEnq2 = 0, tOld2 = 0, tProp2 = 0, tFix2 = 0;
  for (const site of locations) {
    const a = await countsForDay(site, dayBefore);
    const b = await countsForDay(site, yesterday);
    tEnq1 += a.enquiries; tOld1 += a.old; tProp1 += a.proposed; tFix1 += a.fixed;
    tEnq2 += b.enquiries; tOld2 += b.old; tProp2 += b.proposed; tFix2 += b.fixed;
    console.log(
      site.padEnd(6),
      String(a.enquiries).padEnd(9), String(a.old).padEnd(9), String(a.fixed).padEnd(9), '|',
      String(b.enquiries).padEnd(7), String(b.old).padEnd(7), String(b.fixed).padEnd(7),
    );
  }

  console.log(`\n${'='.repeat(110)}\nPORTFOLIO TOTALS\n${'='.repeat(110)}`);
  console.log(`${ymd(dayBefore)}:  enquiries=${tEnq1}  OLD=${tOld1}  PROPOSED(ref)=${tProp1}  FIXED=${tFix1}`);
  console.log(`${ymd(yesterday)}:  enquiries=${tEnq2}  OLD=${tOld2}  PROPOSED(ref)=${tProp2}  FIXED=${tFix2}`);
  console.log(`\nCompare FIXED here against /api/snapshot's current daily.totals.reservations for whichever of these two dates is "yesterday" right now.`);
  console.log(`\nIf you run this AGAIN later (same two target dates will shift by however much time passed, but re-run to catch the CURRENT "yesterday" again and compare its FIXED value against what you see here for the same calendar date):`);
  console.log(`  - FIXED unchanged for a given calendar date => the new formula is stable, confirmed by requery, safe to trust.`);
  console.log(`  - FIXED moves for a given calendar date => sRentalType/dConverted_ToRsv have their own volatility too; the Snapshot page's reservations figure needs a fundamentally different data source (e.g. a true immutable event log), not just a different field on this same report.`);
  process.exit(0);
}

main().catch((e) => { console.error('Probe failed:', e.message); process.exit(1); });
