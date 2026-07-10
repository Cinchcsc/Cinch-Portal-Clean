// Follow-up to probe-truerevenue-period-granularity.js + the reverted commit 9fba2e4: properly
// annualizing calendar-month-to-date True Revenue (365/actualDays instead of a blind 12) moved every
// site a uniform ~3.04x FURTHER from Michael's legacy targets (confirmed live, 10 Jul 2026), not
// closer -- even though Michael confirmed legacy's Real Rate DOES update day-to-day (so it's not a
// frozen last-complete-month figure either). That combination -- updates daily, but a young partial
// calendar month badly overshoots -- fits a ROLLING window (e.g. trailing 30 days ending today)
// better than calendar-month-to-date: a rolling window is never "only N days old and skewed by
// whichever billing dates happen to fall inside it" the way early-July is, because it always samples
// a full ~month's worth of days no matter what day you ask on.
// READ-ONLY, live SiteLink. Tests trailing-30-days for all 25 sites with known legacy targets and
// reports the SAME average-error metric as verify-realrate-truerev-fix.js / probe-realrate-formula-
// variant.js, so it's directly comparable to both the 26% (old, calendar-MTD-then-x12) and 207%
// (calendar-MTD-then-properly-annualized) baselines already measured today.
// Run: cd cinch-portal-clean && node --env-file=.env scripts/probe-realrate-trailing30.js
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

// Same 25-site Jul 2026 legacy targets used throughout today's Real Rate work.
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

const today = new Date(); today.setHours(0, 0, 0, 0);
const trailingStart = new Date(today); trailingStart.setDate(trailingStart.getDate() - 29); // 30 days incl. today
const periodDays = Math.round((today - trailingStart) / 86400000) + 1;

const diffPct = (a, b) => (b ? `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%` : 'n/a');

console.log(`=== Real Rate, TRAILING ${periodDays}-day window (${trailingStart.toISOString().slice(0, 10)}..${today.toISOString().slice(0, 10)}) vs legacy Jul 2026 targets ===\n`);

const errSS = [], errTot = [];
for (const code of Object.keys(TARGETS)) {
  const [, , tSSReal, tTotalReal] = TARGETS[code];
  try {
    const { rows: rrRows } = await callReport('RentRoll', code, trailingStart, today);
    let totalArea = 0, ssTotalArea = 0;
    for (const r of rrRows) {
      const a = num(r, 'Area', 'Area1'), t = str(r.sTypeName) || 'Other';
      totalArea += a; if (isSS(t)) ssTotalArea += a;
    }
    const { rows: trRows } = await callCustomReport(781861, code, trailingStart, today);
    const tr = REPORTS.true_revenue.parse(trRows, trailingStart, today);
    let tpTotal = 0, tpSS = 0;
    for (const t of tr.by_type) { tpTotal += t.truePeriod; if (isSS(t.desc)) tpSS += t.truePeriod; }

    const annualize = 365 / (tr.period_days || periodDays);
    const ssRate = ssTotalArea ? +((tpSS / ssTotalArea) * annualize).toFixed(2) : 0;
    const totRate = totalArea ? +((tpTotal / totalArea) * annualize).toFixed(2) : 0;

    if (tSSReal) errSS.push(Math.abs((ssRate - tSSReal) / tSSReal * 100));
    if (tTotalReal) errTot.push(Math.abs((totRate - tTotalReal) / tTotalReal * 100));

    console.log(`${code}  SS: £${ssRate} (tgt £${tSSReal}, ${diffPct(ssRate, tSSReal)})   Total: £${totRate} (tgt £${tTotalReal}, ${diffPct(totRate, tTotalReal)})`);
  } catch (e) {
    console.log(`${code}  FAILED — ${e.message}`);
  }
}
const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 'n/a';
console.log(`\nAverage absolute error, trailing-30-day window — SS: ${avg(errSS)}%  Total: ${avg(errTot)}%`);
console.log('For reference: calendar-month-to-date + blind x12 (old) = SS 26.4% / Total 24.1%.');
console.log('               calendar-month-to-date + properly annualized (reverted) = SS/Total ~207%.');
console.log('If trailing-30-day lands much closer to (or better than) the 26%/24% baseline, that confirms');
console.log('legacy is using a rolling window, not calendar-month-to-date -- and that\'s the real fix.');
process.exit(0);
