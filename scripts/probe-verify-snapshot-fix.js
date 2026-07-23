// PROBE (23 Jul 2026), task #406/#407 — the just-deployed pullSnapshot.js fix (commit d1b6310)
// shows Abingdon (L029) at 2 enquiries / 0 reservations for "yesterday" (22 Jul). That's NOT
// necessarily still broken — the originally-confirmed dropped row was a SPECIFIC known reservation
// on 21 Jul at 10:35am, a DIFFERENT calendar day than today's "yesterday" (22 Jul). Zero could
// simply be the genuine answer for a quiet day at a smaller site. Rather than assume either way,
// this checks the actual ground truth independently of the snapshot pipeline: does a wide (7-day)
// InquiryTracking window show ANY reservation-stage row with dPlaced on 22 Jul specifically, for
// each site the live snapshot just reported 0 reservations for? If the wide window also shows
// nothing for that exact day, 0 is correct and the fix is working as intended. If it shows a real
// row the daily output is still missing, the fix has a problem worth chasing further.
//
// Also spot-checks 2 sites the live snapshot DID show non-zero reservations for (Bicester=2,
// Letchworth=1), confirming those specific counts against the same wide-window ground truth —
// so this isn't just checking the zero case, it's checking the fix produces the RIGHT number
// either way.
//
// Run:  node --env-file=.env scripts/probe-verify-snapshot-fix.js
import { callReport, extractNamedTable } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const str = (v) => String(v ?? '').trim();
const TARGET_DAY = '2026-07-22'; // "yesterday" relative to today (23 Jul) when the live pull ran

// SITES: [code, name, whatTheLiveSnapshotJustShowed]
const SITES = [
  ['L029', 'Abingdon', 0],
  ['L001', 'Bicester', 2],
  ['L003', 'Letchworth', 1],
];

console.log(`${'='.repeat(95)}\nGround-truth check for ${TARGET_DAY} — wide (7-day) InquiryTracking window vs the live\nsnapshot's per-site reservation counts, for 3 sites (1 zero, 2 non-zero)\n${'='.repeat(95)}`);

for (const [code, name, liveCount] of SITES) {
  const end = new Date(2026, 6, 23); // today (exclusive-safe: wide window, doesn't matter which side)
  const start = new Date(2026, 6, 16); // 7 days back
  const { raw } = await callReport('InquiryTracking', code, start, end);
  const activityRows = extractNamedTable(raw, 'Activity');
  const targetDayReservations = activityRows.filter((r) => {
    if (str(r.sRentalType).toLowerCase() !== 'reservation') return false;
    return str(r.dPlaced).startsWith(TARGET_DAY);
  });
  const match = targetDayReservations.length === liveCount;
  console.log(`\n${code} ${name}: live snapshot showed ${liveCount} reservation(s) for ${TARGET_DAY}`);
  console.log(`  Wide-window ground truth: ${targetDayReservations.length} reservation-stage row(s) with dPlaced on ${TARGET_DAY}`);
  console.log(`  ${match ? 'MATCH — fix is producing the correct count' : '*** MISMATCH — investigate further ***'}`);
  targetDayReservations.forEach((r) => console.log(`    dPlaced=${r.dPlaced}  TenantID=${r.TenantID}`));
}

console.log(`\n${'='.repeat(95)}\nIf all 3 say MATCH, the fix is confirmed working correctly (including Abingdon's\ngenuine zero) — not just passing in theory but producing the right live number.\n${'='.repeat(95)}`);
process.exit(0);
