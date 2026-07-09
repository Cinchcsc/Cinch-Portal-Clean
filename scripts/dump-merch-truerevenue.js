// Michael (9 Jul 2026): "It is from the True [Period] Revenue... everything that does not include rent
// or store protect / move in." Confirmed True Revenue IS the correct report -- but excluding just those
// 3 categories by ChargeDesc string match overshot badly (£112-338/customer vs legacy's £1.00), because
// the ChargeDesc list also mixes in Delivery Fee, Administrative Adjustment, Insufficient Notice Fee,
// Late Fee, Security Deposit, three Electric Charge lines, and Service Fee -- none of them merchandise.
//
// BREAKTHROUGH (this run): True Revenue's raw rows carry an `AccountCode` field that true_revenue.parse()
// never extracts. Its distinct values for L001/June 2026 were 200 (938 rows), 201 (29 rows), 202 (648
// rows), 4060 (25 rows), 812 (1 row), 4910 (1 row). '200' and '201'/'202' match EXACTLY the account codes
// FinancialSummary's own Charge/POSCharges tables already use for Rent (200) and Merchandise/Boxes/Locks
// (201) — confirmed in this week's earlier dumps. So AccountCode is SiteLink's own GL classification,
// the same clean tagging FinancialSummary uses, just also present (and previously unused) in True
// Revenue. This groups True Revenue by AccountCode instead of guessing ChargeDesc labels, isolates 201
// as the candidate merchandise total, and cross-checks it against FinancialSummary's own POS-category
// total for the same site/period (should be close if both reports are tagging the same underlying data
// the same way).
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
console.log(`=== True Revenue by AccountCode, ${siteCode}, ${fmt(start)} to ${fmt(end)} ===\n`);

const { rows } = await callCustomReport(781861, siteCode, start, end);
const num = (v) => Number(v) || 0;

// Group by AccountCode, summing TruePeriod (same field the existing True Revenue widget/Real Rate use)
// and Amount (the raw line-item charge, for cross-reference) plus a couple of sample ChargeDescs per
// code so it's obvious what each account code actually represents.
const byCode = {};
for (const r of rows) {
  const code = String(r.AccountCode ?? '(blank)');
  const o = (byCode[code] ??= { truePeriod: 0, amount: 0, count: 0, descs: new Set() });
  o.truePeriod += num(r.TruePeriod); o.amount += num(r.Amount); o.count++;
  if (o.descs.size < 6) o.descs.add(r.ChargeDesc);
}
console.log(`${'AccountCode'.padEnd(12)} rows   TruePeriod      Amount        sample ChargeDescs`);
for (const [code, o] of Object.entries(byCode).sort((a, b) => b[1].truePeriod - a[1].truePeriod)) {
  console.log(`${code.padEnd(12)} ${String(o.count).padStart(4)}   £${o.truePeriod.toFixed(2).padStart(10)}   £${o.amount.toFixed(2).padStart(10)}   ${[...o.descs].join(', ')}`);
}

const merchTruePeriod = (byCode['201'] || { truePeriod: 0 }).truePeriod;
const merchAmount = (byCode['201'] || { amount: 0 }).amount;
console.log(`\nAccountCode '201' (candidate merchandise, True Revenue): TruePeriod £${merchTruePeriod.toFixed(2)}, Amount £${merchAmount.toFixed(2)}`);

// Cross-check against FinancialSummary's own POS-category total for the same site/period.
const { rows: finRows } = await callReport('FinancialSummary', siteCode, start, end);
const finParsed = REPORTS.financial.parse(finRows);
const posSum = finParsed.categories.filter((c) => c.category === 'POS').reduce((a, c) => a + c.charge, 0);
console.log(`FinancialSummary POS-category total (today's production numerator): £${posSum.toFixed(2)}`);
console.log(`Difference: £${(merchTruePeriod - posSum).toFixed(2)} (${posSum ? ((merchTruePeriod / posSum - 1) * 100).toFixed(1) : 'n/a'}%)`);

const { rows: mgRows } = await callReport('ManagementSummary', siteCode, start, end);
const mgParsed = REPORTS.management.parse(mgRows, start, end);
const moveIns = mgParsed.move_ins;
console.log(`\nMove-ins this period (ManagementSummary, already validated): ${moveIns}`);
console.log(`\nMerchandise Income per New Customer for ${siteCode}, AccountCode-201-based:`);
console.log(`  TruePeriod ÷ move-ins: £${moveIns ? (merchTruePeriod / moveIns).toFixed(2) : 'n/a'}`);
console.log(`  Amount ÷ move-ins:     £${moveIns ? (merchAmount / moveIns).toFixed(2) : 'n/a'}`);
process.exit(0);
