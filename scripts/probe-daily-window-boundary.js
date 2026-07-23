// PROBE (23 Jul 2026), task #406 — probe-abingdon-snapshot-reservations.js surfaced something bigger
// than an Abingdon-specific question: a confirmed real reservation-stage row (dPlaced=2026-07-21
// 10:35am Eastern) shows up correctly when InquiryTracking is queried over a 7-day window that
// includes July 21, but a single-day query for JUST July 21 (start=end=July21) returned
// reservation_stage_count=0 via the exact same parser. Since the parser is identical in both cases,
// the raw SOAP response itself must differ between the two queries.
//
// Suspect: pullSnapshot.js's daily period is { start: yesterday, end: yesterday } -- the SAME Date
// object for both bounds -- and lib/sitelink.js's fmtDate() always formats as "T00:00:00", so the
// actual SOAP call sends dReportDateStart = dReportDateEnd = "2026-07-21T00:00:00" -- a literal
// zero-width instant, not "all of July 21". If SiteLink handles that degenerate range inconsistently
// (e.g., silently defaulting to something else, or just failing to include anything after midnight),
// that would explain exactly what was seen -- and would affect EVERY site's Daily Snapshot figures
// (Enquiries too, not just Reservations), not just Abingdon, since every site's "daily" period is
// built the exact same way.
//
// This queries InquiryTracking for July 21 three different ways and compares whether the known 10:35am
// reservation row is present in each, to confirm the mechanism and find the actual fix:
//   (a) current behaviour: start = end = July21T00:00:00
//   (b) end pushed to July21T23:59:59 (same calendar day, non-zero-width)
//   (c) end pushed to July22T00:00:00 (start of the NEXT day, exclusive-style)
//
// Run:  node --env-file=.env scripts/probe-daily-window-boundary.js
import soap from 'soap';
import { creds, checkReturnCode, extractNamedTable } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const SITE = 'L029';
const str = (v) => String(v ?? '').trim();

let _client = null;
async function client() { if (_client) return _client; _client = await soap.createClientAsync(process.env.SITELINK_WSDL); return _client; }

// Same call shape as lib/sitelink.js's callReport(), but with an explicit raw timestamp string per
// bound instead of always going through fmtDate() -- so each of the 3 variants can be tested exactly.
async function callWithExactBounds(startStr, endStr) {
  const c = await client();
  const args = { ...creds(), sLocationCode: SITE, dReportDateStart: startStr, dReportDateEnd: endStr };
  const [result] = await c.InquiryTrackingAsync(args);
  try { checkReturnCode(result); } catch (e) { if (e.retCode === -1) return { rows: [] }; throw e; }
  const rows = extractNamedTable(result, 'Activity');
  return { raw: result, rows };
}

const target = '2026-07-21';
console.log(`${'='.repeat(90)}\nComparing 3 ways of querying InquiryTracking for a single day (${target}, ${SITE})\n${'='.repeat(90)}`);

const variants = [
  { label: '(a) start=end=T00:00:00 (current pullSnapshot.js behaviour)', start: `${target}T00:00:00`, end: `${target}T00:00:00` },
  { label: '(b) end pushed to T23:59:59 (same day, non-zero-width)', start: `${target}T00:00:00`, end: `${target}T23:59:59` },
  { label: '(c) end pushed to next day T00:00:00 (2026-07-22)', start: `${target}T00:00:00`, end: `2026-07-22T00:00:00` },
];

for (const v of variants) {
  console.log(`\n${v.label}\n  dReportDateStart=${v.start}  dReportDateEnd=${v.end}`);
  try {
    const { rows } = await callWithExactBounds(v.start, v.end);
    console.log(`  Activity rows returned: ${rows.length}`);
    const reservationRows = rows.filter((r) => str(r.sRentalType).toLowerCase() === 'reservation');
    console.log(`  Reservation-stage rows (any dPlaced): ${reservationRows.length}`);
    reservationRows.forEach((r) => console.log(`    dPlaced=${r.dPlaced}  sRentalType=${r.sRentalType}`));
    const has1035 = rows.some((r) => str(r.dPlaced).startsWith('2026-07-21T10:35'));
    console.log(`  Contains the known 10:35am July 21 reservation row: ${has1035 ? 'YES' : 'no'}`);
  } catch (e) {
    console.log(`  FAILED: ${e.message}`);
  }
}

console.log(`\n${'='.repeat(90)}\nIf (a) is missing the 10:35am row but (b) or (c) has it, that confirms the\nzero-width-window theory -- fix pullSnapshot.js's daily period to use a real\nend-of-day bound (or next-day-start) instead of reusing the same T00:00:00\nvalue for both start and end. This would affect Enquiries too, and every\nsite's Daily figures, not just Abingdon's Reservations.\n${'='.repeat(90)}`);
process.exit(0);
