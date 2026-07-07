// Diagnoses why "Enquiry -> Reservation" looks low. The current formula (lib/buildPayload.js's
// `reservationConversions`) only counts a match if the SAME MONTH's InquiryTracking pull contains
// BOTH an Inquiry-stage row and a Reservation-stage row with the same hashed email — it CANNOT catch
// someone who enquired in one month and reserved in the next (a very common lag), because each
// month's lead_funnel parse only sees that one month's rows. This script quantifies that gap by
// checking, for the two most recent stored months, how many of month A's own inquiries match a
// reservation in month A (current formula) vs. how many ALSO match a reservation in month B (the
// lag case the current formula misses entirely).
// PII-SAFE: only compares hashes already stored in raw_report — never touches raw emails.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-enq-reservation.js
import { buildPayloadRange, listStoredMonths } from '../lib/buildPayload.js';
import { admin } from '../lib/supabaseAdmin.js';

const months = await listStoredMonths();
if (months.length < 2) { console.error('Need at least 2 stored months.'); process.exit(1); }
const [mkA, mkB] = [months[months.length - 2], months[months.length - 1]];
console.log(`Comparing ${mkA} (A) and ${mkB} (B)\n`);

// Pull the raw lead_funnel data directly (not the light monthly record) so we have the underlying
// hash arrays, not just the already-computed reservationConversions count.
const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
let totalInqA = 0, sameMonthMatchA = 0, lagMatchAtoB = 0;
for (const loc of locations) {
  const { data: rowA } = await admin.from('raw_report').select('data').eq('site_code', loc).eq('month', `${mkA}-01`).eq('report', 'lead_funnel').order('pulled_at', { ascending: false }).limit(1).maybeSingle();
  const { data: rowB } = await admin.from('raw_report').select('data').eq('site_code', loc).eq('month', `${mkB}-01`).eq('report', 'lead_funnel').order('pulled_at', { ascending: false }).limit(1).maybeSingle();
  const a = rowA?.data, b = rowB?.data;
  if (!a) continue;
  const inqA = new Set(a.inquiry_email_hashes || []);
  totalInqA += inqA.size;
  const resA = new Set(a.reservation_email_hashes || []);
  for (const h of inqA) if (resA.has(h)) sameMonthMatchA++;
  if (b) {
    const resB = new Set(b.reservation_email_hashes || []);
    for (const h of inqA) if (resB.has(h)) lagMatchAtoB++;
  }
}
console.log(`${mkA} total inquiries: ${totalInqA}`);
console.log(`Matched a reservation in the SAME month (${mkA}) — current formula: ${sameMonthMatchA} (${totalInqA ? (sameMonthMatchA / totalInqA * 100).toFixed(1) : 0}%)`);
console.log(`ALSO matched a reservation the FOLLOWING month (${mkB}) — currently NOT counted at all: ${lagMatchAtoB} (${totalInqA ? (lagMatchAtoB / totalInqA * 100).toFixed(1) : 0}%)`);
console.log(`Combined (same-month + next-month lag) would be: ${sameMonthMatchA + lagMatchAtoB} (${totalInqA ? ((sameMonthMatchA + lagMatchAtoB) / totalInqA * 100).toFixed(1) : 0}%)`);
process.exit(0);
