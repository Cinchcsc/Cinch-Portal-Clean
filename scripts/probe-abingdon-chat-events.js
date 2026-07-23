// PROBE (23 Jul 2026), task #406/#407 — Michael flagged 3 internal team-chat messages ("Jamie Crook",
// timestamped "Yesterday" 17:08/17:21/17:46) describing real activity at Abingdon (L029):
//   17:08  "125 sqft unit with 7K cover sold to a walk in customer in abingdon"   <- sounds like a MOVE-IN
//   17:21  "100 sq ft reserved with £7k cover in abingdon"                        <- sounds like a RESERVATION
//   17:46  "100 sq ft reserved in abingdon"                                       <- sounds like a RESERVATION
// The live Snapshot (post-fix) showed Abingdon at 2 enquiries / 0 reservations / 0 move-ins for
// "yesterday" (22 Jul). If these 3 events are real and dated 22 Jul, that's 0-for-3 — a bigger miss
// than the single dropped-day bug just fixed, and worth finding the real reason rather than assuming
// either "the fix is broken" or "chat is wrong" without looking.
//
// Rather than re-guess the exact target date or exact classification, this pulls EVERYTHING for
// Abingdon over a wide window (19-23 Jul, covering any date ambiguity in "yesterday") and dumps:
//   1. Every InquiryTracking Activity row (dPlaced, sRentalType, sInquiryType, TenantID) — regardless
//      of whether it's classified as "reservation" — so a differently-labelled event still shows up.
//   2. Every MoveInsAndMoveOuts row (MoveDate, MoveIn/MoveOut flags, UnitSize/Area, TenantName) — in
//      case the "sold to a walk-in" event is a same-day move-in that skipped the reservation stage.
// The £7k cover / ~100-125 sqft details make an eyeball match to this specific unit possible even
// without exact dates lining up.
//
// Run:  node --env-file=.env scripts/probe-abingdon-chat-events.js
import { callReport, extractNamedTable } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const str = (v) => String(v ?? '').trim();
const SITE = 'L029';
const start = new Date(2026, 6, 19);
const end = new Date(2026, 6, 24); // wide net, exclusive-safe

console.log(`${'='.repeat(100)}\nAbingdon (${SITE}) — ALL InquiryTracking Activity rows, 19-23 Jul 2026\n${'='.repeat(100)}`);
{
  const { raw } = await callReport('InquiryTracking', SITE, start, end);
  const rows = extractNamedTable(raw, 'Activity');
  console.log(`Total Activity rows: ${rows.length}\n`);
  rows
    .slice()
    .sort((a, b) => String(a.dPlaced || '').localeCompare(String(b.dPlaced || '')))
    .forEach((r) => {
      console.log(`  dPlaced=${String(r.dPlaced).padEnd(30)} sRentalType=${String(r.sRentalType).padEnd(14)} sInquiryType=${String(r.sInquiryType).padEnd(10)} TenantID=${r.TenantID} sCallType=${r.sCallType || ''}`);
    });
}

console.log(`\n${'='.repeat(100)}\nAbingdon (${SITE}) — ALL MoveInsAndMoveOuts rows, 19-23 Jul 2026\n${'='.repeat(100)}`);
{
  const { rows } = await callReport('MoveInsAndMoveOuts', SITE, start, end);
  console.log(`Total rows: ${rows.length}\n`);
  rows
    .slice()
    .sort((a, b) => String(a.MoveDate || '').localeCompare(String(b.MoveDate || '')))
    .forEach((r) => {
      console.log(`  MoveDate=${String(r.MoveDate).padEnd(30)} MoveIn=${r.MoveIn} MoveOut=${r.MoveOut} Transfer=${r.Transfer} UnitSize=${r.UnitSize} Area=${r.MovedInArea || r.MovedOutArea} TenantName=${r.TenantName}`);
    });
}

console.log(`\n${'='.repeat(100)}\nLook for: a ~100-125 sqft unit, any row with dPlaced/MoveDate on whatever day\n"yesterday" turns out to be, or a TenantName/Area that matches a walk-in sale +\ntwo ~100sqft reservations. If nothing matches at all, the events may not be\nreaching InquiryTracking/MoveInsAndMoveOuts the way we assume (different report,\ndifferent classification, or a separate capture gap) — not just a date-boundary issue.\n${'='.repeat(100)}`);
process.exit(0);
