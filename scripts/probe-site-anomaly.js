// Generalized version of probe-gillingham-rentroll-anomaly.js — takes any site code. Brighton (L005)
// showed the worst mismatch yet (Rate +29%, Real Rate -14%, opposite direction from Bicester/
// Gillingham), so this also dumps True Revenue's per-type truePeriod/adj breakdown (not just
// RentRoll's dcStdRate), since Real Rate undershooting (not overshooting) points at something on
// the True Revenue side this time, not just RentRoll.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-site-anomaly.js [siteCode]
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

const loc = process.argv[2] || 'L005';
const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);

const { rows } = await callReport('RentRoll', loc, start, end);
console.log(`${loc}: ${rows.length} total RentRoll rows.\n`);

const byUnit = {}, byLedger = {};
for (const r of rows) {
  const uid = str(r.UnitID); if (uid) (byUnit[uid] ??= []).push(r);
  const lid = str(r.LedgerID); if (lid && yes(r.bRented)) (byLedger[lid] ??= []).push(r);
}
const dupUnits = Object.entries(byUnit).filter(([, v]) => v.length > 1);
const dupLedgers = Object.entries(byLedger).filter(([, v]) => v.length > 1);
console.log(`Duplicate UnitID groups: ${dupUnits.length}   Duplicate occupied LedgerID groups: ${dupLedgers.length}`);
if (dupUnits.length) console.log('  sample UnitIDs:', dupUnits.slice(0, 5).map(([k]) => k));

const occ = rows.filter((r) => yes(r.bRented));
const byType = {};
for (const r of occ) {
  const t = str(r.sTypeName) || 'Other';
  const o = (byType[t] ??= { n: 0, area: 0, std: 0, rent: 0 });
  const a = num(r, 'Area', 'Area1');
  o.n++; o.area += a; o.std += num(r, 'dcStdRate'); o.rent += num(r, 'dcRent');
}
console.log('\nRentRoll per-type (occupied), dcStdRate basis (drives Rate):');
for (const [t, o] of Object.entries(byType)) {
  console.log(`  ${t}: n=${o.n}  area=${o.area.toFixed(0)}  ΣdcStdRate=${o.std.toFixed(2)}  ΣdcRent=${o.rent.toFixed(2)}  ->  £${o.area ? (o.std / o.area * 12).toFixed(2) : 'N/A(0 area)'}/ft²`);
}

// True Revenue side — Real Rate undershoot could mean a type with unusually large `adj` relative
// to its truePeriod, or a type contributing lots of area but little/negative revenue.
const trRows = await callCustomReport(781861, loc, start, end);
const tr = REPORTS.true_revenue.parse(trRows.rows);
console.log('\nTrue Revenue per-type (drives Real Rate):');
for (const t of tr.by_type) {
  console.log(`  "${t.desc}": truePeriod=${t.truePeriod}  adj=${t.adj}  (truePeriod-adj)=${(t.truePeriod - t.adj).toFixed(2)}  invoiced=${t.invoiced}`);
}

const sorted = [...occ].sort((a, b) => num(b, 'dcStdRate') - num(a, 'dcStdRate')).slice(0, 8);
console.log('\nTop 8 highest dcStdRate rows (occupied):');
for (const r of sorted) console.log(`  ${str(r.sUnit)} (${str(r.sTypeName)}, ${num(r, 'Area', 'Area1')}ft²): dcStdRate=${num(r, 'dcStdRate').toFixed(2)}  dcRent=${num(r, 'dcRent').toFixed(2)}`);
const bottom = [...occ].sort((a, b) => num(a, 'dcStdRate') - num(b, 'dcStdRate')).slice(0, 8);
console.log('\nBottom 8 lowest dcStdRate rows (occupied, incl. any zeros):');
for (const r of bottom) console.log(`  ${str(r.sUnit)} (${str(r.sTypeName)}, ${num(r, 'Area', 'Area1')}ft²): dcStdRate=${num(r, 'dcStdRate').toFixed(2)}  dcRent=${num(r, 'dcRent').toFixed(2)}`);
process.exit(0);
