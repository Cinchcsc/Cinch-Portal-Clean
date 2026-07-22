// PROBE (22 Jul 2026), task #308/#403 follow-up #5. Michael: "keep going." ManagementSummary is a
// MULTI-table SOAP response (9 tables, per lib/sitelink.js's own long-standing comment: Receipts/
// Concessions/Discounts/Delinquency/Unpaid/RentLastChanged/VarFromStdRate/UnitActivity/Alerts) --
// ALREADY pulled every day for other widgets (Enquiries, Delinquency/Debtor Levels), but only the
// Delinquency/Unpaid tables have ever been extracted from it (via extractNamedTable(), task #71/#231).
// "Concessions" -- rent concessions given to tenants -- is sitting right there in a report already
// being pulled, and has never been examined for this task. Worth checking directly before assuming
// Credits requires a whole separate report call.
//
// Uses the SAME already-established, already-safe mechanism as the existing Delinquency extraction:
// callReport('ManagementSummary', ...) for { rows, raw }, then extractNamedTable(raw, 'Concessions')
// to pull that one table out of the multi-table response. No new SOAP methods, no new safety surface.
//
// Also grabs the "Discounts" table from the SAME response as a sanity cross-check against the
// already-established `discounts` report (a DIFFERENT SiteLink report, DiscountSummary/DiscountsRetrieve
// -- confirming whether ManagementSummary's own internal "Discounts" table roughly agrees, which would
// increase confidence that its "Concessions" table is a real, comparable figure and not some unrelated
// internal bookkeeping concept).
//
// Run:  node --env-file=.env scripts/probe-managementsummary-concessions.js [siteCode]
import { callReport, extractNamedTable } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-managementsummary-concessions.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

console.log(`Site: ${site}   Date range: ${start.toISOString()} to ${now.toISOString()}\n`);

const { rows, raw } = await callReport('ManagementSummary', site, start, now);
console.log(`ManagementSummary: ${rows.length} row(s) on the default (largest) table.\n`);

for (const tableName of ['Concessions', 'Discounts', 'Receipts']) {
  console.log(`${'='.repeat(70)}\nTable: ${tableName}\n${'='.repeat(70)}`);
  const tableRows = extractNamedTable(raw, tableName);
  console.log(`${tableRows.length} row(s).`);
  if (!tableRows.length) { console.log('(empty or not found)\n'); continue; }

  const allKeys = new Set();
  for (const r of tableRows) for (const k of Object.keys(r)) allKeys.add(k);
  console.log(`Columns (union across all rows): ${[...allKeys].join(', ')}`);
  console.log('All rows:');
  tableRows.forEach((r, i) => console.log(`  ${i + 1}.`, JSON.stringify(r)));

  // Sum every column that looks numeric across >80% of populated values.
  const numericCols = [...allKeys].filter((k) => {
    const vals = tableRows.map((r) => r[k]).filter((v) => v !== undefined && v !== null && v !== '');
    if (!vals.length) return false;
    const numeric = vals.filter((v) => !Number.isNaN(Number(String(v).replace(/[£,%\s]/g, ''))));
    return numeric.length / vals.length > 0.8;
  });
  console.log(`\nΣ per numeric-looking column:`);
  for (const k of numericCols) {
    const total = tableRows.reduce((a, r) => a + num(r[k]), 0);
    console.log(`  Σ ${k} = £${R2(total)}`);
  }
  console.log('');
}

console.log(`${'='.repeat(70)}\nContext\n${'='.repeat(70)}`);
console.log('Real Rate (Total), no Credits: £25.88/sqft/yr vs legacy £18.66 -- £7.22 off.');
console.log('Waived charges + refunds (all categories) closed it to £23.47 -- £4.81 still off.');
console.log('Already-established Discounts report (separate, time-limited plans only, already in the');
console.log('formula) summed £2,353.04 this period, for cross-reference against the Discounts table above.');
process.exit(0);
