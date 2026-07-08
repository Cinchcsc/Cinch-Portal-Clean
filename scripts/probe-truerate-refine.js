// Follow-up to probe-truerate-tooltip.js: TruePeriod ÷ Total Area × 12 lands within ~8% of legacy on
// BOTH tested sites, consistently HIGH (Bicester £7.45 vs £6.88 target, +8.3%; Gillingham £8.41 vs
// £7.81 target, +7.7%). That consistency across two very different sites (different area, different
// revenue) rules out noise — something specific is missing. Two candidates:
//   1. A tax/VAT component still inside TruePeriod that legacy's Real Rate excludes.
//   2. TruePeriod is right but "Total Area" is missing some site-level common/office area not
//      captured as a RentRoll unit row (the ABSOLUTE gap in sqft-equivalent terms is oddly similar
//      between the two sites despite very different totals — worth checking directly).
// This dumps EVERY column on the True Revenue report (not just truePeriod/invoiced) by type, and
// tries TruePeriod minus each of the other columns as a candidate numerator, against known targets
// for both sites.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-truerate-refine.js [siteCode]
import { callReport, callCustomReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const num = (row, ...keys) => {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== '') {
      const n = Number(String(row[k]).replace(/[£,%\s]/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
};
const str = (v) => (v == null ? '' : String(v)).trim();
const isSS = (t) => str(t).toLowerCase().includes('self storage');

// Known legacy targets, Jul 2026, per site (from Michael's screenshots).
const TARGETS = {
  L001: { totalRate: 28.50, totalReal: 6.88, ssRate: 29.98, ssReal: 7.24 },
  L012: { totalRate: 32.78, totalReal: 7.81, ssRate: 32.46, ssReal: 7.70 },
};

const loc = process.argv[2] || 'L001';
const tgt = TARGETS[loc];
const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);

const trRows = await callCustomReport(781861, loc, start, end);
const tr = REPORTS.true_revenue.parse(trRows.rows);
console.log(`=== True Revenue, EVERY column, by_type, ${loc}, Jul 2026 ===`);
const totals = {};
for (const t of tr.by_type) {
  for (const k of Object.keys(t)) { if (k === 'desc') continue; totals[k] = (totals[k] || 0) + (t[k] || 0); }
  console.log(`  "${t.desc}": ${Object.entries(t).filter(([k]) => k !== 'desc').map(([k, v]) => `${k}=${v}`).join('  ')}`);
}
console.log('\nPortfolio-site totals (all types):', JSON.stringify(totals, null, 2));

const { rows: rrRows } = await callReport('RentRoll', loc, start, end);
let totalArea = 0, ssArea = 0;
for (const r of rrRows) {
  const a = num(r, 'Area', 'Area1'), t = str(r.sTypeName) || 'Other';
  totalArea += a;
  if (isSS(t)) ssArea += a;
}
let ssTotals = {};
for (const t of tr.by_type) if (isSS(t.desc)) for (const k of Object.keys(t)) { if (k === 'desc') continue; ssTotals[k] = (ssTotals[k] || 0) + (t[k] || 0); }

const ann = (numer, denom) => denom ? +((numer / denom) * 12).toFixed(2) : 0;
console.log(`\nΣ Total Area=${totalArea.toFixed(2)}  Σ SS Area=${ssArea.toFixed(2)}`);
console.log(tgt ? `\nTargets for ${loc}: Total Real Rate £${tgt.totalReal}  SS Real Rate £${tgt.ssReal}` : `\n(no known target for ${loc} — add it to TARGETS if you have it)`);

console.log('\n=== Candidate numerators (TruePeriod minus each other column), ÷ Total Area × 12 ===');
for (const k of ['invoiced', 'taxInvoiced', 'taxAdj', 'netTax', 'deferred', 'deferredPrev', 'adj', 'adjPrev']) {
  const totalCandidate = ann(totals.truePeriod - (totals[k] || 0), totalArea);
  const ssCandidate = ann(ssTotals.truePeriod - (ssTotals[k] || 0), ssArea);
  console.log(`  TruePeriod - ${k}:  Total=£${totalCandidate}  SS=£${ssCandidate}`);
}
console.log(`\n  TruePeriod alone (baseline):  Total=£${ann(totals.truePeriod, totalArea)}  SS=£${ann(ssTotals.truePeriod, ssArea)}`);
console.log(`  TruePeriod / 1.2 (strip 20% VAT):  Total=£${ann(totals.truePeriod / 1.2, totalArea)}  SS=£${ann(ssTotals.truePeriod / 1.2, ssArea)}`);
process.exit(0);
