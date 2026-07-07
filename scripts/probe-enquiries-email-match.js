// Last resort on the Converted % problem: TenantID cross-referencing is confirmed structurally
// broken (0.3% overlap even against RentRoll's own known-reliable occupied tenant list), and
// InquiryTracking has no WaitingID that propagates to MoveInsAndMoveOuts either. Both reports DO
// carry an sEmail column, though — a real-world identifier that should be stable across a person's
// entire journey (enquiry -> move-in) regardless of which internal ID space each report uses. This
// tests matching June's Inquiry-stage rows against June's move-in rows BY EMAIL ADDRESS.
// PRIVACY: email addresses are matched in memory only and are NEVER printed, logged, or persisted —
// only the final aggregate match count is output, exactly like every other cross-reference in this
// project. Blank/missing emails on either side are excluded from the comparison entirely.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiries-email-match.js
import { callReport } from '../lib/sitelink.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);
const str = (v) => (v ?? '').toString().trim().toLowerCase();
const isInquiryStage = (r) => { const t = str(r.sRentalType); return !t || t === 'inquiry'; };
// Same flexible boolean check lib/reportMap.js's move_ins_outs parser already uses for this exact
// field (`yes()`) — SiteLink can return "1"/"true" as strings rather than a literal boolean/number,
// and a strict === check would silently produce an EMPTY move-in set, guaranteeing 0 matches
// regardless of whether email matching actually works. That's what happened on the first run.
const yes = (v) => v === true || v === 1 || /^(1|true|yes)$/i.test(str(v));

let totalInquiryWithEmail = 0, matched = 0, totalInquiryRows = 0, totalMoveInRows = 0, totalMoveInWithEmail = 0;
for (const loc of locations) {
  process.stderr.write(`[email-match] ${loc}...\n`);
  try {
    const [{ rows: inqRows }, { rows: moRows }] = await Promise.all([
      callReport('InquiryTracking', loc, start, end),
      callReport('MoveInsAndMoveOuts', loc, start, end),
    ]);
    const moveInRows = moRows.filter(r => yes(r.MoveIn));
    totalMoveInRows += moveInRows.length;
    const moveInEmails = new Set(moveInRows.map(r => str(r.sEmail)).filter(Boolean));
    totalMoveInWithEmail += moveInEmails.size;
    for (const r of inqRows) {
      if (!isInquiryStage(r)) continue;
      totalInquiryRows++;
      const email = str(r.sEmail);
      if (!email) continue;
      totalInquiryWithEmail++;
      if (moveInEmails.has(email)) matched++;
    }
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

console.log(`\nJune move-in rows: ${totalMoveInRows}, with a non-blank email: ${totalMoveInWithEmail} (sanity check — if this is 0, the match set is empty and no comparison was possible at all)`);
console.log(`Inquiry-stage rows: ${totalInquiryRows}`);
console.log(`Inquiry-stage rows with a non-blank email: ${totalInquiryWithEmail} (${totalInquiryRows ? (totalInquiryWithEmail / totalInquiryRows * 100).toFixed(1) : 0}%)`);
console.log(`Matched to a June move-in by email: ${matched} (${totalInquiryWithEmail ? (matched / totalInquiryWithEmail * 100).toFixed(1) : 0}% of those with an email, ${totalInquiryRows ? (matched / totalInquiryRows * 100).toFixed(1) : 0}% of all enquiries)`);
console.log('\nIf this lands in a plausible 10-40% range, email is the right join key and this can replace');
console.log('the TenantID-based approach in lib/buildPayload.js. If still near-zero, the gap may be a');
console.log('genuinely longer sales cycle than one month, or email simply isn\'t populated consistently.');
process.exit(0);
