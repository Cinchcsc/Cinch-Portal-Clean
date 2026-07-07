// Verifies the 7 Jul 2026 next-month-lag extension to reservationConversions actually took effect in
// lib/buildPayload.js's real recordFor() output (not just the standalone diagnostic in
// check-enq-reservation.js, which recomputes the match independently). Pulls the portfolio total via
// buildPayloadRange() for the earlier of the two months check-enq-reservation.js compares, and prints
// it alongside what check-enq-reservation.js's own combined figure predicts — they should match.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-enq-reservation-lag-live.js
import { buildPayloadRange, listStoredMonths } from '../lib/buildPayload.js';

const months = await listStoredMonths();
if (months.length < 2) { console.error('Need at least 2 stored months.'); process.exit(1); }
const mkA = months[months.length - 2];
const [y, m] = mkA.split('-').map(Number);
const dA = new Date(y, m - 1, 1);

const p = await buildPayloadRange(dA, dA);
// NOTE: buildPayloadRange()'s `totals` object has no `enquiries` sub-object at all (a pre-existing
// gap, unrelated to the lag-match fix) — summing straight from `p.sites[*].enquiries` instead, which
// is where recordFor()'s real (fixed) per-site values live.
const totalEnq = (p.sites || []).reduce((a, s) => a + (s.enquiries?.total || 0), 0);
const totalConv = (p.sites || []).reduce((a, s) => a + (s.enquiries?.reservationConversions || 0), 0);
console.log(`Month ${mkA} — via buildPayloadRange() (real production code path):`);
console.log(`  enquiries.total = ${totalEnq}`);
console.log(`  enquiries.reservationConversions (same-month + next-month lag) = ${totalConv} (${totalEnq ? (totalConv / totalEnq * 100).toFixed(1) : 0}%)`);
console.log(`\nCompare against check-enq-reservation.js's independently-computed "Combined" line for the same month — they should match.`);
process.exit(0);
