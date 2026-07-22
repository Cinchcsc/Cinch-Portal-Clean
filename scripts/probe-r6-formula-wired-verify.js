// VERIFY (22 Jul 2026), task #308. probe-r6-formula-preview.js confirmed R6's formula against RAW
// SOAP rows directly. This is a DIFFERENT, narrower check: does it still match once pulled through the
// ACTUAL reportMap.js parsers (rent_roll's unitRows/ledgerId/area_sum, the new billing_frequency
// report) and the ACTUAL recordFor() logic just wired into lib/buildPayload.js? That closes the gap
// between "the formula is right" and "the wiring reads the right fields correctly" — a field-name typo
// or shape mismatch between reportMap.js's output and buildPayload.js's input wouldn't show up in the
// original probe (which used raw rows), only here.
//
// This DUPLICATES recordFor()'s new rate/ssRate block verbatim (recordFor isn't exported) rather than
// re-deriving the formula, specifically so this test can catch a copy-paste/wiring mistake rather than
// re-confirming the math is sound (already done).
//
// Run:  node --env-file=.env scripts/probe-r6-formula-wired-verify.js [siteCode]
import { pullReport } from '../lib/reportMap.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-r6-formula-wired-verify.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

console.log(`Site: ${site}   Month: ${start.toISOString().slice(0, 7)}\n`);

// Pull through the ACTUAL reportMap.js dispatch/parse path, exactly as lib/pull.js does.
const rr = await pullReport('rent_roll', site, start, now);
const bf = await pullReport('billing_frequency', site, start, now);

console.log(`rent_roll: ${rr.unit_rows.length} unit_rows, area_sum=${rr.area_sum}, ss.area_sum=${rr.self_storage.area_sum}`);
console.log(`billing_frequency: ${Object.keys(bf.by_ledger).length} ledger(s) in by_ledger\n`);

// === Verbatim copy of recordFor()'s new logic (lib/buildPayload.js) ===
const isSelfStorageUnit = (t) => String(t || '').toLowerCase().includes('self storage');
const bfByLedger = bf.by_ledger || {};
const hasBillingFreq = Object.keys(bfByLedger).length > 0;
const unitRowsForRate = rr.unit_rows || [];
const canAdjustRate = hasBillingFreq && unitRowsForRate.length > 0;
const billingAdjustedRentSum = (filterFn) => {
  let numer = 0;
  for (const u of unitRowsForRate) {
    if (!filterFn(u)) continue;
    const freqDesc = bfByLedger[u.ledgerId];
    const factor = freqDesc && /28/.test(freqDesc) ? 1.0833 : 1;
    numer += (u.rent || 0) * factor;
  }
  return numer;
};
const adjRentSum = canAdjustRate ? R2(billingAdjustedRentSum(() => true)) : (rr.std_rent_sum || 0);
const ssAdjRentSum = canAdjustRate ? R2(billingAdjustedRentSum((u) => isSelfStorageUnit(u.type))) : ((rr.self_storage && rr.self_storage.std_rent_sum) || 0);
const rate = (rr.area_sum || 0) ? R2(adjRentSum / rr.area_sum * 12) : 0;
const ssRate = ((rr.self_storage && rr.self_storage.area_sum) || 0) ? R2(ssAdjRentSum / rr.self_storage.area_sum * 12) : 0;
// === end verbatim copy ===

console.log(`canAdjustRate: ${canAdjustRate} (hasBillingFreq=${hasBillingFreq}, unitRows=${unitRowsForRate.length})`);
console.log(`adjRentSum: ${adjRentSum}   ssAdjRentSum: ${ssAdjRentSum}\n`);
console.log(`WIRED Rate (Total):        £${rate} per sqft`);
console.log(`WIRED Rate (Self Storage): £${ssRate} per sqft\n`);
console.log('=== Legacy reference (screenshot, Jul 2026) ===');
console.log('Bicester Rate:  Self Storage £29.87   Total £28.44');
console.log(`\n${Math.abs(rate - 28.44) < 0.01 && Math.abs(ssRate - 29.87) < 0.01 ? 'MATCH (within a penny) — wiring confirmed faithful to the validated formula.' : 'MISMATCH — investigate before trusting the wired code.'}`);
process.exit(0);
