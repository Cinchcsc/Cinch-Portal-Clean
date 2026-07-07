// Isolates WHY the InquiryTracking-to-move-in TenantID cross-reference fails despite 100% TenantID
// coverage on Inquiry-stage rows (confirmed by probe-inquiry-tenantid-coverage.js). Two possibilities:
//   (a) InquiryTracking's TenantID is a genuinely different ID space than the one RentRoll/move-in
//       reports use (e.g. a prospect ID vs a tenant ID) — a structural dead end.
//   (b) The specific field we're reading off MoveInsAndMoveOuts for "move_in_tenant_ids" is wrong or
//       unreliable (lib/reportMap.js's move_ins_outs parser comment already flagged this as an
///      unverified assumption), while InquiryTracking's TenantID actually IS the same ID space as
//       everything else.
// This tests (b) by cross-referencing Inquiry-stage TenantIDs against RentRoll's CURRENTLY OCCUPIED
// tenant IDs instead (a field already proven reliable elsewhere — used successfully for the
// Reservations vs Move-outs "already occupied" exclusion). If this overlap is also near-zero, the
// problem is (a), a structural dead end. If this overlap is much higher, the bug is specifically in
// how move_ins_outs extracts TenantID, and that's fixable.
// PII-SAFE: aggregated counts only.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-inquiry-vs-rentroll-tenantid.js
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);

let totalInquiry = 0, overlapWithOccupied = 0;
for (const loc of locations) {
  process.stderr.write(`[inq-vs-rentroll] ${loc}...\n`);
  try {
    const [{ rows: inqRows }, { rows: rrRows }] = await Promise.all([
      callReport('InquiryTracking', loc, start, end),
      callReport('RentRoll', loc, start, end),
    ]);
    const lf = REPORTS.lead_funnel.parse(inqRows);
    const rr = REPORTS.rent_roll.parse(rrRows);
    const occupiedIds = new Set(rr.occupied_tenant_ids || []);
    const inquiryIds = lf.inquiry_tenant_ids || [];
    totalInquiry += inquiryIds.length;
    overlapWithOccupied += inquiryIds.filter((id) => occupiedIds.has(id)).length;
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

console.log(`\nInquiry-stage TenantIDs that match a CURRENTLY OCCUPIED RentRoll tenant this month: ${overlapWithOccupied}/${totalInquiry} (${totalInquiry ? (overlapWithOccupied / totalInquiry * 100).toFixed(1) : 0}%)`);
console.log('\nIf this is meaningfully higher than the ~0.8% seen against move_ins_outs, the bug is specifically');
console.log('in how move_ins_outs extracts TenantID (fixable) — InquiryTracking\'s TenantID IS the right ID space.');
console.log('If this is ALSO near-zero, InquiryTracking\'s TenantID is a different ID space entirely (structural dead end).');
process.exit(0);
