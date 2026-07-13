// Task #109 follow-up. probe-rate-discrepancy-sites.js ruled out the three original suspects for
// why plain Rate runs 8-29% high on ~12 sites: duplicate rows (0 everywhere), the dcStdRate-vs-
// dcStandardRate gap (uniform ~6-8% at BOTH flagged and control sites, so it's background noise,
// not a differentiator), and wide within-type dcStdRate spread (also present at controls, e.g.
// Bicester's Indoor Self Storage spread is 327% — bigger than several flagged sites). None of those
// track the actual error size. Also noted (probe-rate-both-formulas.js's own header comment, 8 Jul):
// sites that nail plain Rate tend to be mediocre on Real Rate and vice versa (Bicester / Gillingham).
// The one thing that structurally differs between the two formulas is the AREA basis (Rate divides
// by occupied area, Real Rate by total area) — the dollar side (dcStdRate vs TruePeriod) is unrelated.
// That points at Area, not rate, as the more likely fault line. This checks it directly: for each
// occupied row, back out its implied £/ft²/yr (dcStdRate/Area×12) and flag rows far from the site's
// own median — a unit whose recorded Area is wrong (too small) will look like a rate outlier here
// even though its dcStdRate is perfectly normal. Then recompute Rate with outlier rows excluded, to
// see whether a handful of bad-area rows (not a broad site-wide shift) account for the gap.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-rate-unit-outliers.js
import { callReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-rate-unit-outliers] ' + lock.message); process.exit(1); }

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

const SITES = {
  L005: { name: 'Brighton', target: 28.28, flagged: true }, L006: { name: 'Huntingdon', target: 17.50, flagged: true },
  L009: { name: 'Newbury', target: 23.22, flagged: true }, L011: { name: 'Sittingbourne', target: 30.90, flagged: true },
  L012: { name: 'Gillingham', target: 32.78, flagged: true }, L013: { name: 'Brentwood', target: 23.97, flagged: true },
  L014: { name: 'Earlsfield', target: 30.68, flagged: true }, L016: { name: 'Seaford', target: 20.36, flagged: true },
  L020: { name: 'Dunstable', target: 20.80, flagged: true }, L023: { name: 'Wisbech', target: 13.67, flagged: true },
  L024: { name: 'Newcastle', target: 17.58, flagged: true }, L027: { name: 'Exeter', target: 22.88, flagged: true },
  L001: { name: 'Bicester', target: 28.50, flagged: false }, L002: { name: 'Leighton Buzzard', target: 33.96, flagged: false },
  L004: { name: 'Chippenham', target: 34.95, flagged: false },
};

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const end = now;
console.log(`Per-unit implied £/ft²/yr outlier check, current month, ${Object.keys(SITES).length} sites\n`);

for (const [loc, { name, target, flagged }] of Object.entries(SITES)) {
  const { rows } = await callReport('RentRoll', loc, start, end);
  const occ = rows.filter((r) => yes(r.bRented));

  const withImplied = occ.map((r) => {
    const area = num(r, 'Area', 'Area1'), std = num(r, 'dcStdRate');
    return { area, std, type: str(r.sTypeName) || 'Other', unit: str(r.sUnit), implied: area > 0 ? (std / area) * 12 : null };
  });
  const valid = withImplied.filter((r) => r.implied != null);
  const med = median(valid.map((r) => r.implied));

  const HI = med * 2.5, LO = med * 0.4;
  const outliers = valid.filter((r) => r.implied > HI || r.implied < LO);
  const zeroArea = withImplied.filter((r) => r.area === 0);

  const totalArea = valid.reduce((a, r) => a + r.area, 0);
  const totalStd = valid.reduce((a, r) => a + r.std, 0);
  const rate = totalArea ? +((totalStd / totalArea) * 12).toFixed(2) : 0;

  const cleanRows = valid.filter((r) => !outliers.includes(r));
  const cleanArea = cleanRows.reduce((a, r) => a + r.area, 0);
  const cleanStd = cleanRows.reduce((a, r) => a + r.std, 0);
  const cleanRate = cleanArea ? +((cleanStd / cleanArea) * 12).toFixed(2) : 0;

  const outlierStdSum = outliers.reduce((a, r) => a + r.std, 0);
  const pctOfDollarsFromOutliers = totalStd ? ((outlierStdSum / totalStd) * 100).toFixed(1) : '0.0';

  const diffPct = target ? (((rate - target) / target) * 100).toFixed(1) : 'n/a';
  const cleanDiffPct = target ? (((cleanRate - target) / target) * 100).toFixed(1) : 'n/a';

  console.log(`${loc} ${name} ${flagged ? '[FLAGGED]' : '[control]'} — median £${med.toFixed(2)}/ft²/yr across ${valid.length} occupied+area rows (+${zeroArea.length} zero-area rows excluded from median/outlier calc, kept in main Rate)`);
  console.log(`  Full Rate: £${rate} (target £${target}, ${diffPct}%)   Outlier rows (>${HI.toFixed(0)} or <${LO.toFixed(0)} £/ft²/yr): ${outliers.length} of ${valid.length} (${(outliers.length / valid.length * 100).toFixed(1)}%), ${pctOfDollarsFromOutliers}% of occupied £`);
  console.log(`  Rate with outlier rows excluded: £${cleanRate} (target £${target}, ${cleanDiffPct}%)   ${Math.abs(cleanRate - rate) > 0.5 ? '<-- moves meaningfully' : '<-- barely moves'}`);
  if (outliers.length) {
    const sample = outliers.sort((a, b) => b.implied - a.implied).slice(0, 5);
    console.log(`  sample outliers: ${sample.map((r) => `${r.unit || '?'}(${r.type}, ${r.area}ft², £${r.std}/mo -> £${r.implied.toFixed(0)}/ft²/yr)`).join('; ')}`);
  }
  console.log('');
}
process.exit(0);
