// Verifies the True Revenue-based Real Rate fix (8 Jul 2026) against the exact legacy targets
// already validated earlier today in scripts/probe-rate-both-formulas.js. That script proved
// Σ(TruePeriod − adj) ÷ Σ TOTAL AREA (incl. vacant) × 12 lands within a few % of legacy per-site —
// this script checks the ACTUAL buildPayload() output (what the portal serves) reproduces that same
// result now that the formula + the occupied-vs-total-area denominator fix are both wired into
// lib/reportMap.js / lib/buildPayload.js, instead of trusting a one-off probe script in isolation.
// Read-only, no writes.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/verify-realrate-truerev-fix.js
import { buildPayload } from '../lib/buildPayload.js';

// Legacy Jul 2026 targets, [SS Rate, Total Rate, SS Real Rate, Total Real Rate] — same table as
// scripts/probe-rate-both-formulas.js.
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

const now = new Date();
const cur = new Date(now.getFullYear(), now.getMonth(), 1);
const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const payload = await buildPayload(cur, prev);
const byCode = Object.fromEntries(payload.sites.map((s) => [s.code, s]));

const diffPct = (a, b) => (b ? `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%` : 'n/a');

console.log(`=== Real Rate fix check — ${payload.current_month}, ${Object.keys(TARGETS).length} sites with known legacy targets ===\n`);
console.log('code   name                  ssRate(£)          totalRate(£)         ssReal(£)          totalReal(£)');
let ssRealDiffs = [], totalRealDiffs = [];
for (const [code, [tSS, tTotal, tSSReal, tTotalReal]] of Object.entries(TARGETS)) {
  const s = byCode[code];
  if (!s) { console.log(`${code}  MISSING from payload.sites entirely`); continue; }
  const ssRealDiff = diffPct(s.ssReal, tSSReal), totalRealDiff = diffPct(s.realRate, tTotalReal);
  ssRealDiffs.push(Math.abs((s.ssReal - tSSReal) / tSSReal * 100));
  totalRealDiffs.push(Math.abs((s.realRate - tTotalReal) / tTotalReal * 100));
  console.log(
    `${code}  ${(s.name || '').padEnd(20)}  ` +
    `£${s.ssRate.toFixed(2)} (tgt £${tSS}, ${diffPct(s.ssRate, tSS)})   ` +
    `£${s.rate.toFixed(2)} (tgt £${tTotal}, ${diffPct(s.rate, tTotal)})   ` +
    `£${s.ssReal.toFixed(2)} (tgt £${tSSReal}, ${ssRealDiff})   ` +
    `£${s.realRate.toFixed(2)} (tgt £${tTotalReal}, ${totalRealDiff})`
  );
}
const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 'n/a';
console.log(`\nAverage absolute Real Rate error — SS: ${avg(ssRealDiffs)}%   Total: ${avg(totalRealDiffs)}%`);
console.log('(For reference, probe-rate-both-formulas.js earlier found ~0.3-9% site-level variance is normal/expected for this formula.)');
process.exit(0);
