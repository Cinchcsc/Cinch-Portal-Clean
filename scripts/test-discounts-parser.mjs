// Pure unit test for reportMap.js's new `discounts` parser — no SiteLink/DB calls, just feeds
// synthetic rows built from EXACT real field names/values captured via live probes (9-10 Jul 2026)
// and asserts the grouping/dedup logic behaves as designed. Covers: a normal single-billing unit,
// the CONFIRMED real duplicate-billing-cycle case (a unit on a ~28-day cycle can generate 2 charge
// rows inside one calendar month — same unit, same plan, same variance, different ChargeID — must
// count once as a customer/move-in, but sum both rows' £ discount), a non-Rent charge line (must be
// excluded from move-in variance but included in the plan grouping), and a move-in outside the query
// window (must be excluded entirely from the move-in variance calc).
// Run: node scripts/test-discounts-parser.mjs (no .env needed — pure function, no live calls)
import { REPORTS } from '../lib/reportMap.js';

const rows = [
  { ChargeID: '1', sUnitName: 'S060', sChgDesc: 'Rent', sConcessionPlan: 'Variances from Standard Rate: Non-Expiring', dcDiscount: '9.00', dMovedIn: '2026-07-03T00:00:00', dcVariance: '9.0000' },
  { ChargeID: '2', sUnitName: 'G019', sChgDesc: 'Rent', sConcessionPlan: '50% OFF 12 Weeks', dcDiscount: '14.29', dMovedIn: '2026-07-04T00:00:00', dcVariance: '11.6800' },
  { ChargeID: '3', sUnitName: 'G019', sChgDesc: 'Rent', sConcessionPlan: '50% OFF 12 Weeks', dcDiscount: '66.66', dMovedIn: '2026-07-04T00:00:00', dcVariance: '11.6800' },
  { ChargeID: '4', sUnitName: 'OFF3', sChgDesc: 'Service Fee', sConcessionPlan: 'Variances from Standard Rate: Non-Expiring', dcDiscount: '1299.36', dMovedIn: '2020-06-24T00:00:00', dcVariance: '-108.9750' },
  { ChargeID: '5', sUnitName: 'X999', sChgDesc: 'Rent', sConcessionPlan: '10% OFF 12 Months.', dcDiscount: '5.00', dMovedIn: '2026-05-01T00:00:00', dcVariance: '3.0000' },  // move-in outside window
];
const start = new Date(2026, 6, 1), end = new Date(2026, 6, 31, 23, 59, 59);
const out = REPORTS.discounts.parse(rows, start, end);
console.log(JSON.stringify(out, null, 2));

let failed = false;
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); failed = true; } else console.log('PASS: ' + msg); };
const plan = (name) => out.discount_plans.find((p) => p.plan === name);
assert(plan('Variances from Standard Rate: Non-Expiring').units === 2, 'variance plan has 2 unique units (S060, OFF3)');
assert(plan('50% OFF 12 Weeks').units === 1, 'G019 counted ONCE despite 2 rows (dedup by unit)');
assert(Math.abs(plan('50% OFF 12 Weeks').discount - 80.95) < 0.01, '£ discount SUMS both G019 rows (14.29+66.66=80.95), not deduped');
assert(out.move_in_variance_count === 2, 'move-in variance count = 2 (S060 + G019 deduped; OFF3 excluded as Service Fee, X999 excluded as outside window)');
assert(Math.abs(out.move_in_variance_sum - 20.68) < 0.01, 'move-in variance sum = 9.00+11.68=20.68 (G019 counted once, not twice)');
process.exit(failed ? 1 : 0);
