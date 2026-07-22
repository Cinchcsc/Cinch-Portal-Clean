// PROBE (22 Jul 2026), task #308/#403 follow-up #3. Michael: "keep going." The Automate-reports check
// (previous commit) turned up something new: "Cinch Storage\All Unpaid Charges" (CorpReportID 821730)
// has an explicit CreditBalance column per ledger -- a STANDING BALANCE, not a flow-over-a-period sum
// like the waived-charges/refunds reports already tested. That's an important difference: dcRent
// itself is also a standing/snapshot value, so a standing CreditBalance would be the cleanest possible
// match for "Rent(adjusted) - Credits" -- no MTD-window-vs-snapshot timing mismatch to worry about at
// all. First 5 sample rows all showed CreditBalance=0.0000, but that report is scoped to ledgers with
// at least one currently-UNPAID charge -- tenants who are fully paid up (or sitting on a credit with no
// outstanding charge at all) might never appear in it, so a small non-zero sample isn't conclusive.
//
// Part 1: pulls 821730 in FULL and sums CreditBalance correctly -- this report is one row per unpaid
// CHARGE LINE, not per ledger, so the same ledger can appear many times with its CreditBalance repeated
// on every row. Summing blindly would multiply-count. This dedupes by LedgerID first.
//
// Part 2: CustomerAccountsBalanceDetailsWithPrepayment was already in the hand-vetted CallCenterWs
// allowlist from the earlier exhaustive sweep (called once, but never examined for Credits) -- its name
// literally mentions "Prepayment," another standing-balance concept (money paid in but not yet applied
// to a charge). Auto-discovers its real input param + output shape from a single tenant first, then
// loops every occupied tenant at the site (same safe, already-established per-ledger call pattern as
// ChargesAndPaymentsByLedgerID) and sums whatever credit/prepayment-shaped field it reveals.
//
// Run:  node --env-file=.env scripts/probe-credit-balance-fields.js [siteCode]
import { callReport, callCustomReport, callCallCenterMethod, describeCcws } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-credit-balance-fields.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

console.log(`Site: ${site}   Date range: ${start.toISOString()} to ${now.toISOString()}\n`);

// === Part 1: All Unpaid Charges -- dedupe by LedgerID, sum CreditBalance correctly ===
console.log(`${'='.repeat(70)}\nPart 1: Cinch Storage\\All Unpaid Charges (821730) -- deduped CreditBalance\n${'='.repeat(70)}`);
const { rows: unpaidRows } = await callCustomReport(821730, site, start, now);
console.log(`${unpaidRows.length} row(s) (per unpaid charge line, NOT per ledger).`);
const byLedger = new Map();
for (const r of unpaidRows) {
  const id = String(r.LedgerID);
  if (!byLedger.has(id)) byLedger.set(id, { creditBalance: num(r.CreditBalance), chargeBalance: num(r.ChargeBalance), tenant: r.TenantName, unit: r.UnitName });
}
console.log(`${byLedger.size} distinct ledger(s).`);
const nonZeroCredit = [...byLedger.entries()].filter(([, v]) => v.creditBalance !== 0);
console.log(`Ledgers with non-zero CreditBalance: ${nonZeroCredit.length}`);
let totalCreditBalance = 0;
for (const [, v] of byLedger) totalCreditBalance += v.creditBalance;
console.log(`Σ CreditBalance (deduped, all distinct ledgers in this report): £${R2(totalCreditBalance)}`);
if (nonZeroCredit.length) {
  console.log('Non-zero rows:');
  for (const [id, v] of nonZeroCredit) console.log(`  LedgerID ${id} (${v.tenant}, ${v.unit}): CreditBalance £${v.creditBalance}`);
}

// === Part 2: CustomerAccountsBalanceDetailsWithPrepayment, across every occupied tenant ===
console.log(`\n${'='.repeat(70)}\nPart 2: CustomerAccountsBalanceDetailsWithPrepayment -- per-tenant sweep\n${'='.repeat(70)}`);
const { rows: rrRows } = await callReport('RentRoll', site, start, now);
const occ = rrRows.filter((r) => yes(r.bRented) && r.LedgerID != null);
console.log(`${occ.length} occupied tenant(s) to check.`);

