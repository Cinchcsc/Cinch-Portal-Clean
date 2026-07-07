// Locks R6's documented rate method: Rate = (Σ rent ÷ Σ area) × 12 from the Rent Roll, with a
// 28-day-billing ×1.0833 adjustment. Prints area-weighted rates for candidate rent fields (raw and
// ×1.0833) for SS vs Total across the first 5 sites, plus a billing-cycle histogram so we can see
// how 28-day billing is encoded. PII-SAFE: only aggregates + field histograms, no names, no file.
//   npm run probe:r2
import { callReport } from '../lib/sitelink.js';

const codes = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const occd = (r) => num(r.bRented) === 1 || /^(1|true|yes)$/i.test(String(r.bRented ?? ''));
const isSS = (t) => /self.?storage/i.test(t || '');

console.log(`Rent Roll rate test · ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`);
console.log('LIVE targets — L001 Bicester: SS 29.74 / Total 28.46 ;  L002 Leighton Buzzard SS ~31.7\n');
console.log('site  scope | dcRent | dcRent×1.0833 | dcStandardRate | dcStdRate | n');
const annivHist = {};
for (const loc of codes.slice(0, 5)) {
  let rows;
  try { ({ rows } = await callReport('RentRoll', loc, start, end)); }
  catch (e) { console.log(loc, 'ERROR', e.message); continue; }
  const A = { ss: { a: 0, rent: 0, std: 0, stdr: 0, n: 0 }, all: { a: 0, rent: 0, std: 0, stdr: 0, n: 0 } };
  for (const r of rows) {
    if (!occd(r)) continue;
    const a = num(r.Area) || num(r.Area1); if (!a) continue;
    annivHist[num(r.iAnnivDays)] = (annivHist[num(r.iAnnivDays)] || 0) + 1;
    for (const sc of [A.all, isSS(r.sTypeName) ? A.ss : null]) {
      if (!sc) continue; sc.a += a; sc.rent += num(r.dcRent); sc.std += num(r.dcStandardRate); sc.stdr += num(r.dcStdRate); sc.n++;
    }
  }
  const R = (g, a) => a ? (g / a * 12).toFixed(2) : '-';
  const line = (s, o) => `${loc} ${s} | ${String(R(o.rent, o.a)).padStart(6)} | ${String(R(o.rent * 1.0833, o.a)).padStart(12)} | ${String(R(o.std, o.a)).padStart(14)} | ${String(R(o.stdr, o.a)).padStart(9)} | ${o.n}`;
  console.log(line('SS ', A.ss)); console.log(line('ALL', A.all));
}
console.log('\niAnnivDays histogram (occupied, first 5 sites) — reveals the billing cycle:');
console.log(JSON.stringify(annivHist));
process.exit(0);
