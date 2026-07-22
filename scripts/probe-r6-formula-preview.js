// PROBE (22 Jul 2026), task #308. Preview R6's Rate/Real Rate formula against legacy's reference
// numbers BEFORE wiring anything into reportMap.js/buildPayload.js. Legacy screenshot for Bicester
// (Jul 2026): Rate £29.87 (Self Storage) / £28.44 (Total); Real Rate £19.50 (SS) / £18.66 (Total);
// Effective Rate £25.50 (extra cross-check only, not being added to the new portal, per Michael).
//
// Now that the real billing-frequency field is known (ReportID 999824, LedgerID -> sBillingFreqDesc),
// this computes R6's formula properly:
//   Rate      = (Rent, billing-adjusted) / Area * 12
//   Real Rate = (Rent, billing-adjusted, minus time-limited Discounts) / Area * 12
//     -- Credits (Fin_CreditsIssued) still has no known source, so this Real Rate is a PARTIAL
//     figure (adjusted rent minus discounts only) -- expect it to run somewhat HIGH vs the true
//     formula until Credits are found, since a real subtraction is still missing.
//
// "Rent" is computed BOTH candidate ways (dcStdRate and dcRent) since that's still unconfirmed --
// legacy's real numbers should settle which basis is actually right. Both are also split Self-
// Storage-only (sTypeName === 'Indoor Self Storage') vs Total (every occupied type), matching the
// two columns in the legacy screenshot.
//
// Prints the exact date range used, since every probe this session has said "2026-06" despite today
// being 22 July -- worth confirming this actually matches the "Jul 2026" legacy screenshot before
// treating any of this as a real comparison.
//
// Run:  node --env-file=.env scripts/probe-r6-formula-preview.js [siteCode]
import { callReport, callCustomReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-r6-formula-preview.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const rate = (n, a) => (a ? R2((n / a) * 12) : 0);
const BILLING_FREQ_REPORT_ID = 999824;

console.log(`Site: ${site}`);
console.log(`Date range used for this pull: ${start.toISOString()} to ${now.toISOString()} (${start.toISOString().slice(0, 7)})`);
console.log(`Legacy screenshot is labelled "Jul 2026" -- compare against the month printed above before trusting this comparison.\n`);

// === Pull the three inputs ===
const { rows: rrRows } = await callReport('RentRoll', site, start, now);
const occ = rrRows.filter((r) => yes(r.bRented));
console.log(`RentRoll: ${occ.length} occupied units.`);

const { rows: bfRows } = await callCustomReport(BILLING_FREQ_REPORT_ID, site, start, now);
const freqMap = new Map();
for (const r of bfRows) freqMap.set(String(r.LedgerID), String(r.sBillingFreqDesc ?? ''));
console.log(`Billing frequency report: ${bfRows.length} row(s).`);

const { rows: discRows } = await callReport('Discounts', site, start, now);
const discountMap = new Map(); // sUnitName -> total time-limited discount
let discRowsUsed = 0, discRowsExcludedNonExpiring = 0;
for (const r of discRows) {
  if (String(r.sChgDesc ?? '').toLowerCase() !== 'rent') continue;
  const timeLimited = r.sPlanTerm != null && String(r.sPlanTerm).trim() !== '';
  if (!timeLimited) { discRowsExcludedNonExpiring++; continue; }
  discRowsUsed++;
  const key = r.sUnitName;
  discountMap.set(key, (discountMap.get(key) || 0) + num(r.dcDiscount));
}
console.log(`Discounts: ${discRows.length} row(s) total, ${discRowsUsed} time-limited Rent discount(s) used, ${discRowsExcludedNonExpiring} non-expiring/other excluded.\n`);

function computeFor(basisField, typeFilterFn, label) {
  let area = 0, rentUnadj = 0, rentAdj = 0, effRent = 0, adjustedCount = 0, noFreqCount = 0, discountTotal = 0, n = 0;
  for (const r of occ) {
    if (!typeFilterFn(r)) continue;
    n++;
    const a = num(r.Area);
    area += a;
    const base = num(r[basisField]);
    rentUnadj += base;
    const freqDesc = freqMap.get(String(r.LedgerID));
    if (freqDesc == null) noFreqCount++;
    const factor = freqDesc && /28/.test(freqDesc) ? 1.0833 : 1;
    if (factor !== 1) adjustedCount++;
    const adjBase = base * factor;
    rentAdj += adjBase;
    const disc = discountMap.get(r.sUnitName) || 0;
    discountTotal += disc;
    effRent += (adjBase - disc);
  }
  console.log(`--- ${label} (basis: ${basisField}) ---`);
  console.log(`  ${n} units, ${adjustedCount} billing-adjusted (28-day), ${noFreqCount} missing a frequency label, total area ${R2(area)}, total time-limited discount £${R2(discountTotal)}`);
  console.log(`  Rate (unadjusted, current-style):     £${rate(rentUnadj, area)} per sqft`);
  console.log(`  Rate (R6, billing-adjusted):          £${rate(rentAdj, area)} per sqft`);
  console.log(`  Real Rate (R6, adj minus discounts, Credits NOT yet included -- partial):  £${rate(effRent, area)} per sqft`);
  console.log('');
}

const isSelfStorage = (r) => r.sTypeName === 'Indoor Self Storage';
const isAny = () => true;

for (const basis of ['dcStdRate', 'dcRent']) {
  computeFor(basis, isSelfStorage, 'Self Storage only');
  computeFor(basis, isAny, 'Total (all occupied types)');
}

console.log('=== Legacy reference (from screenshot, Jul 2026) ===');
console.log('Bicester Rate:       Self Storage £29.87   Total £28.44');
console.log('Bicester Real Rate:  Self Storage £19.50   Total £18.66');
console.log('Bicester Effective Rate (extra cross-check, not being built into new portal): £25.50');
process.exit(0);
