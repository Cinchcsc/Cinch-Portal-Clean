// PROBE (24 Jul 2026, task #422) — Michael: "the reservations are the exact same as yesterday, this
// is extremely unlikely" (Weekly/Daily Snapshot page). Confirmed via the live portal + /api/snapshot
// that today's stored daily row is genuinely FRESH (generated_at 2026-07-24T06:58:55Z, ~1h after the
// 06:00 UTC pull-snapshot cron) and correctly windowed to YESTERDAY (23 Jul, not some stale earlier
// date) — so this is NOT a frozen/stuck-cron bug. Portfolio total shown today: 33 reservations.
//
// Can't confirm from this sandbox whether 22 Jul's total (what showed when Michael looked yesterday)
// was ALSO 33 — snapshot_payload is a single overwritten row (by design, see lib/pullSnapshot.js's
// header), no history kept. This script re-queries SiteLink live for BOTH 22 Jul and 23 Jul side by
// side so we can see the real numbers directly, under TWO methods:
//
//   CURRENT  = exactly what lib/pullSnapshot.js's visibleSnapshotReservations() computes today: of
//              enquiries PLACED on the target day (dPlaced-gated), how many have iInquiryConvertedToLease
//              = true, restricted to the visible Phone/Walk-in/Web channels.
//   PROPOSED = same iInquiryConvertedToLease flag and same channel restriction, but gated by
//              dConverted_ToRsv falling on the target day INSTEAD of dPlaced — i.e. "reservations that
//              actually converted on this day", regardless of which day the underlying enquiry first
//              came in.
//
// This distinction is NOT new speculation — it's the exact mechanism task #406/#410 already documented
// from a real example (Fitch-Hickson at Abingdon: dPlaced 21 Jul 10:35, dConverted_ToRsv 22 Jul 17:48 —
// placed one day, converted the next, invisible to a same-day dPlaced-gated count on either day). See
// scripts/probe-reservation-converted-date.js for the original investigation (that one tested the
// MONTHLY Enquiry->Reservation ratio against legacy; this one tests the DAILY Snapshot figure
// specifically, which is a different counter — channels[label].converted, not reservation_stage_count —
// built from the same activityRows loop and sharing the same dPlaced-gating characteristic).
//
// Why CURRENT could plausibly repeat similar/identical totals day to day even though it's genuinely
// re-querying fresh data each time: it only captures enquiries that converted WITHIN ~1 day of being
// placed (the pull runs once daily, ~24-30h after the target day ends) — a narrow, structurally-biased
// slice of a slower real sales process, not "every reservation actually made yesterday". If that slice
// is small and fairly stable in size, similar-looking totals across adjacent days are a real possible
// OUTCOME of the definition, not necessarily a bug in the pull/date-window mechanics themselves (which
// were independently re-verified as correct above).
//
// Run:  node --env-file=.env scripts/probe-snapshot-reservation-daycompare.js
// Live SiteLink calls (2 days x 29 sites x 1 report = 58 calls, sequential) — don't run at the same
// time as a real pull/snapshot/cockpit/rebuild cron (same account-level -99 concurrent-logon conflict
// every other pull in this codebase avoids).
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
// soapEndBound — same exclusive-end-date widening pullSnapshot.js already applies (task #406/#407).
const soapEndBound = (d) => addDays(dayOnly(d), 1);

const locations = process.env.SITELINK_LOCATIONS.split(',').map((s) => s.trim()).filter(Boolean);

