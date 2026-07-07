// repull-rentroll-flagged.js re-pulled L008 (Enfield) for Aug 2025 and got back exactly 1 unit_type
// again — even though probe-enfield-rentroll-live.js's DIRECT callReport('RentRoll', ...) call for the
// exact same site+period, run moments earlier, returned 108 raw rows across 3 sTypeName values
// (Office 13, Self Storage 93, Enterprise 2). BUT that probe counted ALL rows regardless of occupancy
// — and reportMap.js's rent_roll parser only includes a unit_type in its output if at least one row of
// that type has `bRented` true (spec: "Only occupied units count"). So before assuming a bug, this
// checks whether the 93 "Self Storage" rows are mostly VACANT (in which case 0 self-storage rent/area
// for Aug 2025 would be CORRECT, matching spec) vs whether a meaningful number are actually rented
// (in which case the parser or the pull is genuinely dropping real occupied data).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/debug-enfield-pullreport.js
import { callReport } from '../lib/sitelink.js';
import { pullReport } from '../lib/reportMap.js';

const start = new Date(2025, 7, 1);
const end = new Date(2025, 7, 31);

console.log('--- Raw callReport, broken down by sTypeName + bRented ---');
const { rows } = await callReport('RentRoll', 'L008', start, end);
const byType = {};
for (const r of rows) {
  const t = r.sTypeName || '(blank)';
  const o = (byType[t] ??= { total: 0, rented: 0 });
  o.total++;
  if (r.bRented === true || r.bRented === 'true' || r.bRented === 1 || r.bRented === '1') o.rented++;
}
for (const [t, o] of Object.entries(byType)) console.log(`  ${t}: ${o.total} total, ${o.rented} rented (bRented truthy)`);

console.log('\n--- pullReport() (goes through reportMap.js parse()) ---');
const { data, rowcount } = await pullReport('rent_roll', 'L008', start, end);
console.log(`rowcount fed into parse(): ${rowcount}`);
console.log(`parsed unit_types: ${JSON.stringify(data.unit_types)}`);
console.log(`tenants (occupied count parse() found): ${data.tenants}, area_sum: ${data.area_sum}, rent_sum: ${data.rent_sum}`);

// Also dump a couple of raw "Self Storage" rows verbatim so we can see the ACTUAL bRented value/type
// (in case it's not a plain boolean — e.g. "Y"/"N" or 1/0 as a different type than expected).
console.log('\n--- Sample raw Self Storage rows (first 3), full bRented value + type ---');
const ssRows = rows.filter((r) => r.sTypeName === 'Self Storage').slice(0, 3);
for (const r of ssRows) console.log(JSON.stringify({ bRented: r.bRented, bRentedType: typeof r.bRented, TenantID: r.TenantID, Area: r.Area ?? r.Area1 }));
process.exit(0);
