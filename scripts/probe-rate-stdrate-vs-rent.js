// Task #228, third follow-up. Ruled out so far: our code (RentRoll and OccupancyStatistics agree
// with each other), stale targets (today's live legacy figure matches the 5-day-old target closely),
// unit-type dilution (Brighton's blended rate = its own pure Self Storage rate, 98% of its area), and
// a handful of bad-area outlier units (probe-rate-unit-outliers.js: excluding outliers barely moves
// the number -- it's a broad, site-wide shift, not a few bad rows).
//
// New angle: the "Rate" widget (Σ dcStdRate ÷ Σ area × 12) runs 7-46% high on flagged sites, but the
// SEPARATE "Real Rate" widget for the SAME sites (Σ TruePeriod ÷ Σ total area × annualize, from the
// True Revenue custom report -- a totally different field, totally different report) tracks legacy
// much more closely (Brighton: +8.7%, not +46%). dcStdRate is the unit's "standard/asking rate";
// dcRent is what the tenant is ACTUALLY billed each month (can run below dcStdRate under a
// concession/promotion, confirmed in reportMap.js's rent_roll parser comment). This checks whether
// dcStdRate and dcRent have diverged MUCH more sharply at flagged sites than at controls -- i.e.
// whether flagged sites have a lot of occupied units billed well below their own posted "standard"
// rate (unusually deep/widespread concessions), which would make dcStdRate a poor proxy for what
// legacy's Rate widget actually reflects, without it being a bug in how we read either field.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-rate-stdrate-vs-rent.js
import { callReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-rate-stdrate-vs-rent] ' + lock.message); process.exit(1); }

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

console.log('Site  Name                  Target   dcStdRate-Rate  dcRent-Rate   StdRate-vs-Target  Rent-vs-Target  %Units Below Std  Avg Discount % (below-std units only)');
console.log('-'.repeat(140));

for (const [loc, { name, target, flagged }] of Object.entries(SITES)) {
  const { rows } = await callReport('RentRoll', loc, start, now);
  const occ = rows.filter((r) => yes(r.bRented));

  let area = 0, stdRent = 0, rent = 0, belowStdCount = 0, belowStdDiscountPctSum = 0;
  for (const r of occ) {
    const a = num(r, 'Area', 'Area1'), std = num(r, 'dcStdRate'), rn = num(r, 'dcRent');
    area += a; stdRent += std; rent += rn;
    if (std > 0 && rn < std) { belowStdCount++; belowStdDiscountPctSum += ((std - rn) / std) * 100; }
  }
  const stdRate = area ? +((stdRent / area) * 12).toFixed(2) : 0;
  const rentRate = area ? +((rent / area) * 12).toFixed(2) : 0;
  const stdDiff = target ? (((stdRate - target) / target) * 100).toFixed(1) : 'n/a';
  const rentDiff = target ? (((rentRate - target) / target) * 100).toFixed(1) : 'n/a';
  const pctBelow = occ.length ? ((belowStdCount / occ.length) * 100).toFixed(1) : '0.0';
  const avgDiscount = belowStdCount ? (belowStdDiscountPctSum / belowStdCount).toFixed(1) : '0.0';

  console.log(
    `${loc}  ${name.padEnd(20)}  £${String(target).padEnd(6)} £${String(stdRate).padEnd(13)} £${String(rentRate).padEnd(11)} ${(stdDiff + '%').padEnd(18)} ${(rentDiff + '%').padEnd(15)} ${(pctBelow + '%').padEnd(17)} ${avgDiscount}%  ${flagged ? '[FLAGGED]' : '[control]'}`
  );
}
console.log('\nIf flagged sites show a much higher "%Units Below Std" and/or "Avg Discount %" than controls, that means a lot of');
console.log('their occupied units are billed well under their own posted standard rate -- dcStdRate (posted/asking rate) would');
console.log('then genuinely overstate what tenants are paying, and legacy\'s Rate widget may reflect something closer to actual');
console.log('billed amounts (dcRent) than posted standard rates, at least for these specific sites.');
process.exit(0);
