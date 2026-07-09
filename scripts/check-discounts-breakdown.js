// Follow-up to check-discounts-method.js: that showed 10 raw rows, all the same catch-all plan.
// This groups the FULL result by sConcessionPlan (cross-check against the manual DiscountSummary
// export's per-plan counts: L001 Jul had 10% OFF 12 Months=2, 50% OFF 12 Weeks=6, 50% OFF 8 Weeks=2,
// Variances from Standard Rate: Non-Expiring=35) and separately previews filtering by dMovedIn
// within the requested month, to see what a "just this period's move-ins" variance calc would yield.
// Run: node --env-file=.env scripts/check-discounts-breakdown.js [siteCode] [YYYY-MM]
import { callReport } from '../lib/sitelink.js';
const siteCode = process.argv[2] || 'L001';
const monthArg = process.argv[3];
const now = new Date();
let start, end, y, m;
if (monthArg) { [y, m] = monthArg.split('-').map(Number); start = new Date(y, m - 1, 1); end = new Date(y, m, 0); }
else { y = now.getFullYear(); m = now.getMonth() + 1; start = new Date(y, m - 1, 1); end = now; }
const { rows } = await callReport('Discounts', siteCode, start, end);
console.log(`${rows.length} total rows for ${siteCode}, charge-period ${start.toISOString().slice(0,10)}..${end.toISOString().slice(0,10)}\n`);

console.log('=== Grouped by sConcessionPlan (unique units + $ discount sum) ===');
const byPlan = {};
for (const r of rows) {
  const plan = r.sConcessionPlan || '(none)';
  (byPlan[plan] ??= { units: new Set(), discountSum: 0 });
  byPlan[plan].units.add(r.sUnitName);
  byPlan[plan].discountSum += Number(r.dcDiscount) || 0;
}
for (const [plan, v] of Object.entries(byPlan)) {
  console.log(`  ${plan}: ${v.units.size} units, £${v.discountSum.toFixed(2)} total discount`);
}

console.log(`\n=== Rows where dMovedIn falls within ${y}-${String(m).padStart(2,'0')} (move-ins THIS period) ===`);
const monthStart = new Date(y, m - 1, 1), monthEnd = new Date(y, m, 0, 23, 59, 59);
const thisMonth = rows.filter(r => {
  if (!r.dMovedIn) return false;
  const d = new Date(r.dMovedIn);
  return d >= monthStart && d <= monthEnd;
});
console.log(`${thisMonth.length} rows. Sample:`);
for (const r of thisMonth.slice(0, 8)) {
  console.log(`  unit=${r.sUnitName} movedIn=${String(r.dMovedIn).slice(0,10)} stdRateAtMoveIn=${r.dcStdRateAtMoveIn} variance=${r.dcVariance} plan=${r.sConcessionPlan}`);
}
if (thisMonth.length) {
  const avgVar = thisMonth.reduce((a, r) => a + (Number(r.dcVariance) || 0), 0) / thisMonth.length;
  console.log(`  avg variance across these: ${avgVar.toFixed(2)}`);
}
process.exit(0);
