// PROBE (22 Jul 2026), task #308/#403 follow-up #2. Michael: "keep going." Re-reading the full 80-row
// CustomReportListByCorp catalog (not just regex-matching it) surfaced something the wide net missed:
// rows 75-78 are a sequential, clearly-related block --
//   Automate\Inquiry Tracker          (CorpReportID 1002777) -- already used for Enquiries
//   Automate\Ledgers With Tenant Info (CorpReportID 1002778) -- NOT yet pulled
//   Automate\Management Summary       (CorpReportID 1002779) -- NOT yet pulled
//   Automate\Debtors                  (CorpReportID 1002780) -- NOT yet pulled
// All four carry sCorpCode=CYYL and sit in their own "Automate\" menu category -- distinct from the
// generic XML_EURO/XML_FINANCIAL reports (which don't have sCorpCode at all, i.e. predate that field).
// This "Automate\" category looks like R6's OWN bespoke, purpose-built exports for their warehouse sync
// -- exactly the kind of place "Fin_CreditsIssued" would live, the same way "Custom\Billing Frequency"
// (also sCorpCode=CYYL, also clearly bespoke) turned out to be exactly what was needed for billing
// frequency. "Ledgers With Tenant Info" in particular -- a per-ledger export with tenant info -- is
// worth checking directly for a credits/balance-adjustment-shaped column.
//
// Also grabs "Cinch Storage\All Unpaid Charges" (821730, also CYYL-tagged) as a cross-reference --
// inverse of Credits (what's still owed) but might help sanity-check whatever Ledgers/Debtors show.
//
// Dumps full column lists + several sample rows for each -- no assumptions about field names, same
// dump-first discipline used throughout this task.
//
// Run:  node --env-file=.env scripts/probe-automate-reports-credits.js [siteCode]
import { callCustomReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-automate-reports-credits.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

console.log(`Site: ${site}   Date range: ${start.toISOString()} to ${now.toISOString()}\n`);

const targets = [
  { id: 1002778, label: 'Automate\\Ledgers With Tenant Info' },
  { id: 1002780, label: 'Automate\\Debtors' },
  { id: 1002779, label: 'Automate\\Management Summary' },
  { id: 821730, label: 'Cinch Storage\\All Unpaid Charges (cross-reference)' },
];

const creditPattern = /credit|concession|waiv|adjust|write.?off|discount|refund|nsf|bad.?debt|allowance|balance/i;

for (const t of targets) {
  console.log(`\n${'='.repeat(70)}\n${t.label} (ReportID ${t.id})\n${'='.repeat(70)}`);
  try {
    const { rows } = await callCustomReport(t.id, site, start, now);
    console.log(`${rows.length} row(s) returned.`);
    if (!rows.length) continue;

    const allKeys = new Set();
    for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
    const cols = [...allKeys];
    console.log(`Columns (union across all rows): ${cols.join(', ')}`);

    const creditLikeCols = cols.filter((k) => creditPattern.test(k));
    console.log(`Columns matching credit/concession/waiver/adjustment/refund/balance pattern: ${creditLikeCols.join(', ') || '(none by name)'}`);

    console.log('\nFirst 5 rows:');
    rows.slice(0, 5).forEach((r, i) => console.log(`  ${i + 1}.`, JSON.stringify(r)));
  } catch (e) {
    console.log(`error - ${e.message}`);
  }
}
process.exit(0);
