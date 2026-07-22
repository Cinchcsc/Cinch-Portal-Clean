// PROBE (22 Jul 2026), task #308/#403 — follow-up to probe-truerevenue-rentonly.js. Michael: "needs to
// be exact... near is unacceptable." Rent-only TruePeriod got Total to £18.06 (£0.60 / 3.22% under
// legacy's £18.66) and Self Storage to £18.62 (£0.04 off — essentially exact). Since SS alone is almost
// perfect but blending in Drive Up/Enterprise/Mailbox/Office drags Total down, the remaining gap is
// concentrated in those 4 smaller categories, not spread evenly — worth finding out which one(s),
// rather than accepting "close" for Total.
//
// reportMap.js's rent_roll parser tracks total-area-incl-vacant (totalAreaAllUnits) only as ONE
// portfolio-wide scalar, not broken out per unit type — so this pulls RAW RentRoll rows directly (same
// safe, already-established callReport() mechanism, just reading the untouched rows instead of going
// through the parser) and sums Area per sTypeName for EVERY row (rented and vacant), to get the total
// area denominator for each of the 5 types seen in True Revenue's Table1 (Drive Up, Enterprise, Indoor
// Self Storage, Mailbox, Office). Combined with the already-established Rent-only TruePeriod per type
// (re-pulled fresh here, not copied from the last run, to rule out any minute-to-minute drift in this
// live MTD figure), this gives a genuine per-type Real Rate breakdown, plus tests every plausible
// include/exclude combination against legacy's £18.66 looking for an EXACT hit before touching any live
// code.
//
// Run:  node --env-file=.env scripts/probe-truerevenue-rentonly-bytype.js [siteCode]
import { callReport, callCustomReport, extractNamedTable } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-truerevenue-rentonly-bytype.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const legacy = 18.66;

console.log(`Site: ${site}\n`);

// Raw RentRoll rows -- EVERY row (rented + vacant), not filtered, to get total area per type.
const { rows: rrRows } = await callReport('RentRoll', site, start, now);
const areaByType = {};
for (const r of rrRows) {
  const t = String(r.sTypeName || 'Other').trim();
  areaByType[t] = (areaByType[t] || 0) + num(r.Area ?? r.Area1);
}
console.log(`RentRoll: ${rrRows.length} total row(s) (rented + vacant).`);
console.log('Total area (incl. vacant) by sTypeName:');
for (const [t, a] of Object.entries(areaByType)) console.log(`  ${t}: ${R2(a)} sqft`);
const totalAreaAll = Object.values(areaByType).reduce((a, v) => a + v, 0);
console.log(`  TOTAL: ${R2(totalAreaAll)} sqft\n`);

// Raw True Revenue Table1 rows -- same extraction as reportMap.js's true_revenue parser.
const { raw } = await callCustomReport(781861, site, start, now);
const trRows = extractNamedTable(raw, 'Table1');
const rentRows = trRows.filter((r) => /rent/i.test(r.ChargeDesc || ''));
const rentByType = {};
for (const r of rentRows) {
  const t = String(r.UnitType || 'Other').trim();
  rentByType[t] = (rentByType[t] || 0) + num(r.TruePeriod);
}
console.log('Σ TruePeriod (ChargeDesc=Rent only) by UnitType:');
for (const [t, v] of Object.entries(rentByType)) console.log(`  ${t}: £${R2(v)}`);
console.log('');

// Per-type Real Rate (Rent-only numerator ÷ that type's own total area × 12).
console.log(`${'='.repeat(70)}\nPer-type Real Rate (Rent-only numerator ÷ that type's total area × 12)\n${'='.repeat(70)}`);
const allTypes = new Set([...Object.keys(areaByType), ...Object.keys(rentByType)]);
for (const t of allTypes) {
  const rent = rentByType[t] || 0, area = areaByType[t] || 0;
  console.log(`  ${t}: £${R2(rent)} / ${R2(area)} sqft × 12 = £${area ? R2(rent / area * 12) : 0}/sqft/yr`);
}

// Test every plausible include/exclude combination against legacy's £18.66, looking for an exact hit.
console.log(`\n${'='.repeat(70)}\nCombination tests vs legacy £${legacy}\n${'='.repeat(70)}`);
const isSS = (t) => /self.?storage/i.test(t);
const isStorageLike = (t) => isSS(t) || /drive.?up|enterprise/i.test(t);
const combos = {
  'All 5 types (Total, as tested)': (t) => true,
  'Storage-like only (SS + Drive Up + Enterprise)': (t) => isStorageLike(t),
  'Self Storage only': (t) => isSS(t),
  'Self Storage + Drive Up': (t) => isSS(t) || /drive.?up/i.test(t),
  'Self Storage + Enterprise': (t) => isSS(t) || /enterprise/i.test(t),
  'Everything except Office': (t) => !/office/i.test(t),
  'Everything except Mailbox': (t) => !/mailbox/i.test(t),
  'Everything except Office and Mailbox': (t) => !/office/i.test(t) && !/mailbox/i.test(t),
};
for (const [label, filterFn] of Object.entries(combos)) {
  const types = [...allTypes].filter(filterFn);
  const rent = types.reduce((a, t) => a + (rentByType[t] || 0), 0);
  const area = types.reduce((a, t) => a + (areaByType[t] || 0), 0);
  const r = area ? R2(rent / area * 12) : 0;
  const gap = R2(r - legacy);
  console.log(`  ${label}: £${R2(rent)} / ${R2(area)} = £${r}/sqft/yr   gap £${gap} (${R2(gap / legacy * 100)}%)${Math.abs(gap) < 0.005 ? '  <<< EXACT MATCH' : ''}`);
}
process.exit(0);