async function countsForDay(site, day) {
  const dayKey = ymd(day);
  const { raw } = await callReport('InquiryTracking', site, day, soapEndBound(day));
  const activityRows = extractNamedTable(raw, 'Activity');
  let current = 0, proposed = 0, enquiries = 0;
  for (const r of activityRows) {
    const placedOnDay = onDay(r.dPlaced, dayKey);
    const convertedOnDay = onDay(r.dConverted_ToRsv, dayKey);
    const visible = isVisibleMarketingChannel(r.sInquiryType);
    const converted = yes(r.iInquiryConvertedToLease);
    if (placedOnDay && visible) enquiries++;
    if (placedOnDay && visible && converted) current++;     // CURRENT — exact production logic
    if (convertedOnDay && visible && converted) proposed++;  // PROPOSED — same flag, dConverted_ToRsv-gated
  }
  return { enquiries, current, proposed, rowCount: activityRows.length };
}

async function main() {
  const yesterday = dayOnly(addDays(new Date(), -1));      // 23 Jul — what the portal shows as "Yesterday" right now
  const dayBefore = addDays(yesterday, -1);                  // 22 Jul — what it would have shown when Michael looked yesterday

  console.log(`${'='.repeat(100)}`);
  console.log(`Comparing ${ymd(dayBefore)} vs ${ymd(yesterday)}, CURRENT (dPlaced-gated) vs PROPOSED (dConverted_ToRsv-gated) reservations`);
  console.log(`${'='.repeat(100)}`);
  console.log('site'.padEnd(6), 'enq(D-1)'.padEnd(9), 'cur(D-1)'.padEnd(9), 'prop(D-1)'.padEnd(10), '|', 'enq(D)'.padEnd(7), 'cur(D)'.padEnd(7), 'prop(D)'.padEnd(8));

  let tEnq1 = 0, tCur1 = 0, tProp1 = 0, tEnq2 = 0, tCur2 = 0, tProp2 = 0;
  for (const site of locations) {
    const a = await countsForDay(site, dayBefore);
    const b = await countsForDay(site, yesterday);
    tEnq1 += a.enquiries; tCur1 += a.current; tProp1 += a.proposed;
    tEnq2 += b.enquiries; tCur2 += b.current; tProp2 += b.proposed;
    console.log(
      site.padEnd(6),
      String(a.enquiries).padEnd(9), String(a.current).padEnd(9), String(a.proposed).padEnd(10), '|',
      String(b.enquiries).padEnd(7), String(b.current).padEnd(7), String(b.proposed).padEnd(8),
    );
  }

  console.log(`\n${'='.repeat(100)}\nPORTFOLIO TOTALS\n${'='.repeat(100)}`);
  console.log(`${ymd(dayBefore)} (yesterday, when Michael likely checked):  enquiries=${tEnq1}  CURRENT reservations=${tCur1}  PROPOSED reservations=${tProp1}`);
  console.log(`${ymd(yesterday)} (today's live "Yesterday" figure):        enquiries=${tEnq2}  CURRENT reservations=${tCur2}  PROPOSED reservations=${tProp2}`);
  console.log(`\nPortal is currently showing CURRENT=${tCur2} for ${ymd(yesterday)} (confirm this matches /api/snapshot's daily.totals.reservations).`);
  console.log(tCur1 === tCur2
    ? `\n*** CONFIRMED: CURRENT method gives the IDENTICAL total (${tCur2}) on both days — real, not a misread. ***`
    : `\nCURRENT method actually DIFFERS day to day (${tCur1} vs ${tCur2}) — if Michael saw matching numbers, it may be a different comparison than this script is making (e.g. a single store, or the Weekly/Quarterly view) — worth double-checking exactly what he compared.`);
  console.log(tProp1 !== tProp2
    ? `PROPOSED method DOES vary day to day (${tProp1} vs ${tProp2}) — supports the theory that CURRENT's dPlaced-gating (not the pull/date-window mechanics) is why the figure looks stuck: it only captures same/next-day conversions, a narrow and structurally low-variance slice of a slower real process.`
    : `PROPOSED also comes out the same (${tProp1} vs ${tProp2}) — the dPlaced-vs-dConverted_ToRsv theory doesn't explain it either; look elsewhere.`);
  process.exit(0);
}

main().catch((e) => { console.error('Probe failed:', e.message); process.exit(1); });
