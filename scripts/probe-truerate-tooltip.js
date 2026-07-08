// BREAKTHROUGH LEAD (8 Jul 2026): Michael sent legacy's own tooltip text for the Real Rate table:
//   "Self Storage Rate: True Period for all self storage units at location divided by total area
//    for all storage units at location"
//   "Total Rate: True Period for all unit types at location divided by total area for all unit
//    types at location"
// "True Period" is not a vague phrase — it's the LITERAL column name on the True Revenue custom
// report (781861), already parsed in reportMap.js as `truePeriod` (see true_revenue's `cols`/
// `outKeys` arrays). This is a completely different report from both RentRoll and OccupancyStatistics
// (which is exactly why neither of those got anywhere close to legacy's £6.88 in the last two probes),
// AND it divides by TOTAL area (all units, occupied + vacant) — not occupied area, which every other
// rate calc in this codebase uses. Never tried this exact combination before. Tests it directly against
// Bicester's known target (Total Real Rate £6.88, SS Real Rate £7.24, Jul 2026).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-truerate-tooltip.js [siteCode]
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
const yes = (v) => v === true || v === 'true' || v === 1 || v === '1';
const str = (v) => (v == null ? '' : String(v)).trim();
const isSS = (t) => str(t).toLowerCase().includes('self storage');

const loc = process.argv[2] || 'L001';
const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);

// --- True Revenue: sum truePeriod by unit type ---
const trRows = await callCustomReport(781861, loc, start, end);
const tr = REPORTS.true_revenue.parse(trRows.rows);
let totalTruePeriod = 0, ssTruePeriod = 0;
console.log(`=== True Revenue by_type, ${loc}, Jul 2026 ===`);
for (const t of tr.by_type) {
  totalTruePeriod += t.truePeriod;
  if (isSS(t.desc)) ssTruePeriod += t.truePeriod;
  console.log(`  "${t.desc}": truePeriod=${t.truePeriod}  invoiced=${t.invoiced}${isSS(t.desc) ? '  <-- self storage' : ''}`);
}
console.log(`\nΣ TruePeriod (all types)          = ${totalTruePeriod.toFixed(2)}`);
console.log(`Σ TruePeriod (self storage only)  = ${ssTruePeriod.toFixed(2)}\n`);

// --- RentRoll: TOTAL area (all units, occupied + vacant), all types vs self-storage only ---
const { rows: rrRows } = await callReport('RentRoll', loc, start, end);
let totalArea = 0, ssArea = 0;
for (const r of rrRows) {
  const a = num(r, 'Area', 'Area1'), t = str(r.sTypeName) || 'Other';
  totalArea += a;
  if (isSS(t)) ssArea += a;
}
console.log(`Σ Total Area (all units, all types)         = ${totalArea.toFixed(2)}`);
console.log(`Σ Total Area (all units, self storage only) = ${ssArea.toFixed(2)}\n`);

// --- The tooltip's formula: TruePeriod / Total Area, annualised x12 ---
const ann = (numer, denom) => denom ? +((numer / denom) * 12).toFixed(2) : 0;
console.log('=== Tooltip formula: (Σ TruePeriod ÷ Σ Total Area) × 12 ===');
console.log(`Total Rate       = £${ann(totalTruePeriod, totalArea)}   (legacy Total Real Rate target: £6.88)`);
console.log(`Self Storage Rate = £${ann(ssTruePeriod, ssArea)}   (legacy SS Real Rate target: £7.24)`);
console.log('\n(also trying WITHOUT the x12 annualisation, in case TruePeriod is already a period/annual figure)');
console.log(`Total Rate (no x12)       = £${totalArea ? (totalTruePeriod / totalArea).toFixed(2) : 0}`);
console.log(`Self Storage Rate (no x12) = £${ssArea ? (ssTruePeriod / ssArea).toFixed(2) : 0}`);
process.exit(0);
