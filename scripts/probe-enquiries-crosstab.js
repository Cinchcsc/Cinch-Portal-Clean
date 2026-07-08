// Follow-up to probe-enquiries-channel-field.js: sInquiryType's breakdown (Web 95.7%/Phone 2.3%/
// WalkIn 1.8%) is badly skewed vs legacy's own split (Web 88.0%/Phone 6.4%/Walk-in 5.6%), even
// though the OVERALL total (4391 vs legacy 4178, ~5% over, explained by our 2 extra sites) is close.
// That means individual rows are being MISCLASSIFIED by sInquiryType, not miscounted overall.
// sCallType's "Facility" value (191 rows, 4.3%) sits much closer to legacy's Walk-in scale (5.6%)
// than sInquiryType's own WalkIn bucket (78, 1.8%) does — and 78+191=269 happens to equal legacy's
// Phone target exactly, which could be coincidence or could mean sCallType and sInquiryType disagree
// on a meaningful chunk of rows. This cross-tabulates sInquiryType x sCallType directly (and x
// sSource for completeness) to see the JOINT distribution — if a lot of "Facility" (in-person) rows
// are tagged sInquiryType=Web, that's the misattribution mechanism, caught red-handed.
// Scoped to the 25 sites shared with legacy (excl. Bedford/Paulton) for a clean comparison.
// PII-SAFE: only prints aggregated cross-tab counts, no tenant/contact info.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiries-crosstab.js
import { callReport } from '../lib/sitelink.js';

const str = (v) => (v ?? '').toString().trim();
const isInquiryStage = (r) => { const t = str(r.sRentalType).toLowerCase(); return !t || t === 'inquiry'; };

const EXCLUDE = new Set(['L021', 'L026']);
const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter((c) => c && !EXCLUDE.has(c));
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);   // last complete month (June, run today)
const end = new Date(now.getFullYear(), now.getMonth(), 0);

const crossCallType = {};   // sInquiryType -> sCallType -> count
const crossSource = {};     // sInquiryType -> sSource -> count

for (const loc of locations) {
  process.stderr.write(`[crosstab] ${loc}...\n`);
  try {
    const { rows } = await callReport('InquiryTracking', loc, start, end);
    for (const r of rows.filter(isInquiryStage)) {
      const it = str(r.sInquiryType) || '(blank)';
      const ct = str(r.sCallType) || '(blank)';
      const src = str(r.sSource) || '(blank)';
      (crossCallType[it] ??= {}); crossCallType[it][ct] = (crossCallType[it][ct] || 0) + 1;
      (crossSource[it] ??= {}); crossSource[it][src] = (crossSource[it][src] || 0) + 1;
    }
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

console.log('\n=== sInquiryType x sCallType, 25 sites shared with legacy, last complete month ===');
for (const [it, cts] of Object.entries(crossCallType)) {
  console.log(`  sInquiryType="${it}":`);
  for (const [ct, n] of Object.entries(cts).sort((a, b) => b[1] - a[1])) console.log(`    sCallType="${ct}"  ->  ${n}`);
}

console.log('\n=== sInquiryType x sSource, 25 sites shared with legacy, last complete month ===');
for (const [it, srcs] of Object.entries(crossSource)) {
  console.log(`  sInquiryType="${it}":`);
  for (const [src, n] of Object.entries(srcs).sort((a, b) => b[1] - a[1])) console.log(`    sSource="${src}"  ->  ${n}`);
}

console.log('\nLooking for: rows with sInquiryType="Web" but sCallType="Facility" (in-person contact');
console.log('mistagged as web) — if that pool is large, sCallType="Facility" may be the truer Walk-in signal.');
console.log('Legacy target (last complete month): Phone 269 (6.4%), Walk-in 233 (5.6%), Web 3675 (88.0%)');
process.exit(0);
