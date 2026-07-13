// Task #196 follow-up. probe-rate-testdata.js just ruled out test/demo tenant accounts as the cause
// of plain Rate running 11-46% high on all 12 flagged sites (excluding matched rows barely moves the
// number anywhere — the "cinch"/"r6"/"test" email matches are real staff/customer addresses that
// happen to contain those substrings, not actual test units). That's the 5th hypothesis killed
// (duplicates, dcStdRate-vs-dcStandardRate noise, per-unit outliers, wide within-type spread, test
// data all dead) — and the pattern in that run's own numbers is itself a clue: EVERY flagged site ran
// high (11.0% to 46.1%), while all 3 control sites were small and MIXED sign (+4.0%, -7.8%, -4.1%).
// A uniformly one-directional error across a specific subset of sites, with normal noise elsewhere,
// looks less like a bug in how we read RentRoll and more like either (a) a real, live rate difference
// SiteLink itself would show even through a totally different report, or (b) the hardcoded "target"
// figures being stale for exactly these 12 sites (rate increases since the target was captured).
// This tests (a) directly and cheaply: OccupancyStatistics computes its OWN "Rate per ft²" completely
// independently of RentRoll -- different report, different SiteLink-side StandardRate field, same
// formula shape (Σ GrossOccupied ÷ Σ occupied_area × 12 -- see lib/reportMap.js's occupancy parser).
// If SiteLink's own two internal reports already disagree with EACH OTHER on rate for the flagged
// sites (but agree for controls), that's a real live SiteLink-side data discrepancy specific to those
// sites -- not something either our code or the hardcoded target could be wrong about. If both
// RentRoll and OccupancyStatistics agree with each other but BOTH sit far from "target", that points
// squarely at the target being stale rather than any live data problem.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-rate-crosscheck-occstats.js
import { callReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-rate-crosscheck-occstats] ' + lock.message); process.exit(1); }

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

console.log('Cross-checking RentRoll-derived Rate vs OccupancyStatistics-derived Rate (SiteLink\'s own two independent reports), live, current MTD\n');
console.log('Site  Name                  Target    RentRoll(dcStdRate)      OccStats(GrossOccupied)    RR-vs-Target   OS-vs-Target   RR-vs-OS');
console.log('-----------------------------------------------------------------------------------------------------------------------------------');

for (const [loc, { name, target, flagged }] of Object.entries(SITES)) {
  const [rr, os] = await Promise.all([
    callReport('RentRoll', loc, start, now),
    callReport('OccupancyStatistics', loc, start, now),
  ]);

  const occRows = rr.rows.filter((r) => yes(r.bRented));
  const rrArea = occRows.reduce((a, r) => a + num(r, 'Area', 'Area1'), 0);
  const rrStd = occRows.reduce((a, r) => a + num(r, 'dcStdRate'), 0);
  const rrRate = rrArea ? +((rrStd / rrArea) * 12).toFixed(2) : 0;

  const osArea = os.rows.reduce((a, r) => a + num(r, 'Area') * num(r, 'Occupied'), 0);
  const osGross = os.rows.reduce((a, r) => a + num(r, 'GrossOccupied'), 0);
  const osRate = osArea ? +((osGross / osArea) * 12).toFixed(2) : 0;

  const pct = (v) => (target ? (((v - target) / target) * 100).toFixed(1) + '%' : 'n/a');
  const rrVsOs = osRate ? (((rrRate - osRate) / osRate) * 100).toFixed(1) + '%' : 'n/a';

  console.log(`${loc}  ${name.padEnd(20)}  £${String(target).padEnd(7)} £${String(rrRate).padEnd(21)} £${String(osRate).padEnd(23)} ${pct(rrRate).padEnd(14)} ${pct(osRate).padEnd(14)} ${rrVsOs}  ${flagged ? '[FLAGGED]' : '[control]'}`);
}

console.log('\nHow to read this: if RR-vs-OS is small (the two SiteLink reports agree with each other) but both RR-vs-Target');
console.log('and OS-vs-Target are large for flagged sites, the target figures are the most likely explanation, not our code.');
console.log('If RR-vs-OS is itself large for flagged sites, SiteLink\'s own two reports disagree on those specific sites --');
console.log('a live SiteLink-side data question, worth raising with SiteLink/ops rather than a portal code fix.');
process.exit(0);
