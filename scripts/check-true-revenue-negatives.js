// Michael noticed the last few rows in the True Revenue table are negative (e.g. "Recurring Charge
// 1", "Other") and asked whether that's expected. TruePeriod isn't a raw charge total — it's
// InvoicedThisPeriod + tax adjustments + DeferredRevenue + PriorPeriodDeferred + ThisPeriodAdjustments
// + PriorPeriodAdjustments (see reportMap.js's true_revenue.parse(), 9-column sum). A negative
// TruePeriod for a category means refunds/credits/deferred-revenue reversals outweighed new charges
// for that ChargeDesc in the period — plausible for a low-volume/legacy charge code, but worth
// actually looking at the column breakdown rather than assuming. This dumps every column (not just
// the final truePeriod) for whichever desc labels are negative, summed across all sites, so we can
// see WHICH component is driving the negative (e.g. all in ThisPeriodAdjustments = real credits
// issued that period, vs something that looks like a parsing/sign bug).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-true-revenue-negatives.js [YYYY-MM]
import { admin } from '../lib/supabaseAdmin.js';
import { listStoredMonths } from '../lib/buildPayload.js';

const arg = process.argv[2];
const mk = arg || (await listStoredMonths()).slice(-1)[0];
const monthKey = `${mk}-01`;

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
const totals = {};   // desc -> summed columns across all sites
for (const loc of locations) {
  const { data } = await admin.from('raw_report').select('data').eq('site_code', loc).eq('report', 'true_revenue').eq('month', monthKey).maybeSingle();
  for (const r of (data?.data?.by_desc || [])) {
    const t = (totals[r.desc] ??= { invoiced: 0, taxInvoiced: 0, taxAdj: 0, netTax: 0, deferred: 0, deferredPrev: 0, adj: 0, adjPrev: 0, truePeriod: 0 });
    for (const k of Object.keys(t)) t[k] += r[k] || 0;
  }
}

console.log(`Month: ${mk} — column breakdown for every NEGATIVE truePeriod desc:\n`);
for (const [desc, t] of Object.entries(totals)) {
  if (t.truePeriod >= 0) continue;
  console.log(`${desc}:  truePeriod=£${t.truePeriod.toFixed(2)}`);
  console.log(`  invoiced=£${t.invoiced.toFixed(2)}  taxInvoiced=£${t.taxInvoiced.toFixed(2)}  taxAdj=£${t.taxAdj.toFixed(2)}  netTax=£${t.netTax.toFixed(2)}`);
  console.log(`  deferred=£${t.deferred.toFixed(2)}  deferredPrev=£${t.deferredPrev.toFixed(2)}  adj=£${t.adj.toFixed(2)}  adjPrev=£${t.adjPrev.toFixed(2)}\n`);
}
process.exit(0);
