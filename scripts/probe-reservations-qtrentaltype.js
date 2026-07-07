// New hypothesis for the still-unresolved Reservations vs Move-outs overcount (currently ~1,420
// portfolio-wide vs a ~446 target, even after the two confirmed fixes in lib/reportMap.js's
// `reservations` parser). ReservationList rows carry a QTRentalTypeID column — the SAME column name
// that, on InquiryTracking, turned out to be a FUNNEL-STAGE marker (Inquiry/Reservation/MoveIn) and
// not a product type, and filtering on it (sRentalType==='Inquiry') was the single biggest fix for
// the Enquiries overcount. This checks whether QTRentalTypeID on ReservationList is doing something
// similar — e.g. distinguishing a genuine "Reservation" from a generic "Waiting List" entry (SiteLink
// models these as related-but-different things; this endpoint is even named ReservationList but the
// parser already calls the raw count `total_waiting_list`, which is a hint we may be counting the
// wrong list). Also dumps every column on a raw row so we can spot any OTHER unused status/type/label
// field, and checks for a unit-type-like column to test a "Self Storage only" scoping hypothesis
// (the same pattern used elsewhere in this codebase for Rate/Occupancy).
// PII-SAFE: only prints column names, type/status codes, and counts — no tenant name/contact fields.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-reservations-qtrentaltype.js
import { callReservationList, callReport } from '../lib/sitelink.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const prevEnd = new Date(now.getFullYear(), now.getMonth(), 0);

const isBlank = (v) => v === undefined || v === null || v === '' || v === '0001-01-01T00:00:00';
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));

let dumpedColumns = false;
let totalRaw = 0;
const typeAllCounts = {};        // QTRentalTypeID distribution across ALL rows (any status)
const typeActiveCounts = {};     // QTRentalTypeID distribution among rows passing the CURRENT active filter
let activeTotal = 0, activeMinusMovedIn = 0;
const byTypeAfterAllExclusions = {}; // active AND not-already-a-tenant, broken down by QTRentalTypeID

for (const loc of locations) {
  process.stderr.write(`[qtrentaltype] ${loc}...\n`);
  try {
    const { rows } = await callReservationList(loc);
    totalRaw += rows.length;

    if (!dumpedColumns && rows.length) {
      dumpedColumns = true;
      const cols = Object.keys(rows[0]).filter(c => !/^(diffgr|msdata)/i.test(c));
      console.log('ALL COLUMNS on a ReservationList row:', cols.join(', '), '\n');
      const typeLike = cols.filter(c => /type|unit|status/i.test(c));
      console.log('Candidate type/unit/status-like columns:', typeLike.join(', '), '\n');
    }

    for (const r of rows) {
      const k = String(r.QTRentalTypeID);
      typeAllCounts[k] = (typeAllCounts[k] || 0) + 1;
    }

    // Current production "active" filter (reportMap.js's `reservations` parser, minus the
    // TenantID/occupied cross-reference which needs a second RentRoll call below).
    const active = rows.filter(r => {
      if (!isBlank(r.dCancelled)) return false;
      const needed = isBlank(r.dNeeded) ? null : new Date(r.dNeeded);
      if (!(needed && needed > now)) return false;
      if (!isBlank(r.QTCancellationTypeID) && Number(r.QTCancellationTypeID) !== 0) return false;
      return true;
    });
    activeTotal += active.length;
    for (const r of active) { const k = String(r.QTRentalTypeID); typeActiveCounts[k] = (typeActiveCounts[k] || 0) + 1; }

    // Cross-reference against occupied RentRoll tenants (last complete month), same as production.
    const { rows: rrRows } = await callReport('RentRoll', loc, prevStart, prevEnd);
    const occupiedIds = new Set(rrRows.filter(r => yes(r.bRented)).map(r => String(r.TenantID)));
    const activeNotMovedIn = active.filter(r => !occupiedIds.has(String(r.TenantID)));
    activeMinusMovedIn += activeNotMovedIn.length;
    for (const r of activeNotMovedIn) { const k = String(r.QTRentalTypeID); byTypeAfterAllExclusions[k] = (byTypeAfterAllExclusions[k] || 0) + 1; }
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

console.log('\n=== QTRentalTypeID distribution — ALL rows (any status, any date), portfolio-wide ===');
console.log(`total rows: ${totalRaw}`);
console.log(JSON.stringify(typeAllCounts, null, 2));

console.log('\n=== QTRentalTypeID distribution — rows passing the CURRENT "active" filter (not cancelled, future dNeeded, cancel-type not set) ===');
console.log(`total: ${activeTotal}`);
console.log(JSON.stringify(typeActiveCounts, null, 2));

console.log('\n=== QTRentalTypeID distribution — active AND not already an occupied RentRoll tenant (= current production formula) ===');
console.log(`total: ${activeMinusMovedIn}   Target: ~446`);
console.log(JSON.stringify(byTypeAfterAllExclusions, null, 2));

console.log('\nIf one QTRentalTypeID value is clearly dominant here and isolating it alone gets close to 446, that value is');
console.log('likely the real "Reservation" type (vs. generic Waiting List / other type codes lumped into ReservationList).');
process.exit(0);
