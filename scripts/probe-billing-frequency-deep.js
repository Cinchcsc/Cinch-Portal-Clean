// PROBE (22 Jul 2026), task #308 follow-up. Michael/R6 insist the field is real: "sbillingfreq...
// look across sitelink for this column or something similar." probe-r6-rate-formula.js only checked
// RentRoll (where R6 said it lives) and it genuinely isn't there (full live column dump, confirmed).
// Same lesson as task #400 (UnitsInformation): a first miss searching one report/one WSDL doesn't
// mean the thing doesn't exist — it was hiding in CallCenterWs last time. This casts a wider net:
//
//  1. Re-confirms RentRoll's exact column list (sanity check, same site/month).
//  2. Checks two CallCenterWs methods that sound purpose-built for per-tenant billing mechanics and
//     have never been called by this project before: TenantBillingInfoByTenantID_v3 (needs a real
//     TenantID — grabbed live from RentRoll's first occupied row) and TenantListDetailed_v3 (corp/
//     loc scoped, no tenant ID needed). Prints describeCcws()'s input params for both FIRST, so the
//     call args are confirmed instead of guessed.
//  3. Pulls three more already-integrated ReportingWs reports for the same site/month
//     (TenantRentChangeHistory, MoveInsAndMoveOuts, ManagementSummary) and flags any column matching
//     /bill|freq|cycle|28.?day|weekly/i.
//  4. Shows the actual VALUE distribution of RentRoll's dcSchedRateWeekly/dcSchedRateMonthly/
//     dcStdWeeklyRate for occupied units — if a real 4-weekly-billed population exists, one of these
//     should show non-zero/non-blank for a meaningful subset instead of being uniformly 0 or absent.
//
// Run:  node --env-file=.env scripts/probe-billing-frequency-deep.js [siteCode]
import { callReport, callCallCenterMethod, describeCcws } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-billing-frequency-deep.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());
const billRe = /bill|freq|cycle|28.?day|weekly|anniv/i;

console.log(`Site: ${site}   Month: ${start.toISOString().slice(0, 7)}`);

// --- 1: RentRoll, re-confirm + value distributions on the weekly/monthly-scheduled-rate fields ---
console.log('\n=== RentRoll ===');
const { rows: rrRows } = await callReport('RentRoll', site, start, now);
console.log(`${rrRows.length} rows.`);
const cols = rrRows[0] ? Object.keys(rrRows[0]) : [];
const billCols = cols.filter((k) => billRe.test(k));
console.log(billCols.length ? `Columns matching /bill|freq|cycle|28day|weekly|anniv/i: ${billCols.join(', ')}` : 'No column matches that pattern.');
console.log('sBillingFreq present:', cols.includes('sBillingFreq'));

const occ = rrRows.filter((r) => yes(r.bRented));
const nonZero = (key) => occ.filter((r) => num(r[key]) !== 0).length;
for (const key of ['dcSchedRateWeekly', 'dcSchedRateMonthly', 'dcStdWeeklyRate', 'dcSchedRent']) {
  if (!cols.includes(key)) { console.log(`  ${key}: column not present`); continue; }
  console.log(`  ${key}: ${nonZero(key)}/${occ.length} occupied rows non-zero`);
}
const firstOccupied = occ[0];
console.log('\nFirst occupied row (for reference):', firstOccupied ? JSON.stringify({
  sUnitName: firstOccupied.sUnitName, TenantID: firstOccupied.TenantID, dcRent: firstOccupied.dcRent,
  dcStdRate: firstOccupied.dcStdRate, dcSchedRent: firstOccupied.dcSchedRent,
  dcSchedRateWeekly: firstOccupied.dcSchedRateWeekly, dcSchedRateMonthly: firstOccupied.dcSchedRateMonthly,
  dcStdWeeklyRate: firstOccupied.dcStdWeeklyRate, iAnnivDays: firstOccupied.iAnnivDays,
}) : '(none occupied)');

// --- 2: CallCenterWs tenant-billing methods, never called by this project before ---
console.log('\n=== CallCenterWs: TenantBillingInfoByTenantID_v3 + TenantListDetailed_v3 ===');
const d = await describeCcws();
const port = Object.values(Object.values(d)[0])[0];
for (const m of ['TenantBillingInfoByTenantID_v3', 'TenantListDetailed_v3']) {
  console.log(`\n${m} input params:`, port[m] ? JSON.stringify(port[m].input) : 'NOT on this WSDL');
}

if (firstOccupied?.TenantID) {
  try {
    // FIXED same day — describeCcws() above shows the real param is iTenantID (int), not TenantID.
    // The first version of this script passed the wrong key, node-soap silently dropped it, and the
    // call failed with "Invalid Tenant ID" — a bug in the probe, not a real negative result.
    const { rows } = await callCallCenterMethod('TenantBillingInfoByTenantID_v3', site, { iTenantID: Number(firstOccupied.TenantID) });
    console.log(`\nTenantBillingInfoByTenantID_v3(${firstOccupied.TenantID}): ${rows.length} row(s).`);
    if (rows[0]) {
      console.log('Columns:', Object.keys(rows[0]).join(', '));
      const flagged = Object.keys(rows[0]).filter((k) => billRe.test(k));
      console.log(flagged.length ? `Matching columns: ${flagged.join(', ')}` : 'No column matches the billing-frequency pattern.');
      console.log('Row:', JSON.stringify(rows[0]).slice(0, 900));
    }
  } catch (e) { console.log('TenantBillingInfoByTenantID_v3 call failed:', e.message); }
}

try {
  const { rows } = await callCallCenterMethod('TenantListDetailed_v3', site);
  console.log(`\nTenantListDetailed_v3: ${rows.length} row(s).`);
  if (rows[0]) {
    console.log('Columns:', Object.keys(rows[0]).join(', '));
    const flagged = Object.keys(rows[0]).filter((k) => billRe.test(k));
    console.log(flagged.length ? `Matching columns: ${flagged.join(', ')}` : 'No column matches the billing-frequency pattern.');
    if (flagged.length) {
      const dist = {};
      for (const k of flagged) { dist[k] = {}; for (const r of rows) { const v = String(r[k] ?? '(blank)'); dist[k][v] = (dist[k][v] || 0) + 1; } }
      console.log('Distributions:', JSON.stringify(dist));
    }
  }
} catch (e) { console.log('TenantListDetailed_v3 call failed:', e.message); }

// --- 3: Other already-integrated ReportingWs reports, same site/month ---
for (const method of ['TenantRentChangeHistory', 'MoveInsAndMoveOuts', 'ManagementSummary']) {
  console.log(`\n=== ${method} ===`);
  try {
    const { rows } = await callReport(method, site, start, now);
    console.log(`${rows.length} rows.`);
    if (rows[0]) {
      const c = Object.keys(rows[0]);
      const flagged = c.filter((k) => billRe.test(k));
      console.log(flagged.length ? `Matching columns: ${flagged.join(', ')}` : 'No column matches the billing-frequency pattern.');
      if (flagged.length) {
        const dist = {};
        for (const k of flagged) { dist[k] = {}; for (const r of rows) { const v = String(r[k] ?? '(blank)'); dist[k][v] = (dist[k][v] || 0) + 1; } }
        console.log('Distributions:', JSON.stringify(dist));
      }
    }
  } catch (e) { console.log(`${method} call failed:`, e.message); }
}
process.exit(0);
