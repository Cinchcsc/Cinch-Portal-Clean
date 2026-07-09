// Michael: L001 alone shows correct nonzero Tax Adj in portal_payload, but "All Stores, July 2026"
// (the actual view he's looking at) still shows £0 across the board. The "All Stores" True Revenue
// table is a PORTFOLIO aggregate — app/portal-v2/page.js recomputes it client-side via its own
// sumRevenueGroups() (same logic as lib/buildPayload.js's totals.trueRevenueByDesc), summing
// `row.taxAdj` across EVERY site's trueRevenueByDesc rows for each ChargeDesc.
// Leading hypothesis: `o.taxAdj += row.taxAdj` is a PLAIN JS addition with no fallback -- if even ONE
// site's stored row is missing a `taxAdj` key entirely (e.g. left over from an older pull/reparse that
// predates the taxAdj-as-derived-value fix), `existingNumber + undefined` is NaN, and NaN poisons that
// ChargeDesc's running total for ALL 29 sites from that point on. A NaN can easily render as "£0.00" or
// blank depending on the money formatter, looking exactly like "everything is 0" even though most sites
// are fine. This checks every site's true_revenue rows for missing/non-finite taxAdj, replicates the
// exact portfolio sum, and also checks payload.totals.trueRevenueByDesc (the server-side aggregate) —
// so we know whether this is a frontend-only issue or affects the payload itself.
// Run: cd cinch-portal-clean && node --env-file=.env scripts/check-portfolio-truerevenue.js
import { admin } from '../lib/supabaseAdmin.js';

const { data: pr, error } = await admin.from('portal_payload').select('payload, generated_at').eq('id', 1).maybeSingle();
if (error) { console.error(error.message); process.exit(1); }
let p = pr?.payload; if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }
console.log(`=== portal_payload (generated_at: ${pr?.generated_at}) — Tax Adj sanity check across all sites ===\n`);

const sites = p?.sites || [];
console.log(`${sites.length} sites in payload.\n`);

let anyBad = false;
for (const s of sites) {
  const rows = s.trueRevenueByDesc || [];
  for (const r of rows) {
    const bad = !('taxAdj' in r) || typeof r.taxAdj !== 'number' || !Number.isFinite(r.taxAdj);
    if (bad) {
      anyBad = true;
      console.log(`  *** ${s.code} / "${r.desc}": taxAdj = ${JSON.stringify(r.taxAdj)} (missing or not a finite number) ***`);
    }
  }
}
console.log(anyBad ? '\nFound at least one bad taxAdj value above -- this WILL poison the portfolio sum with NaN.' : '\nNo missing/non-finite taxAdj values found on any site.');

// Replicate the exact client-side (and server-side) aggregation: sum taxAdj per ChargeDesc across all sites.
const g = {};
for (const s of sites) for (const row of (s.trueRevenueByDesc || [])) {
  const o = (g[row.desc] ??= { desc: row.desc, taxAdj: 0 });
  o.taxAdj += row.taxAdj;
}
console.log(`\nReplicated portfolio sum (same logic as sumRevenueGroups), by ChargeDesc:`);
let grandTotal = 0;
for (const o of Object.values(g).sort((a, b) => b.taxAdj - a.taxAdj)) {
  console.log(`  ${o.desc.padEnd(24)} taxAdj = ${Number.isNaN(o.taxAdj) ? 'NaN <-- POISONED' : '£' + o.taxAdj.toFixed(2)}`);
  grandTotal += o.taxAdj;
}
console.log(`\nGrand total: ${Number.isNaN(grandTotal) ? 'NaN' : '£' + grandTotal.toFixed(2)}`);

// Also check the SERVER-side aggregate already stored in the payload (lib/buildPayload.js's own
// aggregateTotals/sumRevenueGroups), for comparison.
const serverRows = p?.totals?.trueRevenueByDesc || [];
console.log(`\npayload.totals.trueRevenueByDesc (server-computed, ${serverRows.length} rows):`);
let serverSum = 0;
for (const r of serverRows) { serverSum += r.taxAdj; console.log(`  ${(r.desc || '').padEnd(24)} taxAdj = ${Number.isNaN(r.taxAdj) ? 'NaN <-- POISONED' : '£' + (r.taxAdj ?? 0).toFixed(2)}`); }
console.log(`Server-side grand total: ${Number.isNaN(serverSum) ? 'NaN' : '£' + serverSum.toFixed(2)}`);
process.exit(0);
