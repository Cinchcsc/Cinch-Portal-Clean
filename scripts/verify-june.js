// Builds a payload FORCED to June regardless of today's real date, for verifying against the legacy
// portal's June screenshots. Michael's target numbers (Enquiries, Move-ins/Move-outs, occupancy,
// rates, etc.) are all tagged "Jun 2026" — but most of our POINT-IN-TIME fields (occupancy, rent
// roll, rates, Insurance Roll, Debtor Levels, True Revenue) are normally scoped to the in-progress
// CURRENT month (July, as of 3 Jul 2026), not June, because that's the correct behaviour for a live
// portal. Only the FLOW/count fields (Enquiries, Move-ins/Move-outs, Autobill, Insurance Conversion,
// Merchandise) are already June-scoped in production (they borrow the previous complete month).
//
// This script calls buildPayload(juneDate, juneDate) — June as BOTH "current" and "previous" — which
// makes buildPayload.js's prevByCode override a no-op (June overridden with June = itself), so every
// field, point-in-time AND flow, ends up reading June's own stored data. Prints to the console only;
// does NOT touch the production portal_payload row, so your live July view is untouched.
//
// IMPORTANT: only occupancy/management/lead_funnel/move_ins_outs/insurance_activity/merchandise/
// rent_roll get pulled for June automatically by `npm run pull` (the TWO_MONTH set). past_due,
// scheduled_outs, insurance_roll, financial, rate_changes, and true_revenue are NOT — you need to run
//   npm run backfill -- 1
// first (pulls exactly last month = June, for EVERY report) or these fields will show 0/empty here.
// One exception: `reservations` (ReservationList) has NO date-range capability at all (SiteLink
// always returns the LIVE waiting list) — there is no way to retroactively get a "June" reservations
// snapshot, backfill or not. That number below will always be "right now", not June.
//
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/verify-june.js
import { buildPayload } from '../lib/buildPayload.js';

const now = new Date();
const june = new Date(now.getFullYear(), now.getMonth() - 1, 1);   // "last complete month" relative to today — June, as of 3 Jul 2026

const p = await buildPayload(june, june);
const t = p.totals;
const money = (n) => '£' + Math.round(n || 0).toLocaleString('en-GB');
const pct = (n) => (n ?? 0).toFixed(1) + '%';
const rate = (n) => '£' + (n ?? 0).toFixed(2);

console.log(`=== JUNE-FORCED VERIFICATION VIEW === (built from stored month ${p.current_month}, ${p.sites.length} sites)`);
console.log('Everything below reads June-only data (point-in-time AND flow). Compare directly against legacy June screenshots.\n');

console.log('--- Occupancy / Rates ---');
console.log(`Occupancy (% of CLA): ${pct(t.claPC)}   Occupied Units: ${t.occ} of ${t.tot}`);
console.log(`Total Rate: ${rate(t.rate)}   Real Total Rate: ${rate(t.realRate)}`);
console.log(`Self Storage: ${t.ssOcc}/${t.ssTot} (${pct(t.ssOccPC)})  Rate ${rate(t.ssRate)}  Real ${rate(t.ssReal)}`);
console.log(`Offices: ${t.officesOcc}/${t.officesTot} (${pct(t.officesOccPC)})  Rate ${rate(t.officesRate)}`);

const sum = (k) => p.sites.reduce((a, s) => a + (s[k] || 0), 0);
const esum = (k) => p.sites.reduce((a, s) => a + ((s.enquiries && s.enquiries[k]) || 0), 0);
console.log(`\n--- Enquiries (June) ---`);
console.log(`Phone: ${esum('phone')}   Walk-ins: ${esum('walkin')}   Web (Web+Email): ${esum('web')}   Total: ${esum('total')}`);

console.log(`\n--- Move-ins & Move-outs (June) ---`);
console.log(`Move-ins: ${sum('moveIns')}   Move-outs: ${sum('moveOuts')}   Net ft²: ${sum('netArea')}`);

console.log('\n--- Debtor Levels ---');
console.log(`Tenant %: ${pct(t.debtorTenantPct)}   Rent Roll %: ${pct(t.debtorRentRollPct)}   Total overdue (30+ days): ${money(t.debtorTotal)}`);
if (!t.debtorTotal) console.log('  (0/blank likely means past_due wasn\'t pulled for June yet — run `npm run backfill -- 1`)');

console.log('\n--- Autobill Conversion ---');
console.log(`${pct(t.autobillPC)}  (new autobilled ÷ new customers, June)`);

console.log('\n--- Reservations vs Move-outs ---');
console.log(`Active Reservations: ${t.reservationsActive}  (CAVEAT: always "live right now", NOT a true June snapshot — ReservationList has no date-range param)`);
console.log(`Scheduled Move-outs: ${t.scheduledOuts}   Net: ${t.reservationsNet}`);
if (!t.scheduledOuts) console.log('  (0 likely means scheduled_outs wasn\'t pulled for June yet — run `npm run backfill -- 1`)');

console.log('\n--- Insurance Roll ---');
console.log(`Premiums: ${money(t.insurancePremium)}   % Rent Roll: ${pct(t.insurancePctRoll)}   % Insured: ${pct(t.insurancePctInsured)}`);
if (!t.insurancePremium) console.log('  (0 likely means insurance_roll wasn\'t pulled for June yet — run `npm run backfill -- 1`)');

// Insurance Conversion / Merchandise — computed client-side in page.js, replicated here from p.sites.
const newPoliciesSum = p.sites.reduce((a, s) => a + ((s.insuranceActivity && s.insuranceActivity.newPolicies) || 0), 0);
const moveInsSum = sum('moveIns');
const merchSalesSum = p.sites.reduce((a, s) => a + ((s.merchandise && s.merchandise.sales) || 0), 0);
console.log('\n--- Insurance Conversion / Merchandise (June) ---');
console.log(`Insurance Conversion: ${moveInsSum ? (newPoliciesSum / moveInsSum * 100).toFixed(0) : 0}%  (new policies ${newPoliciesSum} ÷ move-ins ${moveInsSum})`);
console.log(`Merchandise Sales: ${money(merchSalesSum)}   Income per move-in: £${moveInsSum ? (merchSalesSum / moveInsSum).toFixed(2) : '0.00'}`);

console.log('\n--- Units by Customer Type ---');
console.log(`Business: ${t.customerType.business.units} units (${pct(t.customerType.business.pct)}) @ ${rate(t.customerType.business.rate)}`);
console.log(`Residential: ${t.customerType.residential.units} units (${pct(t.customerType.residential.pct)}) @ ${rate(t.customerType.residential.rate)}`);

console.log('\n--- Financials ---');
const avgCustValue = t.occ ? Math.round((t.rent / t.occ) * 100) / 100 : 0;
console.log(`Rent Roll: ${money(t.rent)}   Avg customer value: ${money(avgCustValue)}`);
const trueRevTotal = (t.trueRevenueByDesc || []).reduce((a, r) => a + (r.truePeriod || 0), 0);
console.log(`True Revenue (True Period total): ${money(trueRevTotal)}${trueRevTotal ? '' : '  (0 likely means true_revenue wasn\'t pulled for June yet — run `npm run backfill -- 1`)'}`);

process.exit(0);
