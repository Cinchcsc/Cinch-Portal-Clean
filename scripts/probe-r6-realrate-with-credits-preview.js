// PREVIEW (22 Jul 2026), task #308/#403. Full Real Rate test now that Credits has two real candidates:
// CorpReportID 460636 ("Adjustments for MoveOuts and Waived Charges") + 460635 ("Adjustments for
// Refunds Due"). Earlier probes computed pieces in isolation with DIFFERENT area denominators (the
// original probe-r6-formula-preview.js's ad-hoc Real Rate used OCCUPIED area, matching Rate -- but the
// codebase's actual, already-established Real Rate convention divides by TOTAL area INCLUDING VACANT
// units, per reportMap.js's own long-standing comment: "Real Rate divides by TOTAL area... NOT areaSum
// (occupied-only)"). Comparing a £/sqft/yr "gap" computed one way against a raw £ sum computed another
// risks a wrong conclusion, so this redoes the WHOLE Real Rate calc in one place, with the CORRECT
// total-area-incl-vacant denominator throughout, so the comparison against legacy is apples-to-apples.
//
// Computes Real Rate three ways for direct comparison:
//   1. No Credits (adjRent - Discounts only) -- the already-known-incomplete partial figure.
//   2. Credits = Rent-only waived charges + Rent-only refunds (ChargeDesc/Category = "Rent").
//   3. Credits = ALL categories (Rent + StoreProtect + Fees + Padlock, waived charges + refunds) --
//      worth testing because GeneralJournalEntries' OWN "Credits Issued" bucket (task #403's first
//      finding) ALSO mixed Rent + Insurance + Fee waivers together, suggesting SiteLink's own concept
//      of "Credits Issued" may not be Rent-scoped at all.
//
// All three use the SAME billing-adjusted Rent numerator (matching the now-CONFIRMED, exact-match Rate
// formula) and the SAME Discounts treatment (time-limited plans only) already established. Everything
// is annualized with the same "blind x12" convention already confirmed to match legacy's own math
// (Michael, 10 Jul 2026) -- Credits/Discounts get the same treatment as Rent, no special-casing.
//
// Total only for now (not Self Storage-split) -- a SS split would need joining Credits/Discounts back
// to RentRoll's per-unit sTypeName by LedgerID, worth doing only if the Total figure looks promising.
//
// Run:  node --env-file=.env scripts/probe-r6-realrate-with-credits-preview.js [siteCode]
import { callReport, callCustomReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-r6-realrate-with-credits-preview.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const rate = (n, a) => (a ? R2((n / a) * 12) : 0);
const isRent = (v) => /rent/i.test(String(v ?? ''));

console.log(`Site: ${site}   Date range: ${start.toISOString()} to ${now.toISOString()}\n`);

// === Pull everything ===
const { rows: rrRows } = await callReport('RentRoll', site, start, now);
const { rows: bfRows } = await callCustomReport(999824, site, start, now);
const { rows: discRows } = await callReport('Discounts', site, start, now);
const { rows: waivedRows } = await callCustomReport(460636, site, start, now);
const { rows: refundRows } = await callCustomReport(460635, site, start, now);

console.log(`RentRoll: ${rrRows.length} total row(s).`);
console.log(`Billing frequency: ${bfRows.length} row(s).`);
console.log(`Discounts: ${discRows.length} row(s).`);
console.log(`Waived charges: ${waivedRows.length} row(s).`);
console.log(`Refunds: ${refundRows.length} row(s).\n`);

// === Total area, INCLUDING vacant units -- the correct Real Rate denominator (NOT occupied area) ===
let totalAreaAllUnits = 0;
for (const r of rrRows) totalAreaAllUnits += num(r.Area);
console.log(`Total area (all units, incl. vacant): ${R2(totalAreaAllUnits)} sqft`);

// === Billing-adjusted Rent (the now-confirmed, exact-match Rate numerator) ===
const freqMap = new Map();
for (const r of bfRows) freqMap.set(String(r.LedgerID), String(r.sBillingFreqDesc ?? ''));
const occ = rrRows.filter((r) => yes(r.bRented));
let adjRentSum = 0;
for (const r of occ) {
  const base = num(r.dcRent);
  const freqDesc = freqMap.get(String(r.LedgerID));
  const factor = freqDesc && /28/.test(freqDesc) ? 1.0833 : 1;
  adjRentSum += base * factor;
}
console.log(`Billing-adjusted Rent sum (occupied units): £${R2(adjRentSum)}`);

// === Discounts: time-limited plans only (already-established convention) ===
let discountTotal = 0, discRowsUsed = 0;
for (const r of discRows) {
  if (String(r.sChgDesc ?? '').toLowerCase() !== 'rent') continue;
  const timeLimited = r.sPlanTerm != null && String(r.sPlanTerm).trim() !== '';
  if (!timeLimited) continue;
  discRowsUsed++;
  discountTotal += num(r.dcDiscount);
}
console.log(`Discounts (time-limited Rent plans only): £${R2(discountTotal)} (${discRowsUsed} row(s) used)`);

// === Credits: two interpretations ===
let creditsWaivedRent = 0, creditsWaivedAll = 0;
for (const r of waivedRows) {
  const amt = num(r.Charge);
  creditsWaivedAll += amt;
  if (isRent(r.ChargeDesc)) creditsWaivedRent += amt;
}
let creditsRefundRent = 0, creditsRefundAll = 0;
for (const r of refundRows) {
  const amt = num(r.RefundAmt);
  creditsRefundAll += amt;
  if (isRent(r.Category)) creditsRefundRent += amt;
}
const creditsRentOnly = R2(creditsWaivedRent + creditsRefundRent);
const creditsAllCategories = R2(creditsWaivedAll + creditsRefundAll);
console.log(`Credits (Rent-only: waived + refunds): £${creditsRentOnly}`);
console.log(`Credits (ALL categories: waived + refunds): £${creditsAllCategories}\n`);

// === Real Rate, three ways, all using the SAME total-area denominator ===
const realRate_noCredits = rate(adjRentSum - discountTotal, totalAreaAllUnits);
const realRate_creditsRentOnly = rate(adjRentSum - discountTotal - creditsRentOnly, totalAreaAllUnits);
const realRate_creditsAll = rate(adjRentSum - discountTotal - creditsAllCategories, totalAreaAllUnits);

console.log('=== Real Rate (Total, all occupied types), £/sqft/yr ===');
console.log(`  No Credits (adjRent - Discounts only):           £${realRate_noCredits}`);
console.log(`  Credits = Rent-only waived+refunds:              £${realRate_creditsRentOnly}`);
console.log(`  Credits = ALL categories waived+refunds:         £${realRate_creditsAll}`);
console.log(`\n=== Legacy reference (screenshot, Jul 2026) ===`);
console.log(`  Bicester Real Rate, Total: £18.66`);

const target = 18.66;
console.log(`\n=== Distance from legacy (£18.66) ===`);
console.log(`  No Credits:        £${R2(realRate_noCredits - target)} off`);
console.log(`  Rent-only Credits: £${R2(realRate_creditsRentOnly - target)} off`);
console.log(`  All-category Credits: £${R2(realRate_creditsAll - target)} off`);
process.exit(0);
