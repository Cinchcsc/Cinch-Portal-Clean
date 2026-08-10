// PROBE (23/27/28 Jul 2026), task #406/#407/#427 — verifies the live snapshot reservation count
// against the SAME business rule the portal now uses: visible enquiries (Phone/Web/Walk-in only)
// whose InquiryTracking row ENTERED reservation stage on the target day, counted by
// dConverted_ToRsv with sRentalType="Reservation". Older versions had two false-mismatch classes:
//   1. comparing against dPlaced instead of dConverted_ToRsv, which can legitimately differ
//      (e.g. enquiry placed on Jul 21, reservation made on Jul 22);
//   2. reading only a short live InquiryTracking lookback window, which dropped older enquiries that
//      converted to reservation on the target day (e.g. Bicester rows placed on Jun 30 / Jul 14 but
//      converted on Jul 27).
// Read the target date and live counts directly from snapshot_payload, and validate against the
// stored current-month raw_report SOAP that pullSnapshot.js itself reads, so the probe matches the
// live snapshot builder's true source/shape exactly.
//
// Run:  node --env-file=.env scripts/probe-verify-snapshot-fix.js
import { admin } from '../lib/supabaseAdmin.js';
import { extractNamedTable } from '../lib/sitelink.js';
import { readSnapshotPayload } from '../lib/snapshotPayload.js';
import { retryOnStatementTimeout } from '../lib/supabaseRetry.js';

const str = (v) => String(v ?? '').trim();
const channelKey = (v) => str(v).toLowerCase().replace(/[^a-z]/g, '');
const snap = await readSnapshotPayload();
if (!snap?.payload?.daily?.range?.start || !Array.isArray(snap?.payload?.daily?.sites)) {
  console.error('snapshot_payload daily range/sites missing; run npm run pull:snapshot first.');
  process.exit(1);
}
const TARGET_DAY = snap.payload.daily.range.start;
const liveByCode = new Map((snap.payload.daily.sites || []).map((row) => [row.code, row]));
const SITES = [
  ['L029', 'Abingdon'],
  ['L001', 'Bicester'],
  ['L003', 'Letchworth'],
].map(([code, name]) => [code, name, Number(liveByCode.get(code)?.reservations) || 0]);

console.log(`${'='.repeat(95)}\nGround-truth check for ${TARGET_DAY} — stored current-month InquiryTracking SOAP vs the live\nsnapshot's reservation-stage-entered counts, for 3 sites (1 zero, 2 non-zero)\n${'='.repeat(95)}`);
console.log('Uses the stored current-month raw_report InquiryTracking SOAP (the same source pullSnapshot.js reads),');
console.log('so older enquiries that entered reservation stage on the target day are not falsely dropped by a short lookback window.\n');

for (const [code, name, liveCount] of SITES) {
  const monthKey = `${TARGET_DAY.slice(0, 7)}-01`;
  const data = await retryOnStatementTimeout(async () => {
    const { data, error } = await admin
      .from('raw_report')
      .select('raw_response')
      .eq('site_code', code)
      .eq('report', 'lead_funnel')
      .eq('month', monthKey)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  });
  if (!data?.raw_response) {
    console.log(`\n${code} ${name}: no stored raw_report lead_funnel row for ${monthKey.slice(0, 7)} — skipped.`);
    continue;
  }
  const activityRows = extractNamedTable(data.raw_response, 'Activity');
  const targetDayReservations = activityRows.filter((r) => {
    if (str(r.sRentalType).toLowerCase() !== 'reservation') return false;
    if (!['phone', 'walkin', 'web'].includes(channelKey(r.sInquiryType))) return false;
    return str(r.dConverted_ToRsv).startsWith(TARGET_DAY);
  });
  const match = targetDayReservations.length === liveCount;
  console.log(`\n${code} ${name}: live snapshot showed ${liveCount} reservation(s) for ${TARGET_DAY}`);
  console.log(`  Wide-window ground truth: ${targetDayReservations.length} visible reservation-stage row(s) with dConverted_ToRsv on ${TARGET_DAY}`);
  console.log(`  ${match ? 'MATCH — fix is producing the correct count' : '*** MISMATCH — investigate further ***'}`);
  targetDayReservations.forEach((r) => console.log(`    dPlaced=${r.dPlaced}  dConverted_ToRsv=${r.dConverted_ToRsv}  TenantID=${r.TenantID}`));
}

console.log(`\n${'='.repeat(95)}\nIf all 3 say MATCH, the fix is confirmed working correctly (including Abingdon's\ngenuine zero) — not just passing in theory but producing the right live number.\n${'='.repeat(95)}`);
process.exit(0);
