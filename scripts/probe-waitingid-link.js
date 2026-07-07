// New lead on the Converted % problem: TenantID cross-referencing is confirmed dead (0.3% overlap
// even against RentRoll's known-reliable occupied tenant list — probe-inquiry-vs-rentroll-tenantid.js).
// InquiryTracking has a SEPARATE column, WaitingID, distinct from TenantID (seen in the full column
// dump from probe-enquiries-channel-field.js). WaitingID is the natural "prospect" identifier that
// should persist across funnel stages (Inquiry -> Reservation -> Move-In) even before a real TenantID
// exists — this checks whether MoveInsAndMoveOuts (or RentRoll) exposes a WaitingID field we could
// link against instead of TenantID.
// PII-SAFE: prints column names and aggregated counts only.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-waitingid-link.js
import { callReport } from '../lib/sitelink.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);

for (const method of ['MoveInsAndMoveOuts', 'RentRoll']) {
  console.log(`\n=== ${method} columns ===`);
  try {
    const { rows } = await callReport(method, loc, start, end);
    if (!rows.length) { console.log('  (no rows)'); continue; }
    const cols = Object.keys(rows[0]).filter(c => !/^(diffgr|msdata)/i.test(c));
    console.log(' ', cols.join(', '));
    const waitingCols = cols.filter(c => /waiting/i.test(c));
    console.log(`  WaitingID-like columns: ${waitingCols.length ? waitingCols.join(', ') : '(none found)'}`);
  } catch (e) { console.log('  error:', e.message); }
}
process.exit(0);
