// Follow-up to check-stored-truerevenue.js: that confirmed raw_report.data is correct (taxAdj £206.29
// for L001/July, individually correct per row) — so the reparse DID land the fix in storage. This
// checks the NEXT layer down the pipeline: portal_payload, the actual JSON blob the frontend fetches
// and renders. If taxAdj is still correct here, the bug (if the live page still shows £0) is in the
// frontend itself or a stale client-side cache. If it's £0 HERE despite raw_report being correct, the
// bug is in buildPayload.js's own aggregation (e.g. the posDescs/mergeByDesc "Merchandise" row-merge
// at line ~337, or sumRevenueGroups' portfolio-level rollup) between raw_report and portal_payload.
// Run: cd cinch-portal-clean && node --env-file=.env scripts/check-payload-truerevenue.js [siteCode]
import { admin } from '../lib/supabaseAdmin.js';

const siteCode = process.argv[2] || 'L001';
const { data: pr, error } = await admin.from('portal_payload').select('payload, generated_at').eq('id', 1).maybeSingle();
if (error) { console.error(error.message); process.exit(1); }
let p = pr?.payload; if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }
console.log(`=== portal_payload (generated_at: ${pr?.generated_at}) — True Revenue for ${siteCode} ===\n`);

const site = (p?.sites || []).find((s) => s.code === siteCode);
if (!site) { console.log(`Site ${siteCode} not found in portal_payload.sites (${p?.sites?.length || 0} sites present).`); process.exit(0); }

const rows = site.trueRevenueByDesc || [];
console.log(`${'ChargeDesc'.padEnd(20)} taxInvoiced   netTax     taxAdj (in portal_payload -- what the frontend actually receives)`);
let sum = 0;
for (const r of rows) {
  sum += r.taxAdj || 0;
  console.log(`${(r.desc || '').padEnd(20)} £${(r.taxInvoiced ?? 0).toFixed(2).padStart(9)}   £${(r.netTax ?? 0).toFixed(2).padStart(9)}   £${(r.taxAdj ?? 0).toFixed(2).padStart(9)}`);
}
console.log(`\nSum across ${rows.length} rows in portal_payload: £${sum.toFixed(2)}`);
console.log(sum === 0
  ? '\n*** £0 HERE despite raw_report being correct -- the bug is in buildPayload.js, between raw_report and portal_payload (check the posDescs/mergeByDesc "Merchandise" row-merge, or sumRevenueGroups). ***'
  : '\n*** Correct here too. If the live page still shows £0, it is the frontend or a stale cache -- try a hard refresh / incognito tab. ***');
process.exit(0);
