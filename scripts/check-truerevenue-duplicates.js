// Follow-up to dump-truerevenue-tables.js's result (7 Jul 2026): the raw CustomReportByReportID(781861)
// response for L012/June 2026 has 3 tables (21, 43, 2381 rows) — but the 21/43-row tables are far too
// small to be full duplicate detail tables for a site this size (hundreds of occupied units), and the
// sample row from the 2381-row table is genuine per-CHARGE transaction detail (specific Tenant/Unit/
// ChargeDesc/ChargeStart/ChargeEnd/Amount) — not a coarser aggregate. The 21 and 43 row counts look much
// more like per-ChargeDesc and per-(ChargeDesc,UnitType) SUBTOTAL tables (e.g. ~21 distinct charge
// descriptions), which extractRows() already correctly excludes by picking only the single largest
// table (2381 rows). That RULES OUT the "biggest-table-wins discards a same-size duplicate table" bug
// class already confirmed for ManagementSummary — there's no second table anywhere near 2381 rows here.
// So the ~2.14x inflation must come from somewhere else. Since 2.14x is close to a clean 2x, the next
// most likely explanation is literal DUPLICATE ROWS within the 2381-row detail table itself (e.g. the
// same charge line appearing twice under two different ChargeBatchInvoice numbers, or a rebill/adjustment
// pairing that both carry the same TruePeriod value). This script checks for exact and near-duplicate
// rows (same Tenant+Unit+ChargeDesc+ChargeStart+ChargeEnd) and reports how much of the total TruePeriod
// sum comes from rows that share a "duplicate key" with at least one other row.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-truerevenue-duplicates.js [siteCode]
// Example: node --env-file=.env scripts/check-truerevenue-duplicates.js L012
import { callCustomReport } from '../lib/sitelink.js';

const siteCode = process.argv[2] || 'L012';
const start = new Date(2026, 5, 1), end = new Date(2026, 5, 30); // June 2026
const { rows } = await callCustomReport(781861, siteCode, start, end);

const num = (r, k) => { const v = Number(r[k]); return Number.isFinite(v) ? v : 0; };
const str = (v) => (v == null ? '' : String(v));

console.log(`${rows.length} rows returned for ${siteCode}, June 2026.\n`);

// Exact duplicate rows: identical on every field we can see (would mean the SOAP response itself
// contains a literal repeat, e.g. the same charge line included twice).
const exactKey = (r) => JSON.stringify(r);
const exactMap = {};
for (const r of rows) { const k = exactKey(r); (exactMap[k] ??= []).push(r); }
const exactDupGroups = Object.values(exactMap).filter((g) => g.length > 1);
console.log(`Exact full-row duplicates: ${exactDupGroups.length} group(s), ${exactDupGroups.reduce((a, g) => a + g.length, 0)} rows total.`);

// Business-key duplicates: same Tenant+Unit+ChargeDesc+ChargeStart+ChargeEnd (would mean the same
// billing period for the same charge is represented by more than one row — e.g. an original charge +
// a separate adjustment/rebill row both carrying their own TruePeriod that shouldn't both be summed).
const bizKey = (r) => [str(r.Tenant), str(r.Unit), str(r.ChargeDesc), str(r.ChargeStart), str(r.ChargeEnd)].join('|');
const bizMap = {};
for (const r of rows) { const k = bizKey(r); (bizMap[k] ??= []).push(r); }
const bizDupGroups = Object.values(bizMap).filter((g) => g.length > 1);
const totalTruePeriod = rows.reduce((a, r) => a + num(r, 'TruePeriod'), 0);
const dupRowsTruePeriod = bizDupGroups.reduce((a, g) => a + g.reduce((b, r) => b + num(r, 'TruePeriod'), 0), 0);
console.log(`Business-key (Tenant+Unit+ChargeDesc+ChargeStart+ChargeEnd) duplicates: ${bizDupGroups.length} group(s), ${bizDupGroups.reduce((a, g) => a + g.length, 0)} rows total.`);
console.log(`  Sum of TruePeriod across ALL rows: ${totalTruePeriod.toFixed(2)}`);
console.log(`  Sum of TruePeriod across rows that are part of a business-key duplicate group: ${dupRowsTruePeriod.toFixed(2)} (${totalTruePeriod ? (dupRowsTruePeriod / totalTruePeriod * 100).toFixed(1) : 0}% of total)`);
if (bizDupGroups.length) {
  console.log(`\n  Sample duplicate group (first found):`);
  console.log(JSON.stringify(bizDupGroups[0], null, 2));
}

// Sanity check: what would the total look like if we only counted ONE row per business key (keeping
// whichever row in each group has the largest TruePeriod, as a simple dedup heuristic)?
const dedupedTotal = Object.values(bizMap).reduce((a, g) => a + Math.max(...g.map((r) => num(r, 'TruePeriod'))), 0);
console.log(`\nIf deduped to one row per business key (keeping the max TruePeriod per group):`);
console.log(`  Deduped TruePeriod total: ${dedupedTotal.toFixed(2)}  (vs raw total ${totalTruePeriod.toFixed(2)}, ratio ${(totalTruePeriod / (dedupedTotal || 1)).toFixed(2)}x)`);
console.log(`\nFor reference: legacy's True Period figure for all sites combined, June 2026, was ~£1,088,223.23 vs our ~£2,331,337.64 (ratio ~2.14x) — compare that portfolio-wide ratio to this one site's ratio above.`);
process.exit(0);
