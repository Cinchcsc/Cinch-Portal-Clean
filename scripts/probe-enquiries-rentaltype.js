// Follow-up to probe-enquiries-dup.js: TenantID dedup showed only 8 of 192 Bicester rows are true
// duplicates — not enough to explain the ~1.55x portfolio-wide overcount (matches this site's own
// 192 vs target 122 ratio almost exactly, 1.57x). Since InquiryTracking rows carry a `sRentalType`/
// `QTRentalTypeID` column (what kind of unit the prospect was inquiring about — the same site can
// take enquiries for Self Storage, vehicle storage, business units, etc.), and every other metric in
// this codebase (Rate, Occupancy, etc.) is scoped to "Self Storage only" per the legacy portal's own
// convention, this checks whether the legacy Enquiries widget might ALSO only count Self-Storage
// rental-type enquiries — which would explain a uniform ~1.55x overcount across every channel.
// PII-SAFE: only type/channel labels and counts, no names/contact info.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiries-rentaltype.js
import { callReport } from '../lib/sitelink.js';

const loc = 'L001';
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);

const { rows } = await callReport('InquiryTracking', loc, start, end);
console.log(`site ${loc} · ${rows.length} total rows · target: Phone 3, Walk-in 7, Web 112, Total 122\n`);

const byType = {};
for (const r of rows) {
  const k = `${r.sRentalType ?? '(blank)'} [QTRentalTypeID=${r.QTRentalTypeID}]`;
  (byType[k] ??= { count: 0, byChannel: {} });
  byType[k].count++;
  const ch = String(r.sInquiryType ?? '').toLowerCase() || '(blank)';
  byType[k].byChannel[ch] = (byType[k].byChannel[ch] || 0) + 1;
}
console.log('Breakdown by sRentalType:');
for (const [k, v] of Object.entries(byType)) console.log(`  ${k}: ${v.count} rows · by channel: ${JSON.stringify(v.byChannel)}`);

// Recompute totals AS IF only counting the single largest sRentalType group (the presumed
// "Self Storage" one) to see how close that gets to the target.
const biggest = Object.entries(byType).sort((a, b) => b[1].count - a[1].count)[0];
console.log(`\nIf we ONLY count the largest group (${biggest[0]}):`);
const ch = biggest[1].byChannel;
const web = (ch.web || 0) + (ch.email || 0);
console.log(`  Phone=${ch.phone || 0}  Walk-in=${ch.walkin || 0}  Web(+Email)=${web}  Total=${(ch.phone || 0) + (ch.walkin || 0) + web}`);
process.exit(0);
