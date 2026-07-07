// Follow-up to probe-enquiries-dup.js / probe-enquiries-rentaltype.js, now that the sRentalType
// funnel-stage filter (isInquiryStage) is live in lib/reportMap.js. That fix took Bicester from
// 192 -> 148 rows against a target of 122 (57% over -> 21% over) — real progress, but a ~20% gap
// remains, portfolio-wide. This checks three follow-up hypotheses against the ACTUAL post-fix
// filtered rows, across ALL sites (like npm run audit), for direct comparison against the known
// legacy portfolio target for last month (Phone 269, Walk-ins 233, Web 3675, Total 4178):
//   (a) is the gap concentrated in one channel (e.g. "Email"), which legacy's own 3-number total
//       (Phone+Walkin+Web already sums to ~Total, with no separate Email bucket) suggests might not
//       be a real, separately-counted SiteLink channel at all;
//   (b) are there still duplicate rows for the same lead even within the Inquiry-stage-filtered set
//       (e.g. follow-up activity creating a new row without progressing the funnel stage);
//   (c) what does "Total = Phone+Walkin+Web only" (excluding Email entirely, not web_combined) land on.
// PII-SAFE: only prints aggregated counts and ID-column duplicate stats, no names/contact info.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiries-gap2.js
import { callReport } from '../lib/sitelink.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);
console.log(`${locations.length} sites · last complete month window ${start.toISOString().slice(0, 10)} -> ${end.toISOString().slice(0, 10)}\n`);

const str = (v) => (v ?? '').toString().trim();
const isInquiryStage = (r) => { const t = str(r.sRentalType).toLowerCase(); return !t || t === 'inquiry'; };

let rawTotal = 0, filteredTotal = 0;
let phone = 0, walkin = 0, web = 0, email = 0, other = 0;
const idColDupCounts = {}; // idCol -> total count of values that appear >1 time, summed across sites
let idColsSeen = null;

for (const loc of locations) {
  process.stderr.write(`[gap2] ${loc}...\n`);
  try {
    const { rows } = await callReport('InquiryTracking', loc, start, end);
    rawTotal += rows.length;
    const filtered = rows.filter(isInquiryStage);
    filteredTotal += filtered.length;
    for (const r of filtered) {
      const k = str(r.sInquiryType).toLowerCase();
      if (k === 'phone') phone++; else if (k === 'walkin') walkin++; else if (k === 'web') web++; else if (k === 'email') email++; else other++;
    }
    // Duplicate-ID check within the filtered set, per site, aggregated across the portfolio.
    if (filtered.length) {
      const cols = Object.keys(filtered[0]).filter(c => !/^(diffgr|msdata)/i.test(c));
      if (!idColsSeen) idColsSeen = cols.filter(c => /id$/i.test(c) || /^s?inquiry/i.test(c) || /^tenantid$/i.test(c));
      for (const idc of idColsSeen) {
        const seen = new Map();
        for (const r of filtered) { const v = String(r[idc] ?? ''); seen.set(v, (seen.get(v) || 0) + 1); }
        let dupRows = 0;
        for (const n of seen.values()) if (n > 1) dupRows += n;
        idColDupCounts[idc] = (idColDupCounts[idc] || 0) + dupRows;
      }
    }
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

console.log('\n=== Enquiries gap follow-up (post sRentalType/isInquiryStage filter) ===');
console.log(`raw rows (all funnel stages): ${rawTotal}`);
console.log(`filtered rows (Inquiry stage only, current production logic): ${filteredTotal}\n`);
console.log(`Phone=${phone}  Walk-in=${walkin}  Web=${web}  Email=${email}  Other(uncounted)=${other}`);
console.log(`Current formula — Total (Phone+Walkin+Web+Email): ${phone + walkin + web + email}`);
console.log(`Alt formula A — Total excluding Email (Phone+Walkin+Web only): ${phone + walkin + web}`);
console.log('Target (legacy portal, last complete month): Phone 269, Walk-ins 233, Web 3675, Total 4178\n');
console.log('Duplicate-row counts by ID-like column, WITHIN the Inquiry-stage-filtered set (rows involved in a >1x repeat, summed across sites):');
console.log(JSON.stringify(idColDupCounts, null, 2));
process.exit(0);
