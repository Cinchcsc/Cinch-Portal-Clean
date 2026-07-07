// Verifies the True Revenue month-scoping fix (3 Jul 2026: added true_revenue to lib/pull.js's
// TWO_MONTH set + buildPayload.js override) WITHOUT needing a full `npm run pull` or touching
// production data. Calls the live custom report (781861) directly for JUNE across every site,
// groups by ChargeDesc the same way lib/reportMap.js does, and prints the portfolio-wide "Rent"
// row + grand total against Michael's legacy June screenshot (Rent: Invoiced £1,305,210.77, True
// Period £1,139,027.66).
// PII-SAFE: aggregated £ totals only.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-true-revenue-june-portfolio.js
import { callCustomReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const juneStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const juneEnd = new Date(now.getFullYear(), now.getMonth(), 0);
console.log(`${locations.length} sites · June window ${juneStart.toDateString()} -> ${juneEnd.toDateString()}\n`);

const g = {}; // desc -> summed fields
let sitesOk = 0, sitesFail = 0;
for (const loc of locations) {
  process.stderr.write(`[true-rev-june] ${loc}...\n`);
  try {
    const { rows } = await callCustomReport(781861, loc, juneStart, juneEnd);
    const { by_desc } = REPORTS.true_revenue.parse(rows);
    for (const r of by_desc) {
      const o = (g[r.desc] ??= { invoiced: 0, taxInvoiced: 0, taxAdj: 0, netTax: 0, deferred: 0, deferredPrev: 0, adj: 0, adjPrev: 0, truePeriod: 0 });
      for (const k of Object.keys(o)) o[k] += r[k] || 0;
    }
    sitesOk++;
  } catch (e) { sitesFail++; console.log(`  ${loc}: error: ${e.message}`); }
}

console.log(`\n${sitesOk} sites ok, ${sitesFail} failed\n`);
const rent = g['Rent'];
if (rent) {
  console.log('Portfolio "Rent" row (June, all sites summed):');
  console.log(`  Invoiced:    £${rent.invoiced.toFixed(2)}   (legacy: £1,305,210.77)`);
  console.log(`  True Period: £${rent.truePeriod.toFixed(2)}   (legacy: £1,139,027.66)`);
} else {
  console.log('No "Rent" ChargeDesc row found — check raw desc labels.');
}

const grandTotal = Object.values(g).reduce((a, o) => a + o.truePeriod, 0);
console.log(`\nGrand total True Period, ALL charge types, all sites (June): £${grandTotal.toFixed(2)}`);
console.log(`\nAll ChargeDesc rows found (${Object.keys(g).length}):`, Object.keys(g).join(', '));
process.exit(0);
