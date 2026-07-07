// Follow-up to probe-enquiries-gap2.js. That run showed the TOTAL is now close (4414 vs target
// 4178, +5.6%) but the CHANNEL MIX is badly wrong: Phone 102 vs target 269 (-62%), Walk-in 78 vs
// target 233 (-66%), Web 4225 vs target 3675 (+15%). Total being roughly right while Phone/Walk-in
// are massively undercounted and Web absorbs the difference points to MISATTRIBUTION, not a
// filtering/dedup bug: `sInquiryType` may not be the field the legacy portal actually uses for this
// breakdown — e.g. it could reflect the channel of the MOST RECENT touchpoint (which defaults to
// "Web" for anything logged online later) rather than the ORIGINATING channel of first contact.
// This dumps every column on InquiryTracking's Inquiry-stage rows, then for every column whose name
// suggests it could be a channel/source/origin field, prints its distinct-value counts (portfolio-
// wide) so we can see which field's distribution actually lands near the legacy ratio
// (Phone ~6.4%, Walk-in ~5.6%, Web ~88.0% of 4178).
// PII-SAFE: only prints column names and aggregated distinct-value counts, no tenant/contact info.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiries-channel-field.js
import { callReport } from '../lib/sitelink.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);
const str = (v) => (v ?? '').toString().trim();
const isInquiryStage = (r) => { const t = str(r.sRentalType).toLowerCase(); return !t || t === 'inquiry'; };

let allCols = null;
const valueCounts = {}; // colName -> { value -> count }

for (const loc of locations) {
  process.stderr.write(`[channel-field] ${loc}...\n`);
  try {
    const { rows } = await callReport('InquiryTracking', loc, start, end);
    const filtered = rows.filter(isInquiryStage);
    if (!filtered.length) continue;
    if (!allCols) allCols = Object.keys(filtered[0]).filter(c => !/^(diffgr|msdata)/i.test(c));
    for (const r of filtered) {
      for (const c of allCols) {
        const v = str(r[c]);
        (valueCounts[c] ??= {});
        valueCounts[c][v] = (valueCounts[c][v] || 0) + 1;
      }
    }
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

console.log('\nALL COLUMNS on InquiryTracking (Inquiry-stage rows):', allCols.join(', '));

const candidateRe = /origin|source|channel|method|type|referr|market|lead/i;
const candidates = allCols.filter(c => candidateRe.test(c));
console.log(`\nCandidate channel/source-like columns: ${candidates.join(', ')}\n`);

for (const c of candidates) {
  const counts = valueCounts[c];
  const distinctN = Object.keys(counts).length;
  console.log(`--- ${c} (${distinctN} distinct values) ---`);
  if (distinctN <= 20) {
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    for (const [v, n] of sorted) console.log(`   ${(v || '(blank)').padEnd(30)} ${n}`);
  } else {
    console.log(`   (too many distinct values to list — likely an ID column, not a channel)`);
  }
  console.log();
}

console.log('Target ratio (legacy, last complete month): Phone 269 (6.4%), Walk-in 233 (5.6%), Web 3675 (88.0%) of 4178');
process.exit(0);
