// Follow-up to probe-walkin-dedupe.js: that test on July's 8-day MTD window landed at 72 distinct
// people vs legacy's 60 (20% over — better than the 74-77 raw ManagementSummary count or the 80 raw
// Inquiry+Reservation rows, but not exact). An 8-day sample is small and lumpy, which makes a 20%
// gap hard to interpret. probe-enquiries-gap2.js already hardcoded a legacy target for a FULL closed
// month (June 2026): Walk-ins 233. Re-running the same dedup methodology (InquiryTracking,
// sInquiryType=WalkIn, stage IN {inquiry, reservation}, deduped by email hash) against June's full
// 30 days is a much lower-noise test: if the ratio-to-target improves close to legacy's 233, the
// methodology is right and July's residual gap was mostly small-sample noise. If June ALSO shows a
// similar ~20%+ gap, dedup isn't the full explanation and something else is still going on.
// Also prints the raw ManagementSummary count and raw Inquiry-stage-only count for the same month,
// so all four numbers (current production source, two raw InquiryTracking cuts, deduped) are
// side-by-side against the one legacy target.
// PII-SAFE: emails hashed immediately, never printed/stored raw.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-walkin-june-dedupe.js
import crypto from 'node:crypto';
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const str = (v) => (v == null ? '' : String(v)).trim();
const emailHash = (e) => { const s = str(e).toLowerCase(); return s ? crypto.createHash('sha256').update(s).digest('hex') : null; };

const EXCLUDE = new Set(['L021', 'L026']);   // Bedford, Paulton — not in legacy's scope
const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter((c) => c && !EXCLUDE.has(c));
const start = new Date(2026, 5, 1);   // June 1
const end = new Date(2026, 5, 30);    // June 30 — full closed month, matches probe-enquiries-gap2's target

let mgWalk = 0;
let inquiryRows = 0, combinedRows = 0, noEmail = 0;
const inquiryHashes = new Set(), combinedHashes = new Set();

for (const loc of locations) {
  process.stderr.write(`[june-dedupe] ${loc}...\n`);
  try {
    const { rows: mgRows } = await callReport('ManagementSummary', loc, start, end);
    mgWalk += REPORTS.management.parse(mgRows).walkin_leads || 0;

    const { rows } = await callReport('InquiryTracking', loc, start, end);
    for (const r of rows) {
      if (str(r.sInquiryType).toLowerCase() !== 'walkin') continue;
      const stage = str(r.sRentalType).toLowerCase();
      const isInquiry = !stage || stage === 'inquiry';
      const isReservation = stage === 'reservation';
      if (!isInquiry && !isReservation) continue;
      const h = emailHash(r.sEmail);
      combinedRows++;
      if (isInquiry) inquiryRows++;
      if (!h) { noEmail++; continue; }
      combinedHashes.add(h);
      if (isInquiry) inquiryHashes.add(h);
    }
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

console.log('\n=== Walk-ins, June 2026 (full closed month), 25 sites shared with legacy ===');
console.log(`ManagementSummary (current production source): ${mgWalk}`);
console.log(`InquiryTracking, Inquiry-stage only, raw rows: ${inquiryRows}`);
console.log(`InquiryTracking, Inquiry+Reservation, raw rows: ${combinedRows}`);
console.log(`InquiryTracking, Inquiry+Reservation, deduped by email: ${combinedHashes.size} distinct people`);
console.log(`Rows with no email on file: ${noEmail}`);
console.log(`\nLegacy target: 233`);
process.exit(0);
