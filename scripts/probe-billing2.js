// Decide the exact annualisation: ×13 (4-weekly) vs ×12 (monthly), derived per-unit, and test
// which method reproduces the old portal. PII-SAFE: only aggregate £/ft² + ratio clusters.
//   node --env-file=.env scripts/probe-billing2.js [LOC]
import { callReport } from '../lib/sitelink.js';
const loc = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',')[0].trim();
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const { rows } = await callReport('RentRoll', loc, start, now);
const num = v => { const n = Number(String(v ?? '').replace(/[£,\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const isSS = t => /self.?storage/i.test(t || '');
const occ = rows.filter(r => String(r.bRented) === '1' || /^(1|true|yes)$/i.test(String(r.bRented ?? '')));

// 1) which standard field is bimodal at 4.0 / 4.333 when divided by the weekly rate?
const clust = (field) => {
  const c = {};
  for (const r of occ) { const w = num(r.dcStdWeeklyRate); if (!w) continue; const v = num(r[field]); if (!v) continue; const k = (v / w).toFixed(1); c[k] = (c[k] || 0) + 1; }
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k}×${n}`).join(', ');
};
console.log('ratio  dcStandardRate/weekly :', clust('dcStandardRate'));
console.log('ratio  dcStdRate/weekly      :', clust('dcStdRate'));
console.log('ratio  dcRent/weekly         :', clust('dcRent'));

// 2) per-unit period from dcStandardRate/weekly (fallback dcStdRate); <4.17 => 4-weekly(×13) else monthly(×12)
const periodMult = (r) => {
  const w = num(r.dcStdWeeklyRate); const s = num(r.dcStandardRate) || num(r.dcStdRate);
  if (!w || !s) return 13; return (s / w) >= 4.17 ? 12 : 13;
};
const agg = (filter) => {
  let area = 0, a13 = 0, a12 = 0, amix = 0, wk52 = 0, std_mix = 0;
  for (const r of occ) {
    if (filter && !isSS(r.sTypeName)) continue;
    const a = num(r.Area) || num(r.Area1); if (!a) continue;
    const rent = num(r.dcRent), w = num(r.dcStdWeeklyRate), m = periodMult(r);
    area += a; a13 += rent * 13; a12 += rent * 12; amix += rent * m; wk52 += w * 52;
    std_mix += (num(r.dcStandardRate) || num(r.dcStdRate)) * m;
  }
  const f = x => (area ? x / area : 0).toFixed(2);
  return { '×13all': f(a13), '×12all': f(a12), '×mix(dcRent)': f(amix), 'weekly×52': f(wk52), '×mix(std)': f(std_mix) };
};
console.log('\nOLD portal Bicester  ->  SS asking 30.03 | Total asking 28.68');
console.log('SS   :', agg(true));
console.log('Total:', agg(false));
const m4 = occ.filter(r => { const w = num(r.dcStdWeeklyRate), s = num(r.dcStandardRate) || num(r.dcStdRate); return w && s && s / w < 4.17; }).length;
console.log(`\nperiod split (occupied): 4-weekly ${m4} / monthly ${occ.length - m4} (of ${occ.length})`);
process.exit(0);
