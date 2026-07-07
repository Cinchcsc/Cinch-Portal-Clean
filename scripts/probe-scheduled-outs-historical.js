// Michael asked to hardcode "Reservations vs Scheduled Move-outs" correctly for every historical
// month. Investigation found: the ACTIVE RESERVATIONS side is structurally live-only — reportMap.js's
// `reservations` report has `dated: false` (no date range param at all; SiteLink returns the CURRENT
// full reservation list) and its own "active" filter compares dNeeded against `new Date()` (today's
// real date, not any historical reference point) — so even with raw historical data there's no way to
// ask "was this active as of March 2025." Confirmed independently by the legacy portal's own KPI page
// widget, which also stays frozen on the live month regardless of the date picker.
// BUT `scheduled_outs` (ScheduledMoveOuts) has `dated: true` — it DOES take a start/end date range,
// same shape as RentRoll, which Michael confirmed genuinely returns period-correct historical data
// despite our earlier wrong assumption. This probes whether ScheduledMoveOuts behaves the same way:
// pull it for several different historical months for one site and see if the row counts differ
// plausibly (real historical data) or are identical/frozen (live-only, same as reservations).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-scheduled-outs-historical.js [siteCode]
import { pullReport } from '../lib/reportMap.js';

const loc = (process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',')[0] || '').trim();
if (!loc) { console.error('No site code given and SITELINK_LOCATIONS not set'); process.exit(1); }

const testMonths = ['2025-01', '2025-06', '2026-01', '2026-04', '2026-06'];
console.log(`Site ${loc} — ScheduledMoveOuts row count per historical month (dated:true call):\n`);
for (const mk of testMonths) {
  const [y, m] = mk.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0);
  try {
    const { data } = await pullReport('scheduled_outs', loc, start, end);
    console.log(`${mk}: scheduled_move_outs = ${data.scheduled_move_outs}`);
  } catch (e) {
    console.log(`${mk}: ERROR — ${e.message}`);
  }
}
console.log('\nIf these numbers differ plausibly across months, ScheduledMoveOuts supports real historical');
console.log('queries (like RentRoll) and we can backfill the Move-outs side. If they\'re all identical,');
console.log('it\'s live-only (like reservations) and can\'t be backfilled either.');
process.exit(0);
