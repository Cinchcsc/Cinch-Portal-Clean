// Michael (8 Jul 2026): "it is true revenue / total area * 12, dont change any code until we confirm
// this though" — i.e. Real Rate = Σ TruePeriod ÷ Σ TotalArea × 12, with NO subtraction of
// ThisPeriodAdjustments, as opposed to the currently-implemented Σ(TruePeriod − ThisPeriodAdjustments)
// ÷ Σ TotalArea × 12. This came up because an earlier comment of mine (check-true-revenue-negatives.js)
// describes TruePeriod as ALREADY being a sum that includes ThisPeriodAdjustments as one of its
// addends — if true, subtracting it again would be double-counting, which is worth testing for real
// rather than reasoning about further.
//
// READ-ONLY — makes fresh LIVE SiteLink calls (same reports/columns as production, imported from the
// same lib/reportMap.js and lib/sitelink.js, not a reimplementation), computes BOTH formula variants
// for every site with a known legacy target, and prints them side by side. Using fresh live data
// (not stored raw_report rows) deliberately isolates the FORMULA question from the separate "is
// true_revenue's stored data stale" question raised in check-truerevenue-freshness.js. Does NOT touch
// lib/buildPayload.js or lib/reportMap.js — no production code changes until this confirms which
// formula actually matches.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-realrate-formula-variant.js
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

// Same 25-site Jul 2026 legacy targets used throughout today's Real Rate work (TARGETS[code] =
// [SS Rate, Total Rate, SS Real Rate, Total Real Rate]) — only the last two columns matter here.
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

const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);

const diffPct = (a, b) => (b ? `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%` : 'n/a');

console.log(`=== Real Rate formula variant check — live SiteLink data, Jul 2026 (${Object.keys(TARGETS).length} sites) ===`);
console.log('Formula A (current production): Σ(TruePeriod − ThisPeriodAdjustments) ÷ Σ TotalArea × 12');
console.log('Formula B (Michael\'s proposal): Σ TruePeriod ÷ Σ TotalArea × 12  (no adjustment subtraction)\n');

const errA_ss = [], errA_tot = [], errB_ss = [], errB_tot = [];

for (const code of Object.keys(TARGETS)) {
  const [, , tSSReal, tTotalReal] = TARGETS[code];
  try {
    const { rows: rrRows } = await callReport('RentRoll', code, start, end);
    let totalArea = 0, ssTotalArea = 0;
    for (const r of rrRows) {
      const a = num(r, 'Area', 'Area1'), t = str(r.sTypeName) || 'Other';
      totalArea += a; if (isSS(t)) ssTotalArea += a;
    }
    const { rows: trRawRows } = await callCustomReport(781861, code, start, end);
    const tr = REPORTS.true_revenue.parse(trRawRows);
    let tpTotal = 0, adjTotal = 0, tpSS = 0, adjSS = 0;
    for (const t of tr.by_type) {
      tpTotal += t.truePeriod; adjTotal += t.adj;
      if (isSS(t.desc)) { tpSS += t.truePeriod; adjSS += t.adj; }
    }
    const aTotal = totalArea ? +(((tpTotal - adjTotal) / totalArea) * 12).toFixed(2) : 0;
    const aSS = ssTotalArea ? +(((tpSS - adjSS) / ssTotalArea) * 12).toFixed(2) : 0;
    const bTotal = totalArea ? +((tpTotal / totalArea) * 12).toFixed(2) : 0;
    const bSS = ssTotalArea ? +((tpSS / ssTotalArea) * 12).toFixed(2) : 0;

    if (tTotalReal) { errA_tot.push(Math.abs((aTotal - tTotalReal) / tTotalReal * 100)); errB_tot.push(Math.abs((bTotal - tTotalReal) / tTotalReal * 100)); }
    if (tSSReal) { errA_ss.push(Math.abs((aSS - tSSReal) / tSSReal * 100)); errB_ss.push(Math.abs((bSS - tSSReal) / tSSReal * 100)); }

    console.log(`${code}  SS: A=£${aSS} (${diffPct(aSS, tSSReal)})  B=£${bSS} (${diffPct(bSS, tSSReal)})  tgt £${tSSReal}   |   Total: A=£${aTotal} (${diffPct(aTotal, tTotalReal)})  B=£${bTotal} (${diffPct(bTotal, tTotalReal)})  tgt £${tTotalReal}`);
    // Raw components too (8 Jul 2026) — a big miss on EITHER formula could be the area denominator
    // being wrong for that specific site, not the adjustments question at all. Printing these means
    // one run tells us which component (area vs revenue) is the actual problem for the worst sites,
    // instead of needing a follow-up round-trip.
    console.log(`      raw: totalArea=${totalArea.toFixed(0)}ft² ssTotalArea=${ssTotalArea.toFixed(0)}ft²  tpTotal=£${tpTotal.toFixed(2)} adjTotal=£${adjTotal.toFixed(2)}  tpSS=£${tpSS.toFixed(2)} adjSS=£${adjSS.toFixed(2)}  (${rrRows.length} RentRoll rows, ${trRawRows.length} True Revenue rows)`);
  } catch (e) {
    console.log(`${code}  FAILED — ${e.message}`);
  }
}

const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 'n/a';
console.log(`\nAverage absolute error — Formula A (current, minus adjustments): SS ${avg(errA_ss)}%  Total ${avg(errA_tot)}%`);
console.log(`Average absolute error — Formula B (Michael's, no subtraction):    SS ${avg(errB_ss)}%  Total ${avg(errB_tot)}%`);
console.log(`\nWhichever formula has the LOWER average error above is the one to actually implement.`);
process.exit(0);
