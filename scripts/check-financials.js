// Sanity-checks the Financials page for June and July after today's True Revenue merge changes
// (Self Storage + Indoor Self Storage combined; merchandise SKUs combined into one "Merchandise"
// row — lib/buildPayload.js's recordFor()). The key internal-consistency check: summing
// trueRevenueByDesc[].truePeriod and summing trueRevenueByType[].truePeriod should give the EXACT
// SAME grand total, since both are just the same underlying report rows grouped two different ways
// — if they don't match, the merge logic is double-counting or dropping rows somewhere.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-financials.js
import { buildPayloadRange, listStoredMonths } from '../lib/buildPayload.js';

const months = await listStoredMonths();
for (const mk of months) {
  const [y, m] = mk.split('-').map(Number);
  const p = await buildPayloadRange(new Date(y, m - 1, 1), new Date(y, m - 1, 1));
  const t = p.totals;
  const descTotal = (t.trueRevenueByDesc || []).reduce((a, r) => a + (r.truePeriod || 0), 0);
  const typeTotal = (t.trueRevenueByType || []).reduce((a, r) => a + (r.truePeriod || 0), 0);
  console.log(`\n=== ${mk} ===`);
  console.log(`occ=${t.occ} rent=${t.rent} debtorTotal=${t.debtorTotal} debtorRentRollPct=${t.debtorRentRollPct}`);
  console.log(`True Revenue grand total BY DESC:  £${descTotal.toFixed(2)}  (${(t.trueRevenueByDesc || []).length} rows)`);
  console.log(`True Revenue grand total BY TYPE:  £${typeTotal.toFixed(2)}  (${(t.trueRevenueByType || []).length} rows)`);
  console.log(`Match: ${Math.abs(descTotal - typeTotal) < 1 ? 'OK' : 'MISMATCH — investigate merge logic'}`);
  console.log(`Top 5 by desc:`, (t.trueRevenueByDesc || []).slice(0, 5).map((r) => `${r.desc}=£${r.truePeriod}`).join(', '));
  console.log(`Top 5 by type:`, (t.trueRevenueByType || []).slice(0, 5).map((r) => `${r.desc}=£${r.truePeriod}`).join(', '));
  // Customer Insights inputs
  const stayWeighted = p.sites.reduce((a, s) => a + (s.avgStayDays || 0) * (s.occ || 0), 0);
  const avgStay = t.occ ? Math.round(stayWeighted / t.occ) : 0;
  console.log(`Customer Insights: avgStay=${avgStay} days, rent/occ=£${t.occ ? (t.rent / t.occ).toFixed(2) : 0}`);
}
process.exit(0);
