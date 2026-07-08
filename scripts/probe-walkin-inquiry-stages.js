// Next test on the Walk-ins gap (task #94) after probe-walkin-sitescope.js: site scope (Bedford/
// Paulton) only explained 3 of the ~14-17 point gap (77 all-27 -> 74 25-shared vs legacy's 60), and
// there's no label collision anywhere in the portfolio. Remaining candidate: InquiryTracking's own
// walk-in count was only ever checked for INQUIRY-stage rows (28, per probe-walkin-deeper.js) — well
// BELOW both ManagementSummary (74-77) and legacy (60). Legacy's 60 sits BETWEEN InquiryTracking's
// strict Inquiry-only count and ManagementSummary's raw activity counter, which raises a new
// candidate: maybe legacy's "Walk-in" tile = InquiryTracking rows across BOTH Inquiry-stage AND
// Reservation-stage (a walk-in prospect who progressed to Reservation this month), not just
// brand-new Inquiry-stage rows. This checks that combined figure, scoped to the same 25 sites
// shared with legacy (excl. Bedford/Paulton), for an apples-to-apples comparison.
// PII-SAFE: aggregated counts + stage labels only.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-walkin-inquiry-stages.js
import { callReport } from '../lib/sitelink.js';

const str = (v) => (v == null ? '' : String(v)).trim();
const EXCLUDE = new Set(['L021', 'L026']);
const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter((c) => c && !EXCLUDE.has(c));
const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);

let inquiryOnly = 0, resOnly = 0, combined = 0, otherStage = 0;
const stageLabels = new Set();

for (const loc of locations) {
  process.stderr.write(`[walkin-stages] ${loc}...\n`);
  try {
    const { rows } = await callReport('InquiryTracking', loc, start, end);
    for (const r of rows) {
      if (str(r.sInquiryType).toLowerCase() !== 'walkin') continue;
      const stage = str(r.sRentalType).toLowerCase();
      stageLabels.add(stage || '(blank)');
      const isInquiry = !stage || stage === 'inquiry';
      const isReservation = stage === 'reservation';
      if (isInquiry) inquiryOnly++;
      else if (isReservation) resOnly++;
      else otherStage++;
      if (isInquiry || isReservation) combined++;
    }
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

console.log('\n=== InquiryTracking walk-in rows, 25 sites shared with legacy, Jul 2026 MTD ===');
console.log(`Inquiry-stage only:             ${inquiryOnly}`);
console.log(`Reservation-stage only:         ${resOnly}`);
console.log(`Other/unrecognized stage:       ${otherStage}  (labels seen: ${[...stageLabels].join(', ') || '(none)'})`);
console.log(`Inquiry + Reservation combined: ${combined}   (legacy shows 60; ManagementSummary shows 74)`);
process.exit(0);
