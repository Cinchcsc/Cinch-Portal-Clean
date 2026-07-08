// Follow-up to probe-walkin-inquiry-stages.js: Inquiry-stage-only undercounts (27, drops anyone who
// already progressed further) and Inquiry+Reservation combined overcounts (80, double-books anyone
// who progressed stages WITHIN the query window — InquiryTracking gives a NEW row per funnel-stage
// event, same lead, confirmed in reportMap.js's lead_funnel comments). Legacy's 60 sits between them,
// which is exactly what you'd expect if legacy counts distinct WALK-IN PEOPLE this month, not
// distinct stage-transition rows. This dedupes the Inquiry+Reservation walk-in row set by sEmail
// (hashed immediately, never printed/stored raw — same PII pattern as lead_funnel's existing
// inquiryEmailHashes/reservationEmailHashes) and counts distinct people instead of rows.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-walkin-dedupe.js
import crypto from 'node:crypto';
import { callReport } from '../lib/sitelink.js';

const str = (v) => (v == null ? '' : String(v)).trim();
const emailHash = (e) => { const s = str(e).toLowerCase(); return s ? crypto.createHash('sha256').update(s).digest('hex') : null; };

const EXCLUDE = new Set(['L021', 'L026']);
const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter((c) => c && !EXCLUDE.has(c));
const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);

const inquiryHashes = new Set(), combinedHashes = new Set();
let inquiryRows = 0, combinedRows = 0, noEmail = 0;

for (const loc of locations) {
  process.stderr.write(`[walkin-dedupe] ${loc}...\n`);
  try {
    const { rows } = await callReport('InquiryTracking', loc, start, end);
    for (const r of rows) {
      if (str(r.sInquiryType).toLowerCase() !== 'walkin') continue;
      const stage = str(r.sRentalType).toLowerCase();
      const isInquiry = !stage || stage === 'inquiry';
      const isReservation = stage === 'reservation';
      if (!isInquiry && !isReservation) continue;   // skip Move-In stage rows, same as before
      const h = emailHash(r.sEmail);
      combinedRows++;
      if (isInquiry) inquiryRows++;
      if (!h) { noEmail++; continue; }
      combinedHashes.add(h);
      if (isInquiry) inquiryHashes.add(h);
    }
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

console.log('\n=== Walk-in, distinct people (email-hash deduped) vs raw rows, 25 sites, Jul 2026 MTD ===');
console.log(`Inquiry-stage:              ${inquiryRows} rows  ->  ${inquiryHashes.size} distinct people`);
console.log(`Inquiry+Reservation:        ${combinedRows} rows  ->  ${combinedHashes.size} distinct people   (legacy shows 60)`);
console.log(`Rows with no email on file: ${noEmail}  (can't dedupe these — each counts as its own person, may inflate slightly)`);
process.exit(0);
