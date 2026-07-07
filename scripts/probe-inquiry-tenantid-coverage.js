// Last diagnostic on the Converted % problem. Two TenantID cross-reference attempts (same-month and
// 1-month-lag) both landed under 1% portfolio-wide — implausibly low even accounting for a real sales
// cycle. This checks the simplest possible explanation: what fraction of Inquiry-stage InquiryTracking
// rows even HAVE a non-blank, non-zero TenantID at all? If nearly all are blank/0, TenantID simply
// isn't assigned yet at the enquiry stage (only once a reservation/lease exists), which would make
// TenantID cross-referencing structurally impossible with this report — not a windowing problem.
// PII-SAFE: prints only counts, never the TenantID values themselves.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-inquiry-tenantid-coverage.js
import { callReport } from '../lib/sitelink.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);
const str = (v) => (v ?? '').toString().trim();
const isInquiryStage = (r) => { const t = str(r.sRentalType).toLowerCase(); return !t || t === 'inquiry'; };
const isBlankId = (v) => v === undefined || v === null || v === '' || Number(v) === 0;

let totalInquiry = 0, withTenantId = 0;
for (const loc of locations) {
  process.stderr.write(`[tenantid-coverage] ${loc}...\n`);
  try {
    const { rows } = await callReport('InquiryTracking', loc, start, end);
    for (const r of rows) {
      if (!isInquiryStage(r)) continue;
      totalInquiry++;
      if (!isBlankId(r.TenantID)) withTenantId++;
    }
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

console.log(`\nInquiry-stage rows with a non-blank/non-zero TenantID: ${withTenantId}/${totalInquiry} (${totalInquiry ? (withTenantId / totalInquiry * 100).toFixed(1) : 0}%)`);
console.log('\nIf this is near 0%, TenantID is not assigned at the enquiry stage at all — cross-referencing');
console.log('by TenantID against move-ins is a dead end with this report, regardless of time window.');
console.log('If this is near 100%, TenantIDs exist but simply do not match move-in TenantIDs later —');
console.log('meaning either the ID changes at conversion, or the linkage needs a different key entirely.');
process.exit(0);
