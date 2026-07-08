// Decisive test after 3 sites showed escalating, non-convergent per-site errors (Bicester +0.5%/
// Gillingham +8%/Brighton +29% on Rate; +3.9%/-0.3%/-14% on Real Rate): does the PORTFOLIO-WIDE
// total (sum-then-divide-once across all shared sites, the convention everywhere else in this
// codebase) land close to legacy's own portfolio total, even if individual sites are noisy?
// Legacy's Jul 2026 totals (from the Rate/Real Rate tables' bottom row): SS Rate £26.29, Total Rate
// £25.11, SS Real Rate £5.71, Total Real Rate £5.59.
// Scoped to the 25 sites SHARED with legacy — excludes Bedford (L021) and Paulton (L026), which
// legacy doesn't track yet (confirmed earlier this session), so this is a true apples-to-apples
// portfolio comparison, not inflated by 2 extra sites legacy's own total never included.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-portfolio-rate-totals.js
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

const EXCLUDE = new Set(['L021', 'L026']);   // Bedford, Paulton — not in legacy's own total
const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter((c) => c && !EXCLUDE.has(c));
const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);
console.log(`Summing across ${locations.length} sites (excluding Bedford/Paulton to match legacy's scope)...\n`);

let occArea = 0, ssOccArea = 0, stdSum = 0, ssStdSum = 0, totalArea = 0, ssTotalArea = 0;
let tpTotal = 0, adjTotal = 0, tpSS = 0, adjSS = 0;
let failed = 0;

for (const loc of locations) {
  process.stderr.write(`[portfolio-rate] ${loc}...\n`);
  try {
    const { rows: rrRows } = await callReport('RentRoll', loc, start, end);
    for (const r of rrRows) {
      const a = num(r, 'Area', 'Area1'), t = str(r.sTypeName) || 'Other';
      totalArea += a; if (isSS(t)) ssTotalArea += a;
      if (!yes(r.bRented)) continue;
      const std = num(r, 'dcStdRate');
      occArea += a; stdSum += std;
      if (isSS(t)) { ssOccArea += a; ssStdSum += std; }
    }
    const trRows = await callCustomReport(781861, loc, start, end);
    const tr = REPORTS.true_revenue.parse(trRows.rows);
    for (const t of tr.by_type) {
      tpTotal += t.truePeriod; adjTotal += t.adj;
      if (isSS(t.desc)) { tpSS += t.truePeriod; adjSS += t.adj; }
    }
  } catch (e) { failed++; console.log(`  ${loc}: error: ${e.message}`); }
}

const rate = occArea ? +((stdSum / occArea) * 12).toFixed(2) : 0;
const ssRate = ssOccArea ? +((ssStdSum / ssOccArea) * 12).toFixed(2) : 0;
const realRate = totalArea ? +(((tpTotal - adjTotal) / totalArea) * 12).toFixed(2) : 0;
const ssReal = ssTotalArea ? +(((tpSS - adjSS) / ssTotalArea) * 12).toFixed(2) : 0;

console.log(`\n${failed} site(s) failed.\n`);
console.log('=== Portfolio-wide totals (sum-then-divide-once, 25 shared sites) ===');
const diff = (a, b) => `${a >= b ? '+' : ''}${(a - b).toFixed(2)} (${(((a - b) / b) * 100).toFixed(1)}%)`;
console.log(`Rate:       Total £${rate}  (legacy £25.11, ${diff(rate, 25.11)})    SS £${ssRate}  (legacy £26.29, ${diff(ssRate, 26.29)})`);
console.log(`Real Rate:  Total £${realRate}  (legacy £5.59, ${diff(realRate, 5.59)})    SS £${ssReal}  (legacy £5.71, ${diff(ssReal, 5.71)})`);
process.exit(0);
