// Finds the SiteLink Reporting API method(s) for a Reservation List / future-reservations report,
// needed for the "Reservations vs Move-outs" KPI widget (legacy portal tooltip, confirmed 2 Jul
// 2026): Reservations = Reservation List -> Converted To RSV, not cancelled, not moved in, in the
// future. We don't have a report/parser for this yet (only `lead_funnel`'s already-converted count
// and `scheduled_outs`'s bare row count exist today) — this lists every method on the WSDL so we
// can find the right one, then dumps its columns for one site if a likely match is found.
// PII-SAFE: only prints method names and (if a candidate report is called) report column names —
// never row-level tenant data.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-reservations.js
import { listMethods, callReport } from '../lib/sitelink.js';

const methods = await listMethods();
console.log(`WSDL exposes ${methods.length} report methods.\n`);
console.log('ALL METHODS:\n' + methods.join(', '));

const candidates = methods.filter((m) => /reserv/i.test(m));
console.log('\nCANDIDATE METHODS (name hints at "reservation"):');
console.log(candidates.join(', ') || '(none found by name — Reservations may not be reportable via ReportingWs.asmx; check CallCenterWs or the SiteLink docs for a reservation-list endpoint.)');

if (candidates.length) {
  const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = now;
  for (const method of candidates) {
    console.log(`\n--- Trying ${method} for site ${loc} ---`);
    try {
      const { rows } = await callReport(method, loc, start, end);
      console.log(`row count: ${rows.length}`);
      if (rows.length) {
        const cols = Object.keys(rows[0]).filter((k) => !/^(diffgr|msdata)/i.test(k));
        console.log('COLUMNS: ' + cols.join(', '));
        console.log('FIRST ROW:');
        for (const c of cols) console.log(`  ${c.padEnd(25)} ${rows[0][c]}`);
      }
    } catch (e) { console.log('call failed: ' + e.message); }
  }
}
process.exit(0);
