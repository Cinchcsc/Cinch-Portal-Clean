// Michael: portal shows Autobill Conversion 100.0% for Bicester (Jun 2026), legacy shows 87%.
// Formula (buildPayload.js, confirmed via legacy tooltip 2 Jul): autobillNewCount / autobillNewTotal
// = (June move-in TenantIDs that are ALSO in RentRoll's autobill_tenant_ids) / (all June move-in
// TenantIDs). Two live hypotheses before assuming a real bug:
//  (a) Small sample: if Bicester only had a handful of June move-ins, one tenant either way swings
//      the % by double digits -- 100% could just mean "all N move-ins happen to be on autobill",
//      not a bug.
//  (b) RentRoll staleness: RentRoll is a LIVE point-in-time snapshot (confirmed elsewhere in this
//      codebase -- "every pull silently re-captures TODAY's live state", not a true historical
//      report). autobill_tenant_ids reflects TODAY's (9 Jul) enrollment, not June's. A tenant who
//      moved in during June WITHOUT autobill, then enrolled sometime in July (between June's close
//      and today), would incorrectly count as "on autobill" for June's cohort -- inflating the ratio
//      for any CLOSED month, not just Bicester. This would systematically overstate Autobill
//      Conversion for every past month, in the same direction as this discrepancy (ours 100% >
//      legacy's 87%).
// Prints the raw counts (never tenant names) so we can tell which explanation actually fits.
// Run: cd cinch-portal-clean && node --env-file=.env scripts/probe-autobill-bicester.js [siteCode] [YYYY-MM]
import { callReport } from '../lib/sitelink.js';

const siteCode = process.argv[2] || 'L001';
const monthArg = process.argv[3] || '2026-06';
const [y, m] = monthArg.split('-').map(Number);
const start = new Date(y, m - 1, 1);
const end = new Date(y, m, 0); // last day of that month
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const num = (v) => Number(v) || 0;

console.log(`=== Autobill Conversion diagnostic, ${siteCode}, ${monthArg} ===\n`);

const { rows: mgRows } = await callReport('MoveInsAndMoveOuts', siteCode, start, end);
const moveInIds = mgRows.filter((r) => yes(r.MoveIn) && r.TenantID != null).map((r) => String(r.TenantID));
console.log(`Move-ins this month: ${moveInIds.length}`);

const { rows: rrRows } = await callReport('RentRoll', siteCode, start, end); // live snapshot regardless of dates passed
const autobillIds = new Set();
let rented = 0;
for (const r of rrRows) {
  if (!yes(r.bRented)) continue;
  rented++;
  if ([1, 2].includes(num(r.iAutoBillType))) autobillIds.add(String(r.TenantID));
}
console.log(`RentRoll TODAY: ${rented} occupied units, ${autobillIds.size} on autobill.\n`);

let matched = 0, notFound = 0;
for (const id of moveInIds) {
  if (autobillIds.has(id)) matched++;
  else notFound++;
}
console.log(`Of ${moveInIds.length} June move-in tenant(s): ${matched} currently on autobill (TODAY), ${notFound} not currently on autobill.`);
console.log(`Autobill Conversion (as computed by the portal) = ${matched}/${moveInIds.length} = ${moveInIds.length ? (matched / moveInIds.length * 100).toFixed(1) : 'n/a'}%`);
console.log(`\nIf this count is small (say <10), a one-tenant difference swings the % by double digits --`);
console.log(`worth weighing against legacy's 87% with that in mind before assuming a bug.`);
process.exit(0);
