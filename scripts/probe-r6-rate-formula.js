// PROBE (22 Jul 2026), task #308 — R6 gave Michael the definitive Rate/Real Rate formula today:
//   Rate per sqft      = (Rent ÷ Area) × 12
//   Real Rate per sqft = (Effective Rent ÷ Area) × 12
//   Rent = billing-adjusted rental rate — Bill28Days (4-weekly-billed) tenants have their rent
//     multiplied by 1.0833 to normalise to a calendar month. Billing frequency is RentRoll's
//     sBillingFreq column.
//   Effective Rent = Rental Rate (same billing-adjusted figure as Rent above) − Credits − Discounts.
//     Credits = Fin_CreditsIssued, excluding rows noted "Rent: Write Off Bad Debt".
//     Discounts = Mgmt_Discounts, excluding "Non-Expiring" plan terms (only time-limited plans
//     subtract).
//
// This is a materially different recipe than task #87's True-Revenue/TruePeriod-based Real Rate
// (still live today) — no TruePeriod anywhere in R6's answer. Before rewriting reportMap.js/
// buildPayload.js to match, four things need confirming against real, live data (none of this is
// in the codebase yet, checked via grep first):
//
//  1. Does sBillingFreq exist on RentRoll, what values does it take, how many tenants are on it?
//     (probe-rentroll-billing-cycle.js checked STORED data for a billing-cycle field on 20 Jul,
//     before the exact column name was confirmed, and found none of the obvious candidates — this
//     checks fresh/live now that we know the literal name to look for.)
//  2. WHICH RentRoll field is R6's "Rent"? Two candidates already live in this codebase for
//     different purposes: dcRent ("tenant's actual currently-billed amount" — today powers our
//     "Real Rate, no concession") vs dcStdRate ("site's current standard rate" — today powers our
//     "Rate, with concessions"). R6's Real Rate SUBTRACTS credits/discounts from Rent to reach
//     Effective Rent — that only makes arithmetic sense if Rent is the GROSS/standard figure
//     (dcStdRate), because subtracting discounts from an already-net dcRent would double-count
//     them. This computes Rate BOTH ways (with the billing adjustment applied to both) so real
//     numbers settle it instead of a guess.
//  3. Does Discounts' raw response carry a plan-TERM/expiry field, so "Non-Expiring" plans can be
//     told apart from time-limited ones? Our existing discounts parser only ever reads
//     sConcessionPlan/dcDiscount/sUnitName — nothing needed a term field before.
//  4. What real report is "Fin_CreditsIssued"? No method by that exact name exists on either WSDL
//     (confirmed against the full 63+292 method dump from task #400). Checking the two most likely
//     candidates: FinancialSummary (already integrated, has a raw Credit column already, but no
//     per-transaction note text) and ChargesAndPaymentsComplete (not yet integrated — sounds like
//     the transaction-level ledger that would carry a per-line note like "Rent: Write Off Bad Debt").
//
// Run:  node --env-file=.env scripts/probe-r6-rate-formula.js [siteCode]
import { callReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-r6-rate-formula.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const rate = (n, a) => (a ? R2((n / a) * 12) : 0);

console.log(`Site: ${site}   Month: ${start.toISOString().slice(0, 7)}`);

// --- 1 & 2: RentRoll — sBillingFreq + dual Rate computation ---
console.log('\n=== RentRoll ===');
const { rows: rrRows } = await callReport('RentRoll', site, start, now);
console.log(`${rrRows.length} rows.`);
if (rrRows[0]) console.log('Columns:', Object.keys(rrRows[0]).join(', '));
const freqCol = rrRows[0] && 'sBillingFreq' in rrRows[0];
console.log(freqCol ? 'sBillingFreq IS present.' : 'sBillingFreq NOT found on this live response.');
if (freqCol) {
  const dist = {};
  for (const r of rrRows) { const v = String(r.sBillingFreq ?? '(blank)'); dist[v] = (dist[v] || 0) + 1; }
  console.log('Value distribution (all rows):', JSON.stringify(dist));
}
const is28 = (r) => freqCol && /28|four.?week|4.?week/i.test(String(r.sBillingFreq ?? ''));
let areaSum = 0, dcRentSum = 0, dcRentAdjSum = 0, stdRateSum = 0, stdRateAdjSum = 0, adjustedCount = 0, occCount = 0;
for (const r of rrRows) {
  if (!yes(r.bRented)) continue;
  occCount++;
  const a = num(r.Area ?? r.Area1);
  const adj = is28(r) ? 1.0833 : 1;
  if (adj !== 1) adjustedCount++;
  areaSum += a;
  dcRentSum += num(r.dcRent);
  dcRentAdjSum += num(r.dcRent) * adj;
  stdRateSum += num(r.dcStdRate);
  stdRateAdjSum += num(r.dcStdRate) * adj;
}
console.log(`\nOccupied units: ${occCount}, total area ${R2(areaSum)}, ${adjustedCount} flagged 4-weekly.`);
console.log(`Rate candidate A — dcRent basis:    unadjusted ${rate(dcRentSum, areaSum)}   billing-adjusted ${rate(dcRentAdjSum, areaSum)}`);
console.log(`Rate candidate B — dcStdRate basis: unadjusted ${rate(stdRateSum, areaSum)}   billing-adjusted ${rate(stdRateAdjSum, areaSum)}`);

// --- 3: Discounts — full columns, look for a term/expiry field ---
console.log('\n=== Discounts (Mgmt_Discounts?) ===');
const { rows: discRows } = await callReport('Discounts', site, start, now);
console.log(`${discRows.length} rows.`);
if (discRows[0]) {
  console.log('Columns:', Object.keys(discRows[0]).join(', '));
  const termLike = Object.keys(discRows[0]).filter((k) => /term|expir|non.?exp|duration|end.?date/i.test(k));
  console.log(termLike.length ? `Possible term/expiry columns: ${termLike.join(', ')}` : 'No obviously-named term/expiry column found.');
  for (const k of termLike) {
    const dist = {};
    for (const r of discRows) { const v = String(r[k] ?? '(blank)'); dist[v] = (dist[v] || 0) + 1; }
    console.log(`  ${k} distribution:`, JSON.stringify(dist));
  }
}

// --- 4: Credits — FinancialSummary (already integrated) + ChargesAndPaymentsComplete (candidate) ---
console.log('\n=== FinancialSummary (already-integrated Credit column) ===');
const { rows: finRows } = await callReport('FinancialSummary', site, start, now);
console.log(`${finRows.length} rows.`);
if (finRows[0]) console.log('Columns:', Object.keys(finRows[0]).join(', '));
const creditRows = finRows.filter((r) => num(r.Credit) !== 0);
console.log(`${creditRows.length} row(s) with non-zero Credit.`);
if (creditRows[0]) console.log('Sample credit row:', JSON.stringify(creditRows[0]).slice(0, 500));

console.log('\n=== ChargesAndPaymentsComplete (candidate for Fin_CreditsIssued) ===');
try {
  const { rows: capRows } = await callReport('ChargesAndPaymentsComplete', site, start, now);
  console.log(`${capRows.length} rows.`);
  if (capRows[0]) {
    console.log('Columns:', Object.keys(capRows[0]).join(', '));
    const noteLike = Object.keys(capRows[0]).filter((k) => /note|memo|desc|reason/i.test(k));
    console.log(noteLike.length ? `Possible note/memo columns: ${noteLike.join(', ')}` : 'No obvious note/memo column.');
    for (const k of noteLike) {
      const writeOffRows = capRows.filter((r) => /write.?off|bad.?debt/i.test(String(r[k] ?? '')));
      console.log(`  ${k}: ${writeOffRows.length} row(s) matching "write off"/"bad debt".`);
    }
    console.log('Sample row:', JSON.stringify(capRows[0]).slice(0, 700));
  }
} catch (e) {
  console.log('ChargesAndPaymentsComplete call failed:', e.message);
}
process.exit(0);
