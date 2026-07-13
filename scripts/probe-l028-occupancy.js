// Immediate follow-up to probe-l028-zeros.js: that script ruled out a pull/coverage gap (L028 has
// raw_report rows for nearly every report type, matching L029; live RentRoll right now returns 16
// rows, exactly matching stored tot:16). So occ:0/rate:0 isn't missing data -- either Edmonton
// genuinely has zero occupied units right now (a brand-new site still in lease-up -- consistent with
// enquiries:24/reservationConversions:8/conversions:0 already seen: leads and reservations flowing in,
// nobody's moved in yet), or something SiteLink-side marks these 16 units in a way our bRented check
// doesn't recognize as occupied. This prints every unit's raw rented-flag + tenant fields live, right
// now, so we can tell which one it is by looking, not guessing.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-l028-occupancy.js
import { callReport } from '../lib/sitelink.js';

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const { rows } = await callReport('RentRoll', 'L028', start, now);
console.log(`L028 (Edmonton) — ${rows.length} live RentRoll rows right now:\n`);
for (const r of rows) {
  console.log(`  unit=${r.sUnit ?? r.UnitID}  type=${r.sTypeName}  area=${r.Area ?? r.Area1}  bRented=${r.bRented}  dcStdRate=${r.dcStdRate}  tenant=${r.sName || '(none)'}  moveIn=${r.dMovedIn || '(none)'}  status=${r.sStatus ?? r.Status ?? '(no status field)'}`);
}
const rented = rows.filter((r) => r.bRented === true || r.bRented === 'true' || r.bRented === 1 || r.bRented === '1');
console.log(`\nbRented truthy count: ${rented.length} of ${rows.length}`);
process.exit(0);
