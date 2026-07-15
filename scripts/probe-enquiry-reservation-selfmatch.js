// Task: Enquiry -> Reservation Conversion gap found in the 15 Jul deep re-audit (ours 18.9% vs
// legacy 12.5%, a real 51% relative gap -- NOT explained by enquiry volume, which matches closely:
// 2,040 ours vs 2,012 legacy).
//
// HYPOTHESIS: lib/reportMap.js's lead_funnel parser pushes EVERY row that passes isPlacedInWindow()
// into inquiry_email_hashes, regardless of funnel stage (line ~470: the email-hash push happens
// after the isPlacedInWindow filter but has no isReservationStage() check at all -- unlike
// reservation_email_hashes, which IS explicitly gated to isReservationStage(r) rows only, line 455).
// buildPayload.js's reservationConversions then does:
//   inquiryHashes.filter((h) => resHashes.has(h) || nextResHashes.has(h)).length
// If dPlaced reflects "when THIS STAGE-ROW was placed/touched" rather than a fixed original-enquiry
// date (which the parser's own 8 Jul comment implies -- "gets swept into whatever window it's next
// touched in"), then a Reservation-stage row created THIS month has its own email pushed into
// inquiry_email_hashes AND into reservation_email_hashes (from the same row) -- a tautological
// self-match: "this reservation event's email is in the reservation-event email set" gets counted
// as a converted enquiry, even though it was never a distinct Inquiry-stage event this period.
//
// This script recomputes, per site and portfolio-wide, both the CURRENT formula and an ALTERNATIVE
// that excludes self-matches (rows that are themselves reservation-stage from the inquiry-hash base
// before matching), to see how much of the 18.9% is inflated by this effect.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiry-reservation-selfmatch.js
import { callReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';
import { createHash } from 'crypto';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-enquiry-reservation-selfmatch] ' + lock.message); process.exit(1); }

const NAMES = { L001: 'Bicester', L002: 'Leighton Buzzard', L003: 'Letchworth', L004: 'Chippenham', L005: 'Brighton', L006: 'Huntingdon', L007: 'Newmarket', L008: 'Enfield', L009: 'Newbury', L010: 'Mitcham', L011: 'Sittingbourne', L012: 'Gillingham', L013: 'Brentwood', L014: 'Earlsfield', L015: 'Watford', L016: 'Seaford', L017: 'Southend', L018: 'Woking', L019: 'Sidcup', L020: 'Dunstable', L021: 'Bedford', L022: 'Swindon', L023: 'Wisbech', L024: 'Newcastle', L025: 'Shoreham-By-Sea', L026: 'Paulton', L027: 'Exeter', L028: 'Edmonton', L029: 'Abingdon' };
const EXCLUDE = new Set(['L021', 'L026', 'L027']);

const emailHash = (v) => {
  const e = String(v ?? '').trim().toLowerCase();
  if (!e) return null;
  return createHash('sha256').update(e).digest('hex');
};
const isReservationStage = (r) => String(r.sRentalType ?? '').trim().toLowerCase() === 'reservation';
const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const isPlacedInWindow = (r, startDate, endDate) => {
  if (!r.dPlaced) return false;
  const d = new Date(r.dPlaced);
  if (Number.isNaN(d.getTime())) return false;
  const day = dayOnly(d);
  if (startDate && day < dayOnly(startDate)) return false;
  if (endDate && day > dayOnly(endDate)) return false;
  return true;
};

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const nextStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
const nextEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0);

let totalEnq = 0, totalCurrentConv = 0, totalAltConv = 0, totalSelfMatches = 0;
let exclEnq = 0, exclCurrentConv = 0, exclAltConv = 0;

