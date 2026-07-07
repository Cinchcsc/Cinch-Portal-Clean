// Both Enquiries and Move-ins & Move-outs are showing numbers far off the legacy portal's target
// (Enquiries target for Bicester, Jun 2026: Phone 3, Walk-in 7, Web 112, Total 122 — portfolio-wide
// 269/233/3675/4178. Move-ins & Move-outs target portfolio-wide: 998 move-ins, 545 move-outs).
// The formulas were already confirmed correct against the legacy portal's own tooltips — this dumps
// the LIVE raw SiteLink rows for ONE site (first in SITELINK_LOCATIONS) for the CURRENT month, so we
// can see exactly what's coming back before blaming the parser.
// PII-SAFE: InquiryTracking dump only prints the origination-type field + counts (no names/contact
// info). ManagementSummary is portfolio summary line items, not tenant-level data.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiries-moveinsouts.js
import { callReport } from '../lib/sitelink.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const end = now;
console.log(`site ${loc} · window ${start.toISOString().slice(0, 10)} -> ${end.toISOString().slice(0, 10)} (today's date drives this — re-run in July and it'll be a July window, not June!)\n`);

console.log('=== InquiryTracking (Enquiries) ===');
const { rows: inqRows } = await callReport('InquiryTracking', loc, start, end);
console.log('total rows:', inqRows.length);
const typeCounts = {};
for (const r of inqRows) { const t = String(r.sInquiryType ?? '(blank)'); typeCounts[t] = (typeCounts[t] || 0) + 1; }
console.log('counts by sInquiryType:', JSON.stringify(typeCounts, null, 2));
console.log('target for this site (Bicester, Jun 2026): Phone 3, Walk-in 7, Web 112 (Web+Email), Total 122');

console.log('\n=== ManagementSummary (Move-ins & Move-outs source) ===');
const { rows: mgRows } = await callReport('ManagementSummary', loc, start, end);
for (const r of mgRows) {
  if (/move.?in|move.?out/i.test(String(r.sDesc ?? ''))) {
    console.log(`sDesc="${r.sDesc}"  iDCount=${r.iDCount}  iMCount=${r.iMCount}  iYCount=${r.iYCount}`);
  }
}
console.log('target portfolio-wide (27 sites, Jun 2026): Move-Ins 998, Move-Outs 545');

console.log('\n=== MoveInsAndMoveOuts (Net ft² source) ===');
const { rows: mioRows } = await callReport('MoveInsAndMoveOuts', loc, start, end);
console.log('total rows (one per move event):', mioRows.length);
let mi = 0, mo = 0, inArea = 0, outArea = 0;
for (const r of mioRows) {
  const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
  if (yes(r.MoveIn)) { mi++; inArea += Number(r.MovedInArea) || 0; }
  if (yes(r.MoveOut)) { mo++; outArea += Number(r.MovedOutArea) || 0; }
}
console.log(`move_ins=${mi} move_outs=${mo} moved_in_area=${Math.round(inArea)} moved_out_area=${Math.round(outArea)} net_area=${Math.round(inArea - outArea)}`);
process.exit(0);
