// Follow-up to probe-enquiries-conversion-moveins.js, which tested SAME-MONTH TenantID matching
// (June enquiries vs June move-ins) and got an implausible 0.1% portfolio-wide. The likely reason:
// a real storage-unit sales cycle (enquiry -> tour/reservation -> move-in) often spans WEEKS, so a
// lead placed on June 25th converting on July 8th would never match under same-month-only logic.
// This tests a 1-MONTH-LAG window instead: does MAY's Inquiry-stage TenantIDs show up in JUNE's
// move-ins (a lagged cohort match), which is fully knowable with historical (non-live) data, unlike
// trying to look forward from June into the still-in-progress July.
// Also prints the STRICT same-month rate for May (as a same-month baseline, mirroring the June test)
// so the two windows can be compared directly, portfolio-wide.
// PII-SAFE: aggregated counts only.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiries-conversion-lag.js
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const may = { start: new Date(now.getFullYear(), now.getMonth() - 2, 1), end: new Date(now.getFullYear(), now.getMonth() - 1, 0) };
const june = { start: new Date(now.getFullYear(), now.getMonth() - 1, 1), end: new Date(now.getFullYear(), now.getMonth(), 0) };
console.log(`May window: ${may.start.toISOString().slice(0, 10)} -> ${may.end.toISOString().slice(0, 10)}`);
console.log(`June window: ${june.start.toISOString().slice(0, 10)} -> ${june.end.toISOString().slice(0, 10)}\n`);

let mayEnq = 0, sameMonthConv = 0, laggedConv = 0;
for (const loc of locations) {
  process.stderr.write(`[conv-lag] ${loc}...\n`);
  try {
    const [{ rows: mayInq }, { rows: mayMo }, { rows: juneMo }] = await Promise.all([
      callReport('InquiryTracking', loc, may.start, may.end),
      callReport('MoveInsAndMoveOuts', loc, may.start, may.end),
      callReport('MoveInsAndMoveOuts', loc, june.start, june.end),
    ]);
    const lf = REPORTS.lead_funnel.parse(mayInq);
    const mayMio = REPORTS.move_ins_outs.parse(mayMo);
    const juneMio = REPORTS.move_ins_outs.parse(juneMo);
    const inquiryIds = lf.inquiry_tenant_ids || [];
    mayEnq += lf.total_enquiries || 0;

    const sameMonthIds = new Set(mayMio.move_in_tenant_ids || []);
    sameMonthConv += inquiryIds.filter((id) => sameMonthIds.has(id)).length;

    const laggedIds = new Set([...(mayMio.move_in_tenant_ids || []), ...(juneMio.move_in_tenant_ids || [])]);
    laggedConv += inquiryIds.filter((id) => laggedIds.has(id)).length;
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

console.log(`\nMay enquiries (portfolio): ${mayEnq}`);
console.log(`Same-month conversions (May enquiry -> May move-in): ${sameMonthConv}  (${mayEnq ? (sameMonthConv / mayEnq * 100).toFixed(1) : 0}%)`);
console.log(`Lagged conversions (May enquiry -> May OR June move-in): ${laggedConv}  (${mayEnq ? (laggedConv / mayEnq * 100).toFixed(1) : 0}%)`);
console.log('\nIf the lagged rate is meaningfully higher and lands in a plausible 10-40% range, the real fix is widening the move-in lookback window, not the matching logic itself.');
process.exit(0);
