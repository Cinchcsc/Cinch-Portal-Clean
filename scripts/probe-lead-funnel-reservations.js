// Michael's idea (6 Jul 2026): "Reservations vs Scheduled Move-outs" should be sourced from
// lead_funnel (InquiryTracking) instead of ReservationList/ScheduledMoveOuts. Worth checking —
// lead_funnel is `dated: true` and already correctly powers Enquiries with different real numbers
// per month (confirmed working in production), unlike ReservationList (dated:false, compares
// against `new Date()`) or ScheduledMoveOuts (dated:true but proven to return an IDENTICAL count
// regardless of the range requested — see probe-scheduled-outs-historical.js). InquiryTracking rows
// carry `sRentalType`, and reportMap.js's lead_funnel.parse() already isolates rows where
// sRentalType === 'Reservation' (isReservationStage) — if THIS count genuinely varies by month
// (like Enquiries does), that's a real historically-queryable reservations signal we don't
// currently use for this widget. This pulls the raw InquiryTracking rows for several months and
// counts Reservation-stage rows directly (bypassing the full parse(), which currently doesn't
// return this count) to check.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-lead-funnel-reservations.js [siteCode]
import { callReport } from '../lib/sitelink.js';

const loc = (process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',')[0] || '').trim();
if (!loc) { console.error('No site code given and SITELINK_LOCATIONS not set'); process.exit(1); }

const testMonths = ['2025-01', '2025-06', '2026-01', '2026-04', '2026-06'];
console.log(`Site ${loc} — InquiryTracking rows by month, Reservation-stage count (sRentalType === 'Reservation'):\n`);
for (const mk of testMonths) {
  const [y, m] = mk.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0);
  try {
    const { rows } = await callReport('InquiryTracking', loc, start, end);
    const resCount = rows.filter((r) => String(r.sRentalType || '').toLowerCase() === 'reservation').length;
    console.log(`${mk}: total rows=${rows.length}  reservation-stage rows=${resCount}`);
  } catch (e) {
    console.log(`${mk}: ERROR — ${e.message}`);
  }
}
console.log('\nIf reservation-stage counts differ plausibly across months, this is a real historical signal');
console.log('we can use to rebuild the widget. If identical every month, it\'s live-only too.');
process.exit(0);
