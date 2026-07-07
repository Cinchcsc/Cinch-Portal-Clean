// Follow-up to probe-enquiries-channel-field.js. That run dumped every column on InquiryTracking
// and found NOTHING reproduces the legacy ratio (Phone 6.4% / Walk-in 5.6% / Web 88.0%) —
// sInquiryType (== iInquiryType, same categorical, just string/numeric) is Web 95.7% / Phone 2.3% /
// Walk-in 1.8%, and no other column (sCallType, sSource, sMarketingDesc) lines up either. That rules
// out "wrong field within InquiryTracking" — the per-CHANNEL breakdown may simply come from a
// DIFFERENT report than the one used for the total.
// ManagementSummary already has labelled phone_leads/web_leads/walkin_leads fields (lib/reportMap.js
// parses them as mg.phone_leads etc., currently only used for internal reference — Michael's 1 Jul
// 2026 spec moved the Enquiries TOTAL to InquiryTracking, but that decision doesn't necessarily also
// cover the per-channel split shown by the legacy portal). This sums those three ManagementSummary
// fields portfolio-wide for the last complete month and compares against the same legacy target.
// PII-SAFE: aggregated counts only.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiries-mgmt-breakdown.js
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);
console.log(`${locations.length} sites · last complete month window ${start.toISOString().slice(0, 10)} -> ${end.toISOString().slice(0, 10)}\n`);

let phone = 0, web = 0, walkin = 0, convertedLeads = 0;
for (const loc of locations) {
  process.stderr.write(`[mgmt-breakdown] ${loc}...\n`);
  try {
    const { rows } = await callReport('ManagementSummary', loc, start, end);
    const p = REPORTS.management.parse(rows);
    phone += p.phone_leads || 0; web += p.web_leads || 0; walkin += p.walkin_leads || 0;
    convertedLeads += p.leads_converted || 0;
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

const total = phone + web + walkin;
console.log('\n=== ManagementSummary lead breakdown (portfolio, last complete month) ===');
console.log(`Phone=${phone} (${(phone / total * 100).toFixed(1)}%)  Walk-in=${walkin} (${(walkin / total * 100).toFixed(1)}%)  Web=${web} (${(web / total * 100).toFixed(1)}%)  Total=${total}`);
console.log(`(for reference) Leads Converted (mo): ${convertedLeads}`);
console.log('\nTarget (legacy, last complete month): Phone 269 (6.4%), Walk-in 233 (5.6%), Web 3675 (88.0%), Total 4178');
console.log('\nFor comparison, InquiryTracking sInquiryType gave: Phone 102 (2.3%), Walk-in 78 (1.8%), Web 4225 (95.7%), Total 4405 (probe:enquiries-gap2)');
process.exit(0);
