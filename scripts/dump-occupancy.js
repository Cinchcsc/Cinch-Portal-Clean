// Writes the FULL per-unit-size OccupancyStatistics data for every site to occ_dump.json, so the
// exact "rate/ft²" formula can be reverse-engineered against the live portal's numbers. No tenant
// PII (OccupancyStatistics is per-unit-size aggregates only). Targets the LAST COMPLETE month so it
// matches what the live portal shows. Run once:  npm run dump:occ
import { callReport } from '../lib/sitelink.js';
import { writeFileSync } from 'fs';

const codes = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);   // first of last complete month (matches live portal)
const end = new Date(now.getFullYear(), now.getMonth(), 0);         // last day of last complete month
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const isSS = (t) => /self.?storage/i.test(t || '');

const out = { _meta: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) } };
const recon = [];
for (const loc of codes) {
  try {
    const { rows } = await callReport('OccupancyStatistics', loc, start, end);
    const recs = rows.map(r => ({
      ut: r.UnitType, sz: r.UnitSize, area: num(r.Area), occ: num(r.Occupied), tot: num(r.TotalUnits),
      std: num(r.StandardRate), gp: num(r.GrossPotential), gocc: num(r.GrossOccupied), ao: num(r.ActualOccupied),
    }));
    out[loc] = recs;
    // area-weighted Standard vs Actual rate/ft² annualised, for Self-Storage and Total
    let ssA = 0, ssG = 0, ssAO = 0, alA = 0, alG = 0, alAO = 0;
    for (const r of recs) {
      const oa = r.area * r.occ;
      alA += oa; alG += r.gocc; alAO += r.ao;
      if (isSS(r.ut)) { ssA += oa; ssG += r.gocc; ssAO += r.ao; }
    }
    const rate = (g, a) => a ? +(g / a * 12).toFixed(2) : 0;
    recon.push({ loc, ssRate: rate(ssG, ssA), ssReal: rate(ssAO, ssA), totRate: rate(alG, alA), totReal: rate(alAO, alA) });
    process.stdout.write('.');
  } catch (e) { out[loc] = { error: e.message }; process.stdout.write('x'); }
}
writeFileSync('occ_dump.json', JSON.stringify(out));
console.log('\n\nRATE RECONCILIATION (area-weighted) · ' + out._meta.start + ' → ' + out._meta.end);
console.log('site   | SS Rate (std) | SS Real (act) | Total Rate (std) | Total Real (act)');
console.log('-------|---------------|---------------|------------------|-----------------');
for (const r of recon) console.log(`${r.loc.padEnd(6)} | £${String(r.ssRate).padStart(11)} | £${String(r.ssReal).padStart(11)} | £${String(r.totRate).padStart(14)} | £${String(r.totReal).padStart(13)}`);
console.log('\nWrote occ_dump.json (' + (Object.keys(out).length - 1) + ' sites). Safe to delete — occupancy aggregates only, no customer data.');
process.exit(0);
