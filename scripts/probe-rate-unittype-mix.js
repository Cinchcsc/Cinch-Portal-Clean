// Task #228 follow-up. probe-rate-crosscheck-occstats.js just proved RentRoll and
// OccupancyStatistics -- two completely independently-coded SiteLink reports -- agree with each
// other to within 0.7% on every flagged site (Brighton 46.3% vs 46.1%, Huntingdon 23.3% vs 23.3%,
// etc). That rules out a bug in how OUR code reads or sums either report, and rules out the
// hardcoded "target" being stale (today's live legacy portal number is within ~1% of the 5-day-old
// target for every site checked). So the gap is real and SiteLink-side -- the only remaining
// question is WHY: is Total Rate/Self Storage Rate on the legacy portal scoped to fewer unit types
// than what our code sums (all.area/all.stdRent — literally every sTypeName)? This dumps RentRoll's
// occupied units grouped by sTypeName for one FLAGGED site (Brighton, 46% over) and one CONTROL site
// (Bicester, 5.5% over) side by side. If Brighton has a much bigger share of its occupied area/rent
// sitting in non-core categories (Enterprise/Parking/Bulk/Trade Counter/Value Unit/etc, the same
// unusual categories seen in the True Revenue Unit Types breakdown) than Bicester does, that's the
// likely explanation -- legacy's Rate widgets may only cover core storage types, not every category
// SiteLink tracks under this site's RentRoll.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-rate-unittype-mix.js
import { callReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-rate-unittype-mix] ' + lock.message); process.exit(1); }

const num = (row, ...keys) => {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== '') {
      const n = Number(String(row[k]).replace(/[£,%\s]/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
};
const str = (v) => (v == null ? '' : String(v)).trim();
const yes = (v) => v === true || v === 'true' || v === 1 || v === '1';

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

const SITES = { L005: 'Brighton (FLAGGED, +46%)', L001: 'Bicester (control, +5.5%)' };

for (const [loc, label] of Object.entries(SITES)) {
  const { rows } = await callReport('RentRoll', loc, start, now);
  const occ = rows.filter((r) => yes(r.bRented));
  const byType = {};
  for (const r of occ) {
    const t = str(r.sTypeName) || 'Other';
    const o = (byType[t] ??= { units: 0, area: 0, stdRent: 0 });
    o.units++; o.area += num(r, 'Area', 'Area1'); o.stdRent += num(r, 'dcStdRate');
  }
  const totalArea = occ.reduce((a, r) => a + num(r, 'Area', 'Area1'), 0);
  const totalStdRent = occ.reduce((a, r) => a + num(r, 'dcStdRate'), 0);
  console.log(`\n=== ${loc} ${label} — ${occ.length} occupied units, blended rate £${((totalStdRent / totalArea) * 12).toFixed(2)}/ft² ===`);
  console.log('Type'.padEnd(20) + 'Units'.padEnd(8) + 'Area'.padEnd(10) + '% of Area'.padEnd(11) + 'Rate £/ft²/yr');
  const sorted = Object.entries(byType).sort((a, b) => b[1].area - a[1].area);
  for (const [t, o] of sorted) {
    const rate = o.area ? (o.stdRent / o.area * 12).toFixed(2) : '0.00';
    const pctArea = ((o.area / totalArea) * 100).toFixed(1);
    console.log(t.padEnd(20) + String(o.units).padEnd(8) + Math.round(o.area).toString().padEnd(10) + (pctArea + '%').padEnd(11) + '£' + rate);
  }
  // Recompute the blended rate EXCLUDING everything except types containing "self storage" or "drive up" or "office" —
  // the 3 categories that show up as distinct legacy widgets (Self Storage, Offices) or are clearly core storage.
  const coreTypes = sorted.filter(([t]) => /self.?storage|drive.?up|office/i.test(t));
  const coreArea = coreTypes.reduce((a, [, o]) => a + o.area, 0);
  const coreStdRent = coreTypes.reduce((a, [, o]) => a + o.stdRent, 0);
  console.log(`  If scoped to ONLY self-storage/drive-up/office types: £${coreArea ? (coreStdRent / coreArea * 12).toFixed(2) : '0.00'}/ft² (${coreTypes.map(([t]) => t).join(', ')})`);
}
process.exit(0);
