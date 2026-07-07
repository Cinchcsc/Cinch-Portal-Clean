// Reconciles the rate/ft² method: for the first location (Bicester L001), groups
// OccupancyStatistics by UnitType and computes FOUR candidate rate/ft² (annualised) methods, so
// we can see which one matches your live portal's "Self Storage Rate/ft²" (~£61):
//   areaW-Actual  = (Σ ActualOccupied ÷ Σ occupied area) × 12         [simple area-weighted, actual rent]
//   areaW-Std     = (Σ GrossOccupied  ÷ Σ occupied area) × 12         [area-weighted, standard/rack rate]
//   unitAvg-Actual= Σ(occupied × per-size rate) ÷ Σ occupied          [unit-weighted avg of per-size rate]
//   unwAvg-Actual = mean(per-size rate)                               [plain average across unit sizes]
// Run locally:  cd "sitelink-backend" && npm run probe:rate
import { callReport } from '../lib/sitelink.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };

const { rows } = await callReport('OccupancyStatistics', loc, start, now);
const g = {};
for (const r of rows) {
  const t = r.UnitType || '(blank)';
  const o = num(r.Occupied), a = num(r.Area), rent = num(r.ActualOccupied), gocc = num(r.GrossOccupied), std = num(r.StandardRate);
  (g[t] ??= { occ: 0, occA: 0, rent: 0, gocc: 0, sw: 0, sumSize: 0, n: 0 });
  const G = g[t];
  G.occ += o; G.occA += a * o; G.rent += rent; G.gocc += gocc;
  if (o > 0 && a > 0) { const sizeRate = (rent / o) / a * 12; G.sw += o * sizeRate; G.sumSize += sizeRate; G.n++; }
}
console.log(`Site ${loc} · ${start.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)}\n`);
console.log('UnitType            | areaW-Actual | areaW-Std | unitAvg-Actual | unwAvg-Actual');
console.log('--------------------|--------------|-----------|----------------|--------------');
for (const t of Object.keys(g)) {
  const x = g[t];
  const aw = x.occA ? x.rent / x.occA * 12 : 0;
  const aws = x.occA ? x.gocc / x.occA * 12 : 0;
  const uw = x.occ ? x.sw / x.occ : 0;
  const un = x.n ? x.sumSize / x.n : 0;
  console.log(`${t.padEnd(19)} | £${aw.toFixed(2).padStart(10)} | £${aws.toFixed(2).padStart(7)} | £${uw.toFixed(2).padStart(12)} | £${un.toFixed(2).padStart(10)}`);
}
process.exit(0);
