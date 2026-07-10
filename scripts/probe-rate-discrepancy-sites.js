// Task #109 — "plain Rate" (asking rate, s.rate — NOT Real Rate, which was already separately
// investigated and confirmed-correct) is 8-29% high on ~12 specific sites vs Michael's legacy
// targets (per verify-realrate-truerev-fix.js's TARGETS table), while other sites land close.
// Flagged but never investigated until now. Rate is computed ENTIRELY from RentRoll (no True
// Revenue involved at all — a completely separate pipeline from Real Rate), per reportMap.js's
// rent_roll parser: Rate = (Σ dcStdRate ÷ Σ Area) × 12, occupied ("Rented") rows only.
// A ~0.5% error on Bicester (probe-rate-verify-2sites.js) but 7.7-9.1% on Gillingham (same script)
// ruled the FORMULA out as portfolio-wide-wrong — it's specific to certain sites, which points to a
// data-quality issue (duplicate rows, or dcStdRate not actually being uniform-per-type the way the
// formula assumes) rather than a wrong calculation. probe-gillingham-rentroll-anomaly.js was written
// to check exactly this for Gillingham alone but was never run/reported on. This generalizes that
// same diagnostic across ALL 12 flagged sites in one pass, plus 3 known-good control sites for
// contrast (Bicester/Leighton Buzzard/Chippenham — not in the flagged list, presumably fine), and
// adds one more check that script didn't have: how much dcStdRate varies WITHIN a single unit type
// at a site (it's supposed to be that type's current site-wide rate, i.e. near-uniform — a wide
// min-max spread within one type is itself suspicious, independent of any duplicate-row check).
// Makes ~15 live SiteLink calls (one per site) — respects the shared pull lock.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-rate-discrepancy-sites.js
import { callReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-rate-discrepancy-sites] ' + lock.message); process.exit(1); }

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

// name + Total Rate target — same TARGETS table as verify-realrate-truerev-fix.js, Total Rate column only.
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

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const end = now;
console.log(`Current month (${start.toISOString().slice(0, 7)}) — RentRoll live for ${Object.keys(SITES).length} sites (12 flagged + 3 control)\n`);

for (const [loc, { name, target, flagged }] of Object.entries(SITES)) {
  const { rows } = await callReport('RentRoll', loc, start, end);
  const occ = rows.filter((r) => yes(r.bRented));

  // 1. Duplicate check (same as probe-gillingham-rentroll-anomaly.js).
  const byUnit = {}, byLedger = {};
  for (const r of rows) {
    const uid = str(r.UnitID); if (uid) (byUnit[uid] ??= []).push(r);
    const lid = str(r.LedgerID); if (lid && yes(r.bRented)) (byLedger[lid] ??= []).push(r);
  }
  const dupUnits = Object.entries(byUnit).filter(([, v]) => v.length > 1);
  const dupLedgers = Object.entries(byLedger).filter(([, v]) => v.length > 1);

  // 2. Reproduce the exact Total Rate the app computes, right now, live.
  let occArea = 0, stdRateSum = 0, standardRateSum = 0;
  const byType = {};
  for (const r of occ) {
    const a = num(r, 'Area', 'Area1'), std = num(r, 'dcStdRate'), standard = num(r, 'dcStandardRate'), t = str(r.sTypeName) || 'Other';
    occArea += a; stdRateSum += std; standardRateSum += standard;
    const o = (byType[t] ??= { n: 0, area: 0, std: 0, min: Infinity, max: 0 });
    o.n++; o.area += a; o.std += std; if (std < o.min) o.min = std; if (std > o.max) o.max = std;
  }
  const rate = occArea ? +((stdRateSum / occArea) * 12).toFixed(2) : 0;
  const diffPct = target ? +(((rate - target) / target) * 100).toFixed(1) : null;
  const flag = flagged ? '[FLAGGED]' : '[control]';

  console.log(`${loc} ${name} ${flag} — Total Rate £${rate} (target £${target}, ${diffPct >= 0 ? '+' : ''}${diffPct}%)`);
  console.log(`  ${rows.length} rows total, ${occ.length} rented. Duplicate UnitID groups: ${dupUnits.length}. Duplicate occupied-LedgerID groups: ${dupLedgers.length}`);
  console.log(`  dcStdRate sum (occupied): ${stdRateSum.toFixed(2)}   dcStandardRate sum (occupied): ${standardRateSum.toFixed(2)}   gap: ${(stdRateSum ? ((stdRateSum - standardRateSum) / stdRateSum * 100) : 0).toFixed(1)}%`);
  if (dupUnits.length) console.log(`  sample duplicate UnitIDs: ${dupUnits.slice(0, 3).map(([k]) => k).join(', ')}`);
  for (const [t, o] of Object.entries(byType)) {
    const spread = o.n > 1 ? +((o.max - o.min) / (o.std / o.n) * 100).toFixed(0) : 0;
    console.log(`    ${t}: n=${o.n} area=${o.area.toFixed(0)} avg dcStdRate/unit=£${(o.std / o.n).toFixed(2)} range=£${o.min.toFixed(2)}-£${o.max.toFixed(2)}${spread > 20 ? '  <-- wide within-type spread (' + spread + '% of avg)' : ''}`);
  }
  console.log('');
}
process.exit(0);
