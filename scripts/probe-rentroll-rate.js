// Finds which RentRoll per-unit rate field reproduces the live portal's "Rate per ft²".
// PII-SAFE: reads RentRoll but prints ONLY aggregate £/ft² numbers — no names, units, or balances,
// and writes no file. Targets the last complete month. Run:  npm run probe:rr
import { callReport } from '../lib/sitelink.js';

const codes = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const isSS = (t) => /self.?storage/i.test(t || '');
const occd = (r) => num(r.bRented) === 1 || /^(1|true|yes)$/i.test(String(r.bRented ?? '')) ;

// candidate per-unit monthly-rate fields to test
const FIELDS = ['dcRent', 'dcStandardRate', 'dcStdRate', 'dcSchedRent', 'dcSchedRateMonthly', 'dcPushRate', 'dcWebRate'];

console.log('Live L001 targets -> SS Rate 29.74 | SS Real 27.53 | Total Rate 28.46 | Total Real 26.48\n');
console.log('area-weighted £/ft² annualised, OCCUPIED units only.  (Real = dcRent)\n');
const head = 'site   | scope |' + FIELDS.map(f => f.replace('dc', '').padStart(9)).join(' |');
for (const loc of codes) {
  let rows;
  try { ({ rows } = await callReport('RentRoll', loc, start, end)); }
  catch (e) { console.log(`${loc}: ERROR ${e.message}`); continue; }
  const acc = { ss: { area: 0 }, all: { area: 0 } };
  FIELDS.forEach(f => { acc.ss[f] = 0; acc.all[f] = 0; });
  for (const r of rows) {
    if (!occd(r)) continue;
    const a = num(r.Area) || num(r.Area1); if (!a) continue;
    const ss = isSS(r.sTypeName);
    acc.all.area += a; if (ss) acc.ss.area += a;
    for (const f of FIELDS) { const v = num(r[f]); acc.all[f] += v; if (ss) acc.ss[f] += v; }
  }
  const line = (scope) => {
    const o = acc[scope];
    const cells = FIELDS.map(f => (o.area ? (o[f] / o.area * 12) : 0).toFixed(2).padStart(9));
    return `${loc.padEnd(6)} | ${scope === 'ss' ? 'SS ' : 'ALL'}   |` + cells.join(' |');
  };
  if (loc === codes[0]) console.log(head);
  console.log(line('ss'));
  console.log(line('all'));
}
process.exit(0);
