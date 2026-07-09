// Michael (9 Jul 2026): "It is from the True [Period] Revenue. It is everything that does not include
// rent or store protect / move in [fee]." Legacy's Merchandise Income numerator for THIS widget is not
// FinancialSummary's POS category at all (the tooltip confirmed 6 Jul was for the standalone
// "Merchandise Sales" stat card, a different widget) -- it's True Revenue's truePeriod, summed across
// every ChargeDesc EXCEPT Rent, Store Protect, and Move-In. This is the SAME True Revenue custom report
// (781861) already fully wired up and validated for the Financials page's True Revenue table -- no new
// report needed, just a different exclusion filter over data we already trust.
// Prints every ChargeDesc + truePeriod so the exact SiteLink labels are visible (not guessed), then
// computes the candidate merchandise income two ways -- broad exclusion (anything matching
// /rent|protect|move.?in/i) and narrow (only an EXACT "Rent" match, in case "Rent Refund
// Dismissed"-style rows should stay IN) -- against the same already-validated ManagementSummary
// move-ins denominator, for direct comparison against legacy's £1.00.
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
console.log(`=== True Revenue by ChargeDesc, ${siteCode}, ${fmt(start)} to ${fmt(end)} ===\n`);

const { rows } = await callCustomReport(781861, siteCode, start, end);
const parsed = REPORTS.true_revenue.parse(rows);

let totalAll = 0, broadSum = 0, narrowSum = 0;
console.log(`${'ChargeDesc'.padEnd(28)} truePeriod    broad-excl?  narrow-excl?`);
for (const r of parsed.by_desc.sort((a, b) => b.truePeriod - a.truePeriod)) {
  totalAll += r.truePeriod;
  const isBroadExcluded = /rent|protect|move.?in/i.test(r.desc);
  const isNarrowExcluded = /^rent$/i.test(r.desc.trim());
  if (!isBroadExcluded) broadSum += r.truePeriod;
  if (!isNarrowExcluded) narrowSum += r.truePeriod;
  console.log(`${r.desc.padEnd(28)} £${r.truePeriod.toFixed(2).padStart(10)}   ${isBroadExcluded ? 'EXCLUDED' : '   -    '}     ${isNarrowExcluded ? 'EXCLUDED' : '   -    '}`);
}
console.log(`\nTotal True Period, all ${parsed.by_desc.length} ChargeDesc rows: £${totalAll.toFixed(2)}`);
console.log(`Broad exclusion (anything matching rent/protect/move-in):  £${broadSum.toFixed(2)}`);
console.log(`Narrow exclusion (only an exact 'Rent' row excluded):      £${narrowSum.toFixed(2)}`);

const { rows: mgRows } = await callReport('ManagementSummary', siteCode, start, end);
const mgParsed = REPORTS.management.parse(mgRows, start, end);
const moveIns = mgParsed.move_ins;
console.log(`\nMove-ins this period (ManagementSummary, already validated): ${moveIns}`);
console.log(`\nMerchandise Income per New Customer for ${siteCode}:`);
console.log(`  broad exclusion ÷ move-ins:  £${moveIns ? (broadSum / moveIns).toFixed(2) : 'n/a'}`);
console.log(`  narrow exclusion ÷ move-ins: £${moveIns ? (narrowSum / moveIns).toFixed(2) : 'n/a'}`);
process.exit(0);
