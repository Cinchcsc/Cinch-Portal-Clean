// Michael (9 Jul 2026): "It is from the True [Period] Revenue... everything that does not include rent
// or store protect / move in." Confirmed 9 Jul: True Revenue IS the correct report -- but the first
// pass (excluding just those 3 categories by ChargeDesc string match) overshot badly (£112-338/customer
// vs legacy's £1.00), because True Revenue's ChargeDesc list also mixes in plenty of non-merchandise
// items -- Delivery Fee, Administrative Adjustment, Insufficient Notice Fee, Late Fee, Security Deposit,
// three separate Electric Charge lines, Service Fee -- that a 3-category exclusion list doesn't catch.
// Manually maintaining an ever-longer ChargeDesc exclusion list is exactly the kind of fragile, guessable
// thing that's bitten this investigation before (see git log). Better bet: FinancialSummary's own
// Charge/POSCharges tables carry a clean, SiteLink-provided `sChgCategory`/`sAcctCode` classification
// (confirmed 'POS' category, account code 201, in earlier runs this week) -- if True Revenue's raw rows
// ALSO carry an account-code-like field (not currently extracted by true_revenue.parse(), which only
// pulls ChargeDesc/UnitType + the 8 revenue columns), that would let us classify merchandise the same
// reliable way, instead of guessing labels. This now dumps the FULL raw column set for a sample row
// first, then still prints the ChargeDesc breakdown with three exclusion variants for comparison: broad
// (rent/protect/move-in), narrow (exact "Rent" only), and "fees-and-deposits-too" (also excludes the
// specific non-merchandise lines identified in the first run).
// Run: cd cinch-portal-clean && node --env-file=.env scripts/dump-merch-truerevenue.js [siteCode] [YYYY-MM]
import { callCustomReport, callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const siteCode = process.argv[2] || 'L001';
const monthArg = process.argv[3]; // optional YYYY-MM; defaults to current month-to-date
const now = new Date();
let start, end;
if (monthArg) {
  const [y, m] = monthArg.split('-').map(Number);
  start = new Date(y, m - 1, 1);
  const fullMonthEnd = new Date(y, m, 0);
  const isCurrentMonth = y === now.getFullYear() && m === now.getMonth() + 1;
  end = isCurrentMonth && fullMonthEnd > now ? now : fullMonthEnd;
} else {
  start = new Date(now.getFullYear(), now.getMonth(), 1);
  end = now;
}
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
console.log(`=== True Revenue raw columns + ChargeDesc breakdown, ${siteCode}, ${fmt(start)} to ${fmt(end)} ===\n`);

const { rows } = await callCustomReport(781861, siteCode, start, end);

// NEW: full raw column dump for a few sample rows — looking specifically for anything account-code- or
// category-like (e.g. sAcctCode, sDefAcctCode, sChgCategory, GLCode...) that true_revenue.parse()
// currently ignores. If SiteLink tags merchandise rows here the same way it does in FinancialSummary,
// this is the clean fix; if not, we're stuck refining the ChargeDesc exclusion list by hand.
console.log(`ALL raw columns on row 0 (${rows.length} total rows):`, rows[0] ? Object.keys(rows[0]) : '(none)');
console.log('Row 0 full contents:', rows[0] || '(none)');
const candidateCols = rows[0] ? Object.keys(rows[0]).filter((k) => /acct|category|code|gl|class|type/i.test(k)) : [];
console.log(`\nColumns that LOOK category/account-code-like: ${candidateCols.length ? candidateCols.join(', ') : '(none found)'}`);
if (candidateCols.length) {
  console.log('Distinct values for each, with counts:');
  for (const col of candidateCols) {
    const counts = {};
    for (const r of rows) { const v = String(r[col]); counts[v] = (counts[v] || 0) + 1; }
    console.log(`  ${col}: ${JSON.stringify(counts)}`);
  }
}

const parsed = REPORTS.true_revenue.parse(rows);
const NON_MERCH_EXTRA = /delivery fee|adjustment|notice fee|late fee|deposit|electric|service fee/i;

let totalAll = 0, broadSum = 0, narrowSum = 0, feesTooSum = 0;
console.log(`\n${'ChargeDesc'.padEnd(28)} truePeriod    broad  narrow  +fees/deposits`);
for (const r of parsed.by_desc.sort((a, b) => b.truePeriod - a.truePeriod)) {
  totalAll += r.truePeriod;
  const isBroadExcluded = /rent|protect|move.?in/i.test(r.desc);
  const isNarrowExcluded = /^rent$/i.test(r.desc.trim());
  const isFeesTooExcluded = isBroadExcluded || NON_MERCH_EXTRA.test(r.desc);
  if (!isBroadExcluded) broadSum += r.truePeriod;
  if (!isNarrowExcluded) narrowSum += r.truePeriod;
  if (!isFeesTooExcluded) feesTooSum += r.truePeriod;
  console.log(`${r.desc.padEnd(28)} £${r.truePeriod.toFixed(2).padStart(10)}   ${isBroadExcluded ? 'EXCL' : ' -  '}   ${isNarrowExcluded ? 'EXCL' : ' -  '}    ${isFeesTooExcluded ? 'EXCL' : ' -  '}`);
}
console.log(`\nTotal True Period, all ${parsed.by_desc.length} ChargeDesc rows: £${totalAll.toFixed(2)}`);
console.log(`Broad (rent/protect/move-in only):         £${broadSum.toFixed(2)}`);
console.log(`Narrow (exact 'Rent' only):                 £${narrowSum.toFixed(2)}`);
console.log(`+ fees/deposits/utility excluded too:       £${feesTooSum.toFixed(2)}`);

const { rows: mgRows } = await callReport('ManagementSummary', siteCode, start, end);
const mgParsed = REPORTS.management.parse(mgRows, start, end);
const moveIns = mgParsed.move_ins;
console.log(`\nMove-ins this period (ManagementSummary, already validated): ${moveIns}`);
console.log(`\nMerchandise Income per New Customer for ${siteCode}:`);
console.log(`  broad ÷ move-ins:              £${moveIns ? (broadSum / moveIns).toFixed(2) : 'n/a'}`);
console.log(`  narrow ÷ move-ins:             £${moveIns ? (narrowSum / moveIns).toFixed(2) : 'n/a'}`);
console.log(`  + fees/deposits too ÷ move-ins: £${moveIns ? (feesTooSum / moveIns).toFixed(2) : 'n/a'}`);
process.exit(0);