for (const [loc, name] of Object.entries(NAMES)) {
  try {
    const { rows } = await callReport('InquiryTracking', loc, start, now);
    const { rows: nextRows } = await callReport('InquiryTracking', loc, nextStart, nextEnd);

    let phone = 0, walkin = 0, web = 0, email = 0;
    const inquiryHashes = [];       // CURRENT: every windowed row, any stage
    const inquiryHashesNonRes = [];  // ALTERNATIVE: every windowed row EXCLUDING reservation-stage rows
    const resHashes = new Set();
    let selfMatches = 0;

    for (const r of rows) {
      if (isReservationStage(r)) {
        const eh = emailHash(r.sEmail);
        if (eh) resHashes.add(eh);
      }
      if (!isPlacedInWindow(r, start, now)) continue;
      const c = String(r.sInquiryType ?? '').trim().toLowerCase();
      if (c === 'phone') phone++; else if (c === 'walkin') walkin++; else if (c === 'web') web++; else if (c === 'email') email++;
      const eh = emailHash(r.sEmail);
      if (eh) {
        inquiryHashes.push(eh);
        if (!isReservationStage(r)) inquiryHashesNonRes.push(eh);
      }
    }
    const nextResHashes = new Set();
    for (const r of nextRows) {
      if (isReservationStage(r)) { const eh = emailHash(r.sEmail); if (eh) nextResHashes.add(eh); }
    }

    const totalEnquiries = phone + walkin + web + email;
    const currentConv = inquiryHashes.filter((h) => resHashes.has(h) || nextResHashes.has(h)).length;
    const altConv = inquiryHashesNonRes.filter((h) => resHashes.has(h) || nextResHashes.has(h)).length;
    // self-matches = hashes present in inquiryHashes (any stage) AND resHashes (this month's
    // reservation-stage emails) that would NOT have been there if reservation-stage rows were
    // excluded from the inquiry-hash base first — i.e. rows matching themselves.
    selfMatches = inquiryHashes.filter((h) => resHashes.has(h)).length - inquiryHashesNonRes.filter((h) => resHashes.has(h)).length;

    totalEnq += totalEnquiries; totalCurrentConv += currentConv; totalAltConv += altConv; totalSelfMatches += selfMatches;
    if (!EXCLUDE.has(loc)) { exclEnq += totalEnquiries; exclCurrentConv += currentConv; exclAltConv += altConv; }

    const curPct = totalEnquiries ? (currentConv / totalEnquiries * 100).toFixed(1) : '0.0';
    const altPct = totalEnquiries ? (altConv / totalEnquiries * 100).toFixed(1) : '0.0';
    process.stderr.write(`  ${loc} ${name}${EXCLUDE.has(loc) ? ' [EXCLUDED]' : ''}: enq=${totalEnquiries}, current-conv=${currentConv} (${curPct}%), alt-conv(no self-match)=${altConv} (${altPct}%), self-matches=${selfMatches}\n`);
  } catch (e) {
    console.error(`  ${loc}: FAILED — ${e.message}`);
  }
}

console.log(`\n--- Enquiry -> Reservation Conversion: current formula vs self-match-excluded alternative ---`);
console.log(`All 29 sites   — current: ${totalCurrentConv}/${totalEnq} = ${totalEnq ? (totalCurrentConv / totalEnq * 100).toFixed(1) : 0}%   alt: ${totalAltConv}/${totalEnq} = ${totalEnq ? (totalAltConv / totalEnq * 100).toFixed(1) : 0}%   self-matches: ${totalSelfMatches}`);
console.log(`26 sites excl  — current: ${exclCurrentConv}/${exclEnq} = ${exclEnq ? (exclCurrentConv / exclEnq * 100).toFixed(1) : 0}%   alt: ${exclAltConv}/${exclEnq} = ${exclEnq ? (exclAltConv / exclEnq * 100).toFixed(1) : 0}%`);
console.log(`\nCompare the 26-site "alt" column to legacy's own Total Enquiries "Converted" figure (12.5%).`);
console.log(`If "alt" lands much closer to 12.5% than "current" does, the self-match hypothesis is confirmed --`);
console.log(`the fix would be excluding this-period's own reservation-stage rows from the inquiry-hash base`);
console.log(`before matching, in both lib/reportMap.js (inquiry_email_hashes) and buildPayload.js's usage of it.`);
process.exit(0);
