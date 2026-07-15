// Task #230 follow-up. probe-merchandise-new-customer.js just ran and found ZERO rows matching
// /merchandis/i on any of ChargeDesc/sChgDesc/Description at all 26 sites -- meaning either the
// field name guess was wrong, or extractRows(raw) isn't returning the per-transaction table (Table2)
// at all for this report/call. Rather than guess again, this dumps the ACTUAL keys and values of
// the first few rows returned by extractRows() for one site, no filtering, no assumptions -- so we
// can see for real what's in there and pick the right field names.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-merchandise-rawdump.js
import { callCustomReport, extractRows, extractNamedTable } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-merchandise-rawdump] ' + lock.message); process.exit(1); }

const loc = process.argv[2] || 'L012'; // Gillingham -- known to have real data in past probes
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

const { raw } = await callCustomReport(781861, loc, start, now);

const rowsExtracted = extractRows(raw);
console.log(`extractRows() returned ${rowsExtracted.length} rows for ${loc}.`);
if (rowsExtracted.length) {
  console.log('\n--- First row, ALL keys/values (no filtering) ---');
  console.log(JSON.stringify(rowsExtracted[0], null, 2));
  console.log('\n--- Distinct values seen in every string-valued field across first 50 rows (helps spot the ChargeDesc-equivalent column) ---');
  const fieldValues = {};
  for (const r of rowsExtracted.slice(0, 50)) {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'string' && v && k !== 'attributes') {
        (fieldValues[k] ??= new Set()).add(v);
      }
    }
  }
  for (const [k, vals] of Object.entries(fieldValues)) {
    const arr = [...vals];
    console.log(`  ${k}: ${arr.length} distinct values, e.g. ${arr.slice(0, 5).map((v) => JSON.stringify(v)).join(', ')}`);
  }
}

console.log('\n--- Also checking Table1 (the SiteLink pre-aggregate, 36 rows) for comparison ---');
const table1 = extractNamedTable(raw, 'Table1');
console.log(`Table1 has ${table1.length} rows.`);
if (table1.length) console.log(JSON.stringify(table1[0], null, 2));
process.exit(0);
