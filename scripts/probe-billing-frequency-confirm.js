// PROBE (22 Jul 2026), task #308. Found it: CustomReportByReportID(999824) returns LedgerID +
// sBillingFreqDesc directly -- 319 rows at L001 vs 318 occupied tenants, near-exact match. R6's naming
// was close (sBillingFreq) but not exact (sBillingFreqDesc), and it lives on this custom report rather
// than the live RentRoll SOAP call, which is exactly why the full-column exhaustive search never
// surfaced it -- it was never going to be there no matter how hard that was searched.
//
// Before wiring this into the actual Rate/Real Rate formula, two confirmations:
//  1. Full value distribution of sBillingFreqDesc -- is it only ever "28 Days" or blank/other, or are
//     there multiple real values (e.g. "Monthly" for the rest)?
//  2. Cross-check against the empirical charge-period-length measurement from the previous probe: for
//     each LedgerID, does sBillingFreqDesc="28 Days" line up with a measured ~28-day charge span, and
//     does anything NOT flagged "28 Days" line up with a ~30-31 day span? Agreement between the two
//     independent methods (one an explicit label, one a measured outcome) is strong confirmation this
//     is real and being read correctly, rather than a coincidental report we happened to find.
//
// Run:  node --env-file=.env scripts/probe-billing-frequency-confirm.js [siteCode]
import { callReport, callCallCenterMethod, callCustomReport, describeCcws } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-billing-frequency-confirm.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());
const REPORT_ID = 999824;

console.log(`Site: ${site}   Month: ${start.toISOString().slice(0, 7)}\n`);

// === Part 1: full distribution ===
const { rows: bfRows } = await callCustomReport(REPORT_ID, site, start, now);
console.log(`ReportID ${REPORT_ID}: ${bfRows.length} row(s).`);
const dist = {};
const byLedger = new Map();
for (const r of bfRows) {
  const v = String(r.sBillingFreqDesc ?? '(blank)');
  dist[v] = (dist[v] || 0) + 1;
  byLedger.set(String(r.LedgerID), v);
}
console.log('Full value distribution:', JSON.stringify(dist));

// === Part 2: cross-check against measured charge-period length ===
console.log('\n=== Cross-check: sBillingFreqDesc vs measured Rent charge-period length ===');
const { rows: rrRows } = await callReport('RentRoll', site, start, now);
const occ = rrRows.filter((r) => yes(r.bRented) && r.LedgerID != null);
console.log(`${occ.length} occupied tenants to cross-check.`);

const d = await describeCcws();
const port = Object.values(Object.values(d)[0])[0];
const inputSchema = port['ChargesAndPaymentsByLedgerID']?.input || {};
const ledgerKey = Object.keys(inputSchema).find((k) => /ledgerid/i.test(k));
const wantsInt = /^i/.test(ledgerKey);

let agree = 0, disagree = 0, noLabel = 0, noSpan = 0;
const disagreements = [];

for (let i = 0; i < occ.length; i++) {
  const t = occ[i];
  const label = byLedger.get(String(t.LedgerID));
  if (!label) { noLabel++; continue; }
  const args = { [ledgerKey]: wantsInt ? Number(t.LedgerID) : String(t.LedgerID) };
  try {
    const { rows } = await callCallCenterMethod('ChargesAndPaymentsByLedgerID', site, args);
    const rentRows = rows.filter((r) => String(r.sChgCategory ?? '').toLowerCase() === 'rent' && r.dChgStrt && r.dChgEnd);
    if (!rentRows.length) { noSpan++; continue; }
    const latest = rentRows.reduce((a, b) => (new Date(a.dChgStrt) > new Date(b.dChgStrt) ? a : b));
    const span = Math.round((new Date(latest.dChgEnd) - new Date(latest.dChgStrt)) / 86400000);
    const labelSays28 = /28/.test(label);
    const spanSays28 = span >= 24 && span <= 29;
    if (labelSays28 === spanSays28) agree++;
    else { disagree++; disagreements.push({ sUnitName: t.sUnitName, LedgerID: t.LedgerID, label, span }); }
  } catch (e) { noSpan++; }
  if ((i + 1) % 50 === 0 || i === occ.length - 1) console.log(`  ...${i + 1}/${occ.length} checked`);
}

console.log(`\nAgree: ${agree}, Disagree: ${disagree}, No label found: ${noLabel}, No charge span found: ${noSpan}`);
if (disagreements.length) {
  console.log('\n--- Disagreements (label vs measured span) ---');
  for (const d of disagreements) console.log(`  ${d.sUnitName} (LedgerID ${d.LedgerID}): label="${d.label}" but measured span=${d.span} days`);
}
process.exit(0);
