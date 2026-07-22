// PROBE (22 Jul 2026), task #308/#403 follow-up #4. Michael: "keep going." Part 2 of the previous
// probe (CustomerAccountsBalanceDetailsWithPrepayment) hit a dead end -- it takes iTenantID +
// iNumberOfMonthsPrepay, not a LedgerID, and by that shape looks like a forward-looking "what would a
// prepay quote cost" calculator rather than a report of an EXISTING credit/prepayment balance. Its
// sibling methods are already in the hand-vetted CallCenterWs allowlist from the earlier exhaustive
// sweep (called once, never examined for Credits): CustomerAccountsBalanceDetails (plain),
// CustomerAccountsBalanceDetails_v2, CustomerAccountsBalanceDetailsWithDiscount. These may take a
// different, more direct param (LedgerID or TenantID with no hypothetical extra) and might return an
// ACTUAL current balance rather than a quote.
//
// Part 1: dumps the real input schema for all four variants side by side, so the right one (if any) is
// obvious rather than assumed.
// Part 2: for whichever variant looks usable (has a LedgerID/TenantID param, no other required
// hypothetical param), does one test call against a real tenant to see the output shape.
// Part 3: if the output shape has anything credit/balance-shaped, sweeps every occupied tenant and
// sums it.
//
// Run:  node --env-file=.env scripts/probe-account-balance-variants.js [siteCode]
import { callReport, callCallCenterMethod, describeCcws } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-account-balance-variants.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

console.log(`Site: ${site}   Date range: ${start.toISOString()} to ${now.toISOString()}\n`);

const d = await describeCcws();
const port = Object.values(Object.values(d)[0])[0];

const candidates = ['CustomerAccountsBalanceDetails', 'CustomerAccountsBalanceDetails_v2', 'CustomerAccountsBalanceDetailsWithDiscount', 'CustomerAccountsChargesWithPrepayment'];
console.log(`${'='.repeat(70)}\nPart 1: input schemas\n${'='.repeat(70)}`);
const usable = [];
for (const m of candidates) {
  if (!port[m]) { console.log(`${m}: not found on this WSDL`); continue; }
  const inputSchema = port[m].input || {};
  console.log(`${m}: ${JSON.stringify(Object.keys(inputSchema))}`);
  const requiredish = Object.keys(inputSchema).filter((k) => !['scorpcode', 'scorpusername', 'scorppassword', 'slocationcode'].includes(k.toLowerCase()));
  const hasLedgerOrTenant = requiredish.some((k) => /ledgerid|tenantid/i.test(k));
  const hasExtraHypothetical = requiredish.some((k) => /month|numberof|hypothetical|quote/i.test(k));
  if (hasLedgerOrTenant && !hasExtraHypothetical) usable.push({ method: m, inputSchema });
}
console.log(`\nUsable (has LedgerID/TenantID, no extra hypothetical param): ${usable.map((u) => u.method).join(', ') || '(none)'}`);
if (!usable.length) { console.log('\nNo usable variant found -- stopping here.'); process.exit(0); }

const { rows: rrRows } = await callReport('RentRoll', site, start, now);
const occ = rrRows.filter((r) => yes(r.bRented) && r.LedgerID != null);
console.log(`\n${occ.length} occupied tenant(s) available for testing.`);

for (const { method, inputSchema } of usable) {
  console.log(`\n${'='.repeat(70)}\nPart 2: test call -- ${method}\n${'='.repeat(70)}`);
  const keys = Object.keys(inputSchema).filter((k) => !['scorpcode', 'scorpusername', 'scorppassword', 'slocationcode'].includes(k.toLowerCase()));
  const ledgerKey = keys.find((k) => /ledgerid/i.test(k));
  const tenantKey = keys.find((k) => /tenantid/i.test(k));
  const first = occ[0];
  const args = {};
  if (ledgerKey) args[ledgerKey] = /^i/.test(ledgerKey) ? Number(first.LedgerID) : String(first.LedgerID);
  if (tenantKey) args[tenantKey] = /^i/.test(tenantKey) ? Number(first.TenantID) : String(first.TenantID);
  console.log(`Args: ${JSON.stringify(args)}`);
  try {
    const { rows } = await callCallCenterMethod(method, site, args);
    console.log(`${rows.length} row(s). Full sample:`, rows.length ? JSON.stringify(rows[0]) : '(none)');
    if (rows.length > 1) console.log('Row 2:', JSON.stringify(rows[1]));

    const allKeys = new Set();
    for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
    const creditPattern = /credit|prepay|balance|deposit/i;
    const creditCols = [...allKeys].filter((k) => creditPattern.test(k));
    console.log(`Credit/prepay/balance/deposit-shaped columns: ${creditCols.join(', ') || '(none)'}`);

    if (creditCols.length) {
      console.log(`\n${'='.repeat(70)}\nPart 3: sweeping all ${occ.length} occupied tenants for ${method}\n${'='.repeat(70)}`);
      const totals = {};
      let errors = 0;
      for (let i = 0; i < occ.length; i++) {
        const t = occ[i];
        const sweepArgs = {};
        if (ledgerKey) sweepArgs[ledgerKey] = /^i/.test(ledgerKey) ? Number(t.LedgerID) : String(t.LedgerID);
        if (tenantKey) sweepArgs[tenantKey] = /^i/.test(tenantKey) ? Number(t.TenantID) : String(t.TenantID);
        try {
          const { rows: sweepRows } = await callCallCenterMethod(method, site, sweepArgs);
          for (const r of sweepRows) for (const k of creditCols) totals[k] = (totals[k] || 0) + num(r[k]);
        } catch (e) { errors++; }
        if ((i + 1) % 50 === 0 || i === occ.length - 1) console.log(`  ...${i + 1}/${occ.length} (${errors} errors)`);
      }
      console.log(`\nΣ per column, across all occupied tenants:`);
      for (const [k, v] of Object.entries(totals)) console.log(`  Σ ${k} = £${R2(v)}`);
    }
  } catch (e) {
    console.log(`error - ${e.message}`);
  }
}

console.log(`\n${'='.repeat(70)}\nContext\n${'='.repeat(70)}`);
console.log('Real Rate (Total), no Credits: £25.88/sqft/yr vs legacy £18.66 -- £7.22 off.');
console.log('Waived charges + refunds (all categories) closed it to £23.47 -- £4.81 still off.');
process.exit(0);
