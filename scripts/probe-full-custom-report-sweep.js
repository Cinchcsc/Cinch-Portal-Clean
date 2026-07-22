// EXHAUSTIVE PROBE (22 Jul 2026), task #308/#403. Michael, directly: "if r6 has it it means we have
// it, do not stop until its found." Right call -- the billing-frequency search proved name-matching
// alone isn't reliable (nothing in the ~140 standard-report sweep matched by name OR was flagged
// low-cardinality; it was only found by going into the 80-row custom report catalog and actually
// PULLING a report whose title happened to say what it was). So far this task has only actually PULLED
// ~13 of the 80 custom reports (True Revenue x2, Billing Frequency, Waived Charges, Refunds Due,
// Deleted Charges, the deprecated waived-charges report, Refunds Reconciliation, BACS Refunds Pending,
// the 4 Automate\* reports, Cinch Storage\All Unpaid Charges) -- the other ~67 have only ever been
// judged by their catalog TITLE, never actually opened. This closes that gap: pulls EVERY custom report
// in the catalog not yet inspected, dumps its real column list (union across all rows, not just
// rows[0] -- the same fix this whole task has depended on since the RentRoll/dcPushRateAtMoveIn bug),
// and flags two independent signals regardless of what the report is titled:
//   1. NAME match -- any column matching a widened credit/concession/waiver/adjustment/write-off/
//      discount/refund/rebate/comp/goodwill/void/correction/reversal/forgiveness pattern.
//   2. STRUCTURE match -- any report with a LedgerID or TenantID column, i.e. joinable per-unit the
//      same way Billing Frequency (LedgerID -> sBillingFreqDesc) was joined into the Rate formula.
// Every custom report pull is already-established safe/read-only (same CustomReportByReportID
// mechanism used for True Revenue/Billing Frequency/every other custom report all task). Per-report
// errors are caught and logged, not fatal, so one bad report doesn't stop the sweep -- same pattern as
// the original exhaustive standard-report sweep.
//
// Run:  node --env-file=.env scripts/probe-full-custom-report-sweep.js [siteCode]
import { callReport, callCustomReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-full-custom-report-sweep.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
console.log(`Site: ${site}   Date range: ${start.toISOString()} to ${now.toISOString()}\n`);

// Already fully inspected this task -- skip to save time, not because they're excluded from scope.
const ALREADY_INSPECTED = new Set([781860, 781861, 999824, 460636, 460635, 460634, 460640, 460657, 1003260, 1002777, 1002778, 1002779, 1002780, 821730]);

const { rows: catalog } = await callReport('CustomReportListByCorp', site, start, now);
console.log(`Catalog: ${catalog.length} custom report(s) total. Already inspected: ${ALREADY_INSPECTED.size}. Sweeping the rest.\n`);

const creditPattern = /credit|concession|waiv|adjust|write.?off|discount|refund|rebate|comp\b|goodwill|void|correction|revers|forgiv|reduc|allowance|nsf|bad.?debt/i;

const nameHits = [];
const structureHits = [];
const errors = [];
const empties = [];

// Don't assume the catalog's field names (same lesson as probe-custom-report-catalog-credits.js) --
// find the ID/title-shaped keys per row rather than hardcoding CorpReportID/Title.
let n = 0;
for (const row of catalog) {
  const idKey = Object.keys(row).find((k) => /reportid/i.test(k));
  const titleKey = Object.keys(row).find((k) => /title|name|desc|categ/i.test(k));
  const id = idKey ? Number(row[idKey]) : NaN;
  const title = (titleKey ? row[titleKey] : null) || JSON.stringify(row);
  if (!id) { console.log(`(skipping row with no ReportID-shaped field: ${JSON.stringify(row)})`); continue; }
  if (ALREADY_INSPECTED.has(id)) continue;
  n++;
  try {
    const { rows } = await callCustomReport(id, site, start, now);
    if (!rows.length) { empties.push({ id, title }); console.log(`[${n}] ${title} (${id}): 0 rows`); continue; }

    const allKeys = new Set();
    for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
    const cols = [...allKeys];

    const nameMatch = cols.filter((k) => creditPattern.test(k));
    const hasLedgerOrTenant = cols.some((k) => /ledgerid|tenantid/i.test(k));

    let flag = '';
    if (nameMatch.length) { flag += ` <<< NAME MATCH: ${nameMatch.join(', ')}`; nameHits.push({ id, title, cols, nameMatch, sample: rows[0] }); }
    if (hasLedgerOrTenant) { flag += ` <<< LEDGER/TENANT-JOINABLE`; structureHits.push({ id, title, cols, sample: rows[0] }); }
    console.log(`[${n}] ${title} (${id}): ${rows.length} row(s), ${cols.length} col(s)${flag}`);
  } catch (e) {
    errors.push({ id, title, error: e.message });
    console.log(`[${n}] ${title} (${id}): error - ${e.message}`);
  }
}

console.log(`\n\n${'='.repeat(70)}\nSWEPT ${n} report(s). ${empties.length} empty, ${errors.length} errored.\n${'='.repeat(70)}`);

console.log(`\n=== NAME-MATCH HITS (${nameHits.length}) ===`);
for (const h of nameHits) {
  console.log(`\n${h.title} (${h.id}) -- matched: ${h.nameMatch.join(', ')}`);
  console.log(`  All columns: ${h.cols.join(', ')}`);
  console.log(`  Sample row: ${JSON.stringify(h.sample).slice(0, 500)}`);
}

console.log(`\n=== LEDGER/TENANT-JOINABLE REPORTS (${structureHits.length}) -- not already a name-match above ===`);
for (const h of structureHits) {
  if (nameHits.some((n) => n.id === h.id)) continue; // already printed above
  console.log(`\n${h.title} (${h.id})`);
  console.log(`  All columns: ${h.cols.join(', ')}`);
  console.log(`  Sample row: ${JSON.stringify(h.sample).slice(0, 500)}`);
}

if (errors.length) {
  console.log(`\n=== ERRORS (${errors.length}) -- may just need different/extra params ===`);
  for (const e of errors) console.log(`  ${e.title} (${e.id}): ${e.error}`);
}
process.exit(0);
