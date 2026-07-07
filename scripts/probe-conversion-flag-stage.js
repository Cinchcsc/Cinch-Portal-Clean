// Investigates "Leads by Store" showing 0.0% conversion for several stores (3 Jul 2026). Current
// logic (lib/reportMap.js's lead_funnel parser) only checks `iInquiryConvertedToLease` on rows
// still tagged sRentalType="Inquiry". But we already know from the Enquiries fix (npm run
// probe:enquiries-rentaltype) that InquiryTracking creates a NEW row each time a lead progresses
// funnel stage (Inquiry -> Reservation -> Move In) — so if the conversion flag actually gets set on
// the NEW Reservation/Move-In row rather than retroactively on the original Inquiry row, checking
// only Inquiry-stage rows would structurally undercount conversions everywhere, not just for
// genuinely-zero-conversion stores.
// This checks, per funnel stage (Inquiry / Reservation / Move In / other), what fraction of rows
// have iInquiryConvertedToLease=true — portfolio-wide — to see which stage the flag actually lives on.
// PII-SAFE: aggregated counts only.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-conversion-flag-stage.js
import { callReport } from '../lib/sitelink.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);
const str = (v) => (v ?? '').toString().trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes)$/i.test(str(v));

const byStage = {}; // stage -> { total, convertedTrue }
let zeroConvSites = [], nonZeroConvSites = [];

for (const loc of locations) {
  process.stderr.write(`[conv-flag] ${loc}...\n`);
  try {
    const { rows } = await callReport('InquiryTracking', loc, start, end);
    let siteInquiryTotal = 0, siteInquiryConv = 0;
    for (const r of rows) {
      const stage = str(r.sRentalType) || '(blank)';
      const o = (byStage[stage] ??= { total: 0, convertedTrue: 0 });
      o.total++;
      if (yes(r.iInquiryConvertedToLease)) o.convertedTrue++;
      if (stage.toLowerCase() === 'inquiry' || !str(r.sRentalType)) {
        siteInquiryTotal++;
        if (yes(r.iInquiryConvertedToLease)) siteInquiryConv++;
      }
    }
    if (siteInquiryTotal > 0) {
      if (siteInquiryConv === 0) zeroConvSites.push(loc); else nonZeroConvSites.push(loc);
    }
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

console.log('\n=== iInquiryConvertedToLease=true rate, BY FUNNEL STAGE (portfolio-wide) ===');
for (const [stage, o] of Object.entries(byStage)) {
  console.log(`  ${stage.padEnd(14)} total=${String(o.total).padStart(6)}  convertedTrue=${String(o.convertedTrue).padStart(6)}  rate=${(o.convertedTrue / o.total * 100).toFixed(1)}%`);
}
console.log(`\nSites with 0 conversions among their Inquiry-stage rows: ${zeroConvSites.length} (${zeroConvSites.join(', ')})`);
console.log(`Sites with >0 conversions among their Inquiry-stage rows: ${nonZeroConvSites.length} (${nonZeroConvSites.join(', ')})`);
console.log('\nIf Reservation/Move-In stage rows show a MUCH higher convertedTrue rate than Inquiry-stage rows, the flag lives on the progressed-stage row, not the original Inquiry row — confirming the undercount theory.');
process.exit(0);
