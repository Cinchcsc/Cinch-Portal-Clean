// Checks whether the "Enquiry -> Reservation" widget is measuring the right thing. Two questions:
// 1) Is `iReservationConvertedToLease` (the flag lib/reportMap.js's lead_funnel parser already
//    collects into `reservations`, but which nothing currently reads) actually populated, or is it
//    broken the same way `iInquiryConvertedToLease` was?
// 2) Does InquiryTracking carry a same-report identifier (WaitingID or TenantID) that reliably links
//    an Inquiry-stage row to a LATER Reservation-stage row for the same lead? If so, that's a more
//    reliable same-report way to compute Enquiry -> Reservation than either flag.
// PII-SAFE: never prints name/phone/email/comment — only counts, flags, IDs, and stage labels.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiry-reservation.js
import { callReport } from '../lib/sitelink.js';

const now = new Date();
const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);

let totalInquiry = 0, totalReservationStage = 0, flagTrue = 0, callTypeReserv = 0;
let inquiryWithId = 0, reservationWithId = 0;
const inquiryIds = new Set(), reservationIds = new Set();

for (const loc of locations) {
  let rows;
  try { ({ rows } = await callReport('InquiryTracking', loc, startOfMonth, now)); }
  catch (e) { console.log(`${loc} failed: ${e.message}`); continue; }

  for (const r of rows) {
    const stage = String(r.sRentalType || '').toLowerCase();
    const isInquiry = !stage || stage === 'inquiry';
    const isReservation = stage === 'reservation';
    if (isInquiry) {
      totalInquiry++;
      if (r.WaitingID != null || r.TenantID != null) { inquiryWithId++; inquiryIds.add(String(r.WaitingID ?? r.TenantID)); }
    }
    if (isReservation) {
      totalReservationStage++;
      if (r.WaitingID != null || r.TenantID != null) { reservationWithId++; reservationIds.add(String(r.WaitingID ?? r.TenantID)); }
    }
    if (r.iReservationConvertedToLease === true || r.iReservationConvertedToLease === 1 || /^(1|true|yes)$/i.test(String(r.iReservationConvertedToLease))) flagTrue++;
    if (/reserv/i.test(String(r.sCallType || ''))) callTypeReserv++;
  }
}

const overlap = [...inquiryIds].filter((id) => reservationIds.has(id));

console.log('=== iReservationConvertedToLease flag ===');
console.log(`flagTrue: ${flagTrue} / total Inquiry-stage rows: ${totalInquiry} (${totalInquiry ? (flagTrue / totalInquiry * 100).toFixed(1) : 0}%)`);
console.log(`sCallType matches /reserv/i: ${callTypeReserv}`);

console.log('\n=== Same-report ID linkage (WaitingID/TenantID) ===');
console.log(`Inquiry-stage rows: ${totalInquiry}, with a WaitingID/TenantID: ${inquiryWithId}`);
console.log(`Reservation-stage rows: ${totalReservationStage}, with a WaitingID/TenantID: ${reservationWithId}`);
console.log(`Distinct IDs seen at Inquiry stage: ${inquiryIds.size}`);
console.log(`Distinct IDs seen at Reservation stage: ${reservationIds.size}`);
console.log(`IDs appearing at BOTH stages (= a real Inquiry->Reservation conversion): ${overlap.length}`);
console.log(`Implied conversion rate via ID linkage: ${inquiryIds.size ? (overlap.length / inquiryIds.size * 100).toFixed(1) : 0}%`);