const d = await describeCcws();
const port = Object.values(Object.values(d)[0])[0];
const methodName = port['CustomerAccountsBalanceDetailsWithPrepayment'] ? 'CustomerAccountsBalanceDetailsWithPrepayment' : (port['CustomerAccountsBalanceDetailsWithPrepayment_v2'] ? 'CustomerAccountsBalanceDetailsWithPrepayment_v2' : null);
if (!methodName) {
  console.log('Neither CustomerAccountsBalanceDetailsWithPrepayment nor _v2 found on this WSDL -- skipping Part 2.');
  process.exit(0);
}
console.log(`Using method: ${methodName}`);
const inputSchema = port[methodName]?.input || {};
console.log(`Input schema: ${JSON.stringify(Object.keys(inputSchema))}`);
const ledgerKey = Object.keys(inputSchema).find((k) => /ledgerid/i.test(k));
if (!ledgerKey) { console.log(`No LedgerID-shaped param found. Full input schema: ${JSON.stringify(inputSchema)} -- cannot proceed with Part 2.`); process.exit(0); }
const wantsInt = /^i/.test(ledgerKey);

// Single-tenant test first, to see the real shape before committing to a full sweep.
const first = occ[0];
const testArgs = { [ledgerKey]: wantsInt ? Number(first.LedgerID) : String(first.LedgerID) };
console.log(`\nTest call for LedgerID ${first.LedgerID} (${first.sUnitName}):`);
try {
  const { rows: testRows } = await callCallCenterMethod(methodName, site, testArgs);
  console.log(`  ${testRows.length} row(s). Sample:`, testRows.length ? JSON.stringify(testRows[0]) : '(none)');
} catch (e) {
  console.log(`  error - ${e.message} -- cannot proceed with Part 2.`);
  process.exit(0);
}

// Full sweep.
console.log(`\nSweeping all ${occ.length} occupied tenants...`);
const creditFieldTotals = {}; // fieldName -> running sum, auto-discovered from whatever numeric/credit-ish fields appear
let errors = 0, rowsSeen = 0;
const creditPattern = /credit|prepay|balance|deposit/i;
for (let i = 0; i < occ.length; i++) {
  const t = occ[i];
  const args = { [ledgerKey]: wantsInt ? Number(t.LedgerID) : String(t.LedgerID) };
  try {
    const { rows } = await callCallCenterMethod(methodName, site, args);
    for (const r of rows) {
      rowsSeen++;
      for (const k of Object.keys(r)) {
        if (creditPattern.test(k)) {
          const v = num(r[k]);
          creditFieldTotals[k] = (creditFieldTotals[k] || 0) + v;
        }
      }
    }
  } catch (e) {
    errors++;
  }
  if ((i + 1) % 50 === 0 || i === occ.length - 1) console.log(`  ...${i + 1}/${occ.length} checked (${errors} errors so far)`);
}
console.log(`\n${errors} tenant(s) errored, ${occ.length - errors} succeeded, ${rowsSeen} total row(s) seen.`);
console.log('\nΣ per credit/prepayment/balance/deposit-shaped field, across all occupied tenants:');
for (const [k, v] of Object.entries(creditFieldTotals)) console.log(`  Σ ${k} = £${R2(v)}`);

console.log(`\n${'='.repeat(70)}\nContext\n${'='.repeat(70)}`);
console.log('Real Rate (Total), no Credits: £25.88/sqft/yr vs legacy £18.66 -- £7.22 off.');
console.log('Waived charges + refunds (all categories) closed it to £23.47 -- £4.81 still off.');
console.log('Any standing credit/prepayment balance found above would need annualizing the same way');
console.log('(÷ total area × 12) to see how much of the remaining £4.81 it explains.');
process.exit(0);
