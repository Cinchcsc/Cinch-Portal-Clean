// Follow-up to probe-rate-verify-2sites.js: dcStdRate/occArea×12 nailed Bicester (+0.5%) but is
// 7.7-9.1% high on Gillingham (L012) — the same site already flagged for the unresolved True Revenue
// 2.14x bug (task #77). Before concluding the Rate FORMULA is wrong, check whether L012 specifically
// has a data-quality issue: duplicate rows (same LedgerID/UnitID appearing twice, inflating the sum),
// or a handful of outlier dcStdRate values dragging the average up.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-gillingham-rentroll-anomaly.js
import { callReport } from '../lib/sitelink.js';

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

const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);
const { rows } = await callReport('RentRoll', 'L012', start, end);
console.log(`L012: ${rows.length} total rows pulled.\n`);

// Duplicate check: same UnitID/LedgerID appearing more than once.
const byUnit = {}, byLedger = {};
for (const r of rows) {
  const uid = str(r.UnitID); if (uid) (byUnit[uid] ??= []).push(r);
  const lid = str(r.LedgerID); if (lid && yes(r.bRented)) (byLedger[lid] ??= []).push(r);
}
const dupUnits = Object.entries(byUnit).filter(([, v]) => v.length > 1);
const dupLedgers = Object.entries(byLedger).filter(([, v]) => v.length > 1);
console.log(`Duplicate UnitID groups: ${dupUnits.length}`);
console.log(`Duplicate (occupied) LedgerID groups: ${dupLedgers.length}`);
if (dupUnits.length) console.log('  sample UnitIDs:', dupUnits.slice(0, 5).map(([k]) => k));
if (dupLedgers.length) console.log('  sample LedgerIDs:', dupLedgers.slice(0, 5).map(([k]) => k));

// Per-type breakdown: count, area, dcStdRate sum + average per unit, to spot an outlier type/row.
const occ = rows.filter((r) => yes(r.bRented));
const byType = {};
for (const r of occ) {
  const t = str(r.sTypeName) || 'Other';
  const o = (byType[t] ??= { n: 0, area: 0, std: 0, max: 0 });
  const a = num(r, 'Area', 'Area1'), s = num(r, 'dcStdRate');
  o.n++; o.area += a; o.std += s; if (s > o.max) o.max = s;
}
console.log('\nPer-type breakdown (occupied only):');
for (const [t, o] of Object.entries(byType)) {
  console.log(`  ${t}: n=${o.n}  area=${o.area.toFixed(0)}  ΣdcStdRate=${o.std.toFixed(2)}  avg/unit=${(o.std / o.n).toFixed(2)}  max single=${o.max.toFixed(2)}  ->  £${(o.std / o.area * 12).toFixed(2)}/ft²`);
}

// Top 10 highest dcStdRate values overall, to spot a single bad outlier row.
const sorted = [...occ].sort((a, b) => num(b, 'dcStdRate') - num(a, 'dcStdRate')).slice(0, 10);
console.log('\nTop 10 highest dcStdRate rows (occupied):');
for (const r of sorted) console.log(`  ${str(r.sUnit)} (${str(r.sTypeName)}, ${num(r, 'Area', 'Area1')}ft²): dcStdRate=${num(r, 'dcStdRate').toFixed(2)}  dcRent=${num(r, 'dcRent').toFixed(2)}`);
process.exit(0);
