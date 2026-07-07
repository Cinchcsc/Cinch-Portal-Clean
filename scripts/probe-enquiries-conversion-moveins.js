// Verifies the Converted % fix (3 Jul 2026): Michael's SiteLink documentation confirms "Converted %
// = leads that resulted in a MOVE-IN divided by total leads" — replacing the old
// iInquiryConvertedToLease-flag-based count (likely why several stores showed a flat 0.0%). This
// pulls InquiryTracking + MoveInsAndMoveOuts for every site for the last complete month, cross-
// references Inquiry-stage TenantIDs against actual move-in TenantIDs (same logic now in
// lib/buildPayload.js), and prints a per-site Converted % so we can eyeball whether the 0.0% stores
// disappear and the numbers look like plausible storage-industry conversion rates (typically 20-40%).
// PII-SAFE: aggregated counts only, no names/contact info.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiries-conversion-moveins.js
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);
console.log(`${locations.length} sites · last complete month window ${start.toISOString().slice(0, 10)} -> ${end.toISOString().slice(0, 10)}\n`);

let totalEnq = 0, totalConv = 0, zeroCount = 0;
for (const loc of locations) {
  process.stderr.write(`[conv-moveins] ${loc}...\n`);
  try {
    const [{ rows: inqRows }, { rows: moRows }] = await Promise.all([
      callReport('InquiryTracking', loc, start, end),
      callReport('MoveInsAndMoveOuts', loc, start, end),
    ]);
    const lf = REPORTS.lead_funnel.parse(inqRows);
    const mio = REPORTS.move_ins_outs.parse(moRows);
    const moveInIds = new Set(mio.move_in_tenant_ids || []);
    const inquiryIds = lf.inquiry_tenant_ids || [];
    const conv = inquiryIds.filter((id) => moveInIds.has(id)).length;
    const pct = lf.total_enquiries ? (conv / lf.total_enquiries * 100).toFixed(1) : '0.0';
    if (conv === 0) zeroCount++;
    totalEnq += lf.total_enquiries; totalConv += conv;
    console.log(`  ${loc}: enquiries=${lf.total_enquiries}  move-in-conversions=${conv}  Converted%=${pct}%  (old flag-based conv=${lf.conversions})`);
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

console.log(`\nPortfolio: ${totalEnq} enquiries, ${totalConv} move-in conversions, Converted% = ${totalEnq ? (totalConv / totalEnq * 100).toFixed(1) : 0}%`);
console.log(`Sites still showing 0 conversions under the NEW logic: ${zeroCount}/${locations.length}`);
process.exit(0);
