// PROBE (22 Jul 2026), task #308. The custom report catalog (CustomReportListByCorp) just revealed
// CorpReportID 999824, titled literally "Custom\Billing Frequency" -- configured for this corp (CYYL),
// never called by this project before. This is almost certainly the exact report R6's warehouse reads
// ("billing frequency is a field on the Rent Roll report... we sync... and utilise as filters").
// Custom reports are pulled the same way this project already pulls True Revenue (ReportID 781861),
// via CustomReportByReportID -- already established as safe/read-only, already integrated.
//
// This just pulls it and dumps everything: row count, full column list, and full sample rows, so the
// actual shape can be seen before deciding how (or whether) to wire it into the Rate/Real Rate formula.
//
// Run:  node --env-file=.env scripts/probe-billing-frequency-report.js [siteCode]
import { callCustomReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-billing-frequency-report.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const REPORT_ID = 999824; // "Custom\Billing Frequency", per CustomReportListByCorp

console.log(`Site: ${site}   Month: ${start.toISOString().slice(0, 7)}   ReportID: ${REPORT_ID}\n`);

const { rows } = await callCustomReport(REPORT_ID, site, start, now);
console.log(`${rows.length} row(s) returned.`);

if (rows.length) {
  const allKeys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
  console.log(`\nColumns (union across all rows): ${[...allKeys].join(', ')}`);

  console.log('\n=== First 10 full rows ===');
  rows.slice(0, 10).forEach((r, i) => console.log(`  ${i + 1}.`, JSON.stringify(r)));

  // If there's an obvious tenant/unit identifier, cross-check row count against RentRoll's occupied
  // count so we know if this is per-tenant, per-unit, or something else entirely.
  console.log(`\nTotal rows returned: ${rows.length} (compare to ~318 occupied tenants at L001, ~348 total units, to gauge grain).`);
} else {
  console.log('No rows returned -- may need different params (this report might not take the same startDate/endDate/location shape as True Revenue). Will need to check its actual required inputs if so.');
}
process.exit(0);
