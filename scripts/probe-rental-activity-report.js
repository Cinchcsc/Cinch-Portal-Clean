// Checks whether the "Rental Activity" report Michael uploaded (Grp_RentalActivity_*.xlsx — one row
// per UnitType×UnitSize per site, with Occupied/Vacant/MovedIn/MovedOut/NetTransferred/Transfers/Net/
// GrossPotential/StandardRate/dLastChange) is reachable LIVE for all 27 sites, before building a new
// portal page around it. Two possibilities:
//   (a) It's a distinct SOAP method (e.g. "RentalActivity" or "GroupRentalActivity") we've never
//       called before — check the full WSDL method list for a match.
//   (b) It's the SAME UNDERLYING DATA as OccupancyStatistics (which we already pull for every site —
//       confirmed one row per UnitType×UnitSize already, see lib/reportMap.js's occupancy parser
//       comment) — just exported through SiteLink's UI with extra movement columns
//       (MovedIn/MovedOut/Transfers/Net/dLastChange) that our OccupancyStatistics column list doesn't
//       currently show. Checks the ACTUAL live column list on OccupancyStatistics to see if those
//       movement fields are already there and we're just not parsing them.
// PII-SAFE: prints method/column names and one anonymised sample row (unit-level stats only, no
// tenant name/contact info — this report is unit-level, not tenant-level, by nature).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-rental-activity-report.js
import { listMethods, callReport } from '../lib/sitelink.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);

const methods = await listMethods();
console.log(`${methods.length} total SOAP methods.\n`);
const candidates = methods.filter(m => /rental.?activity/i.test(m));
console.log('Methods matching /rental.?activity/i:', candidates.length ? candidates.join(', ') : '(none found)');

if (candidates.length) {
  for (const method of candidates) {
    console.log(`\n=== Trying ${method} ===`);
    try {
      const { rows } = await callReport(method, loc, start, end);
      console.log(`  rows: ${rows.length}`);
      if (rows.length) console.log('  COLUMNS:', Object.keys(rows[0]).filter(c => !/^(diffgr|msdata)/i.test(c)).join(', '));
    } catch (e) { console.log('  error:', e.message); }
  }
}

console.log('\n=== OccupancyStatistics — full live column list (already pulled for every site) ===');
try {
  const { rows } = await callReport('OccupancyStatistics', loc, start, end);
  if (rows.length) {
    const cols = Object.keys(rows[0]).filter(c => !/^(diffgr|msdata)/i.test(c));
    console.log(' ', cols.join(', '));
    const movementCols = cols.filter(c => /moved|transfer|^net$|vacant|laschang|lastchang/i.test(c));
    console.log(`\n  Movement/vacancy-like columns already present: ${movementCols.length ? movementCols.join(', ') : '(none found)'}`);
    if (movementCols.length) {
      console.log('  Sample row (first occupied-type row):', JSON.stringify(Object.fromEntries(movementCols.map(c => [c, rows[0][c]]))));
    }
  }
} catch (e) { console.log('  error:', e.message); }

process.exit(0);
