// BREAKTHROUGH candidate, found via Michael's uploaded Bicester InquiryTracking export (Jul 2026):
// filtering rows by dPlaced falling WITHIN the requested date range — regardless of current
// sRentalType stage — gave an EXACT match to Bicester's own legacy target (Phone=2, Walk-in=2) and
// a close Web match (25 vs legacy's 21), vastly better than our current isInquiryStage (sRentalType=
// 'Inquiry') filter, which conflates "currently sitting in Inquiry status" with "originated this
// period" — an old Sept-2025 lead still unprogressed can get swept into a July pull, while a walk-in
// that quickly progressed to Reservation/Move-In falls OUT of an Inquiry-only filter even though it
// genuinely originated in July. That mechanism fits the exact pattern seen everywhere this session:
// Web over-represented (old stale web leads sit in limbo longest), Phone/Walk-in under-represented
// (they get worked/progressed fast, so they "graduate" out of the naive stage filter).
// This tests the SAME dPlaced-based filter against the FULL portfolio (25 sites shared with legacy)
// for July MTD, against the known legacy targets from the screenshot: Phone=54, Walk-in=60, Web=887,
// Total=1002. One site validating this isn't enough — Rate/RealRate looked perfect on Bicester too
// and fell apart elsewhere, so this is the decisive test before touching any production code.
// PII-SAFE: aggregated counts only.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiries-dplaced.js
import { callReport } from '../lib/sitelink.js';

const str = (v) => (v ?? '').toString().trim();
const EXCLUDE = new Set(['L021', 'L026']);
const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter((c) => c && !EXCLUDE.has(c));

const start = new Date(2026, 6, 1, 0, 0, 0, 0);         // Jul 1 00:00:00
const end = new Date(2026, 6, 8, 23, 59, 59, 999);      // Jul 8 23:59:59 -- full last day, matches how the report was pulled

// Current production filter, for side-by-side comparison.
const isInquiryStage = (r) => { const t = str(r.sRentalType).toLowerCase(); return !t || t === 'inquiry'; };

let dPlacedPhone = 0, dPlacedWalk = 0, dPlacedWeb = 0, dPlacedEmail = 0, dPlacedOther = 0, dPlacedTotal = 0;
let stagePhone = 0, stageWalk = 0, stageWeb = 0, stageEmail = 0, stageTotal = 0;

for (const loc of locations) {
  process.stderr.write(`[dplaced] ${loc}...\n`);
  try {
    // Normal Jul 1-8 request, same range production already uses — Michael's uploaded Bicester
    // export proves the server-side filter is already more inclusive than plain dPlaced (it returned
    // rows dated back to Sept 2025 for this same Jul1-8 request), so no widening is needed here.
    const { rows } = await callReport('InquiryTracking', loc, start, end);
    for (const r of rows) {
      const dPlaced = r.dPlaced ? new Date(r.dPlaced) : null;
      const it = str(r.sInquiryType).toLowerCase();
      if (dPlaced && dPlaced >= start && dPlaced <= end) {
        dPlacedTotal++;
        if (it === 'phone') dPlacedPhone++;
        else if (it === 'walkin') dPlacedWalk++;
        else if (it === 'web') dPlacedWeb++;
        else if (it === 'email') dPlacedEmail++;
        else dPlacedOther++;
      }
      if (isInquiryStage(r)) {
        stageTotal++;
        if (it === 'phone') stagePhone++;
        else if (it === 'walkin') stageWalk++;
        else if (it === 'web') stageWeb++;
        else if (it === 'email') stageEmail++;
      }
    }
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

console.log('\n=== dPlaced-in-window filter (candidate fix), 25 sites, Jul 2026 MTD ===');
console.log(`Phone=${dPlacedPhone}  Walk-in=${dPlacedWalk}  Web=${dPlacedWeb}  Email=${dPlacedEmail}  Other=${dPlacedOther}  Total=${dPlacedTotal}`);
console.log('Legacy target:  Phone=54  Walk-in=60  Web=887  Total=1002\n');

console.log('=== Current production filter (sRentalType=Inquiry stage), same 25 sites, for comparison ===');
console.log(`Phone=${stagePhone}  Walk-in=${stageWalk}  Web=${stageWeb}  Email=${stageEmail}  Total=${stageTotal}`);
process.exit(0);
