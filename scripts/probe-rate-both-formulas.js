// Comprehensive check: BOTH formulas (plain Rate via dcStdRate÷occArea, Real Rate via
// TruePeriod-minus-adj÷TotalArea) against a third site, to see if the pattern so far — Bicester
// nails Rate (+0.5%) but is mediocre on Real Rate (+3.6-3.9%); Gillingham nails Real Rate (+0.3%)
// but is way off on Rate (+7.7-9.1%) — is coincidental noise or means something. Using Brighton
// (L005), already flagged earlier this session as one of the biggest Rate/RealRate outliers.
// All 26 legacy targets from Michael's Jul 2026 screenshots are included so any site can be checked.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-rate-both-formulas.js [siteCode]
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

// Legacy Jul 2026: [SS Rate, Total Rate, SS Real Rate, Total Real Rate]
const TARGETS = {
  L001: [29.98, 28.50, 7.24, 6.88], L002: [33.97, 33.96, 8.02, 8.07], L003: [31.26, 31.42, 7.48, 7.28],
  L004: [35.27, 34.95, 7.95, 7.86], L005: [28.36, 28.28, 6.60, 6.59], L006: [20.29, 17.50, 5.03, 4.34],
  L007: [22.77, 23.39, 5.29, 5.49], L008: [26.15, 26.75, 4.45, 4.48], L010: [36.42, 36.25, 8.35, 8.17],
  L011: [31.77, 30.90, 7.51, 7.19], L012: [32.46, 32.78, 7.70, 7.81], L013: [23.87, 23.97, 5.27, 5.47],
  L014: [30.89, 30.68, 7.27, 7.23], L015: [23.64, 22.04, 5.30, 5.10], L016: [20.60, 20.36, 4.67, 4.66],
  L018: [24.12, 23.94, 5.78, 5.78], L019: [30.28, 28.07, 6.82, 6.43], L020: [21.69, 20.80, 4.65, 4.45],
  L017: [23.86, 23.18, 5.54, 5.15], L009: [23.98, 23.22, 5.55, 5.44], L022: [20.54, 19.33, 4.31, 3.99],
  L023: [14.39, 13.67, 3.13, 3.03], L024: [17.50, 17.58, 3.25, 3.27], L027: [25.06, 22.88, 3.09, 2.98],
  L025: [18.52, 17.08, 3.07, 3.02],
};

const loc = process.argv[2] || 'L005';
const tgt = TARGETS[loc];
const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);

// --- Rate: dcStdRate / occupied area ---
const { rows: rrRows } = await callReport('RentRoll', loc, start, end);
let occArea = 0, ssOccArea = 0, stdSum = 0, ssStdSum = 0, totalArea = 0, ssTotalArea = 0;
for (const r of rrRows) {
  const a = num(r, 'Area', 'Area1'), t = str(r.sTypeName) || 'Other';
  totalArea += a; if (isSS(t)) ssTotalArea += a;
  if (!yes(r.bRented)) continue;
  const std = num(r, 'dcStdRate');
  occArea += a; stdSum += std;
  if (isSS(t)) { ssOccArea += a; ssStdSum += std; }
}
const rate = occArea ? +((stdSum / occArea) * 12).toFixed(2) : 0;
const ssRate = ssOccArea ? +((ssStdSum / ssOccArea) * 12).toFixed(2) : 0;

// --- Real Rate: (TruePeriod - adj) / TOTAL area ---
const trRows = await callCustomReport(781861, loc, start, end);
const tr = REPORTS.true_revenue.parse(trRows.rows);
let tpTotal = 0, adjTotal = 0, tpSS = 0, adjSS = 0;
for (const t of tr.by_type) {
  tpTotal += t.truePeriod; adjTotal += t.adj;
  if (isSS(t.desc)) { tpSS += t.truePeriod; adjSS += t.adj; }
}
const realRate = totalArea ? +(((tpTotal - adjTotal) / totalArea) * 12).toFixed(2) : 0;
const ssReal = ssTotalArea ? +(((tpSS - adjSS) / ssTotalArea) * 12).toFixed(2) : 0;

console.log(`=== ${loc} — both formulas, Jul 2026 ===\n`);
const diff = (a, b) => `${a >= b ? '+' : ''}${(a - b).toFixed(2)} (${(((a - b) / b) * 100).toFixed(1)}%)`;
if (tgt) {
  const [tSS, tTotal, tSSReal, tTotalReal] = tgt;
  console.log(`Rate:       Total £${rate}  (target £${tTotal}, ${diff(rate, tTotal)})    SS £${ssRate}  (target £${tSS}, ${diff(ssRate, tSS)})`);
  console.log(`Real Rate:  Total £${realRate}  (target £${tTotalReal}, ${diff(realRate, tTotalReal)})    SS £${ssReal}  (target £${tSSReal}, ${diff(ssReal, tSSReal)})`);
} else {
  console.log(`Rate:       Total £${rate}    SS £${ssRate}`);
  console.log(`Real Rate:  Total £${realRate}    SS £${ssReal}`);
  console.log(`(no known legacy target hardcoded for ${loc} — add it to TARGETS if you have it)`);
}
process.exit(0);
