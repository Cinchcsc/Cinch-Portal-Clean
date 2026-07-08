// Michael says Rate AND Real Rate matched legacy "exact, some off by a few pence" as of Friday
// (3 Jul 2026); today (8 Jul) Real Rate is off by ~4-5x (ours ~£27-34/ft², legacy's actual Real Rate
// ~£6-8/ft², while ours tracks legacy's plain RATE column instead — see task #87). Checked: git log
// only starts at the 7 Jul baseline commit (can't diff further back), the full session transcript has
// no earlier "Friday" mention, and reportMap.js's own comment says the Σ dcRent/Σ dcStandardRate ÷
// Σ area × 12 formula was locked 1 Jul and is "unchanged" — but that comment also mentions an EARLIER
// "×13/12 billing-frequency heuristic" that was superseded/removed as "no longer authoritative". If
// that removal (or something else entirely) is actually the regression, the fastest way to find out is
// empirical: pull RAW RentRoll live for Bicester (L001) — whose legacy numbers we know exactly
// (Self Storage Rate £29.98, Total Rate £28.50, Self Storage Real Rate £7.24, Total Real Rate £6.88,
// Jul 2026) — dump every field on a sample row, and try several candidate formulas side by side to see
// which one (if any) actually lands near legacy's real numbers instead of guessing blind.
// PII-SAFE: dumps field NAMES and aggregate sums only; TenantID/name fields are not printed individually.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-realrate-regression.js [siteCode]
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

const loc = process.argv[2] || 'L001';
const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);

const { rows } = await callReport('RentRoll', loc, start, end);
console.log(`${loc}: ${rows.length} total RentRoll rows pulled for Jul 2026.\n`);

const occRows = rows.filter((r) => yes(r.bRented));
console.log(`${occRows.length} occupied ("Rented") rows.\n`);

console.log('=== Every field present on one sample occupied row (values shown, no tenant identifiers) ===');
if (occRows[0]) {
  for (const [k, v] of Object.entries(occRows[0])) {
    if (/name|company|email|phone|address|tenant/i.test(k)) continue;   // skip anything PII-shaped
    console.log(`  ${k}: ${JSON.stringify(v)}`);
  }
}

// Sums needed for every candidate formula below.
let occArea = 0, totalArea = 0, rentSum = 0, stdRentSum = 0, n = 0;
for (const r of rows) {
  const a = num(r, 'Area', 'Area1');
  totalArea += a;
  if (!yes(r.bRented)) continue;
  n++; occArea += a; rentSum += num(r, 'dcRent'); stdRentSum += num(r, 'dcStandardRate');
}
console.log(`\nSums: occupied units=${n}  occupied area=${occArea}  total area (all units)=${totalArea}`);
console.log(`Σ dcRent=${rentSum.toFixed(2)}  Σ dcStandardRate=${stdRentSum.toFixed(2)}\n`);

const ann = (numer, denom, mult = 12) => denom ? +((numer / denom) * mult).toFixed(2) : 0;
console.log('=== Candidate formulas vs legacy (Bicester Jul 2026: Rate £28.50 total / £29.98 SS-only n/a here, Real Rate £6.88) ===');
console.log(`current (Σ dcRent ÷ Σ occupied area × 12)            = £${ann(rentSum, occArea)}   [our "Rate"]`);
console.log(`current (Σ dcStandardRate ÷ Σ occupied area × 12)    = £${ann(stdRentSum, occArea)}   [our "Real Rate" — this is what's off]`);
console.log(`with old ×13/12 heuristic on dcRent                  = £${ann(rentSum, occArea, 13)}`);
console.log(`with old ×13/12 heuristic on dcStandardRate          = £${ann(stdRentSum, occArea, 13)}`);
console.log(`dcRent ÷ TOTAL area (incl. vacant) × 12               = £${ann(rentSum, totalArea)}`);
console.log(`dcStandardRate ÷ TOTAL area (incl. vacant) × 12       = £${ann(stdRentSum, totalArea)}`);
console.log(`dcRent ÷ Σ occupied area (NOT annualised, monthly)    = £${occArea ? (rentSum / occArea).toFixed(2) : 0}`);
console.log(`dcStandardRate ÷ Σ occupied area (NOT annualised)     = £${occArea ? (stdRentSum / occArea).toFixed(2) : 0}`);
console.log('\nIf none of these land near £6.88, the field itself (dcStandardRate) may not be what legacy uses at all —');
console.log('worth checking the raw field dump above for any other rate-looking column we have not tried.');
process.exit(0);
