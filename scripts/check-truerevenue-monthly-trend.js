// June's stored TruePeriod for L001 (58404.82) is internally consistent (all 3 raw tables agree,
// no duplicate rows) but ~3x an already-confirmed-correct July figure (19483.82) and implausible on
// its face (£28/ft² annualized). TruePeriod bakes in DeferredRevenue/PriorPeriodDeferred/
// PriorPeriodAdjustments alongside InvoicedThisPeriod -- if it's a lumpy, deferred-revenue-
// recognition-driven figure rather than a smooth monthly rent number, ANY single month's blind x12
// annualization would be unreliable, not just July's partial-MTD case or a coverage gap. This pulls
// every stored month's TruePeriod sum (plus its InvoicedThisPeriod/DeferredRevenue/adjustment
// components) for one site, no live SiteLink calls, to see directly whether it's stable or spiky,
// and if spiky, which component drives it.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-truerevenue-monthly-trend.js [SITE]
// Example: node --env-file=.env scripts/check-truerevenue-monthly-trend.js L001
import { admin } from '../lib/supabaseAdmin.js';

const site = process.argv[2] || 'L001';

const { data, error } = await admin
  .from('raw_report').select('month,data,pulled_at').eq('report', 'true_revenue').eq('site_code', site).order('month');
if (error) { console.log('read error:', error.message); process.exit(1); }
if (!data?.length) { console.log(`No stored true_revenue rows for ${site}.`); process.exit(0); }

console.log(`${site}: ${data.length} stored months\n`);
console.log('month        truePeriod   invoiced   deferred   priorDeferred  adj       priorAdj    pulled_at');
console.log('----------------------------------------------------------------------------------------------------');

const sum = (byType, key) => byType.reduce((a, r) => a + (r[key] || 0), 0);
const rows = [];
for (const r of data) {
  let d = r.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
  const byType = d?.by_type || [];
  const truePeriod = sum(byType, 'truePeriod');
  const invoiced = sum(byType, 'invoiced');
  const deferred = sum(byType, 'deferred');
  const deferredPrev = sum(byType, 'deferredPrev');
  const adj = sum(byType, 'adj');
  const adjPrev = sum(byType, 'adjPrev');
  rows.push({ month: String(r.month).slice(0, 10), truePeriod, invoiced, deferred, deferredPrev, adj, adjPrev, pulled_at: r.pulled_at });
  console.log(`${String(r.month).slice(0, 10).padEnd(12)} ${truePeriod.toFixed(0).padStart(10)}  ${invoiced.toFixed(0).padStart(9)}  ${deferred.toFixed(0).padStart(9)}  ${deferredPrev.toFixed(0).padStart(12)}  ${adj.toFixed(0).padStart(8)}  ${adjPrev.toFixed(0).padStart(9)}   ${r.pulled_at}`);
}

const tps = rows.map((r) => r.truePeriod);
const avg = tps.reduce((a, b) => a + b, 0) / tps.length;
const max = Math.max(...tps), min = Math.min(...tps);
console.log(`\nTruePeriod across ${tps.length} months — min ${min.toFixed(0)}, max ${max.toFixed(0)}, avg ${avg.toFixed(0)}.`);
console.log(`Max/min ratio: ${min !== 0 ? (max / min).toFixed(1) : 'n/a'}x`);
console.log('If this bounces around a lot month to month (not a smooth, gradually-changing number), that supports TruePeriod being driven by lumpy deferred-revenue-recognition events rather than steady rent -- meaning no single month\'s blind x12 will ever reliably estimate an annual rate.');
process.exit(0);
