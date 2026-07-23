// PROBE (22 Jul 2026), task #308/#403 — genuine blind spot found: every custom-report-catalog scan
// this task (probe-custom-report-catalog-credits.js, probe-full-custom-report-sweep.js) filtered for
// credit/concession/discount/waiver-type words, hunting for what NETS OUT of Rent. None of them ever
// searched for the word "rate" itself -- and Michael's own legacy portal separately tracks Rate, Real
// Rate, AND Effective Rate as three distinct concepts (confirmed from his own screenshots). Given
// "Custom\Billing Frequency" turned out to be exactly what it sounded like, this re-scans the SAME
// 80-row CustomReportListByCorp catalog (already swept once for credit-words, never for rate-words) for
// anything literally named like a rate-per-sqft calculation -- "real rate", "effective rate", "street
// rate", "market rate", "economic" -- auto-pulling any candidate to see its real shape, same successful
// methodology as Billing Frequency.
//
// Run:  node --env-file=.env scripts/probe-realrate-name-search.js [siteCode]
import { callReport, callCustomReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-realrate-name-search.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
console.log(`Site: ${site}\n`);

const { rows: catalog } = await callReport('CustomReportListByCorp', site, start, now);
console.log(`Catalog: ${catalog.length} custom report(s) total.\n`);

const pattern = /real.{0,3}rate|effective.{0,3}rate|street.{0,3}rate|market.{0,3}rate|econom|actual.{0,3}rate|blended.{0,3}rate/i;
const candidates = catalog
  .map((r, i) => ({ i, r, hit: pattern.test(JSON.stringify(r)) }))
  .filter((x) => x.hit);

console.log(`=== Candidates matching /real rate|effective rate|street rate|market rate|econom|actual rate|blended rate/i ===`);
if (!candidates.length) {
  console.log('None matched by name. Printing the FULL catalog below so it can be read manually --');
  console.log('the right one might use wording this regex doesn\'t anticipate.\n');
  catalog.forEach((r, i) => console.log(`  ${i + 1}.`, JSON.stringify(r)));
  process.exit(0);
}
for (const c of candidates) console.log(`  Row ${c.i + 1}:`, JSON.stringify(c.r));

console.log('\n=== Pulling each candidate to see its real shape ===');
for (const c of candidates) {
  const idKey = Object.keys(c.r).find((k) => /reportid/i.test(k));
  if (!idKey) { console.log(`  Row ${c.i + 1}: no ReportID-shaped field found (keys: ${Object.keys(c.r).join(', ')}) -- skipping.`); continue; }
  const id = c.r[idKey];
  console.log(`\n  --- Row ${c.i + 1}, ${idKey}=${id} ---`);
  try {
    const { rows } = await callCustomReport(Number(id), site, start, now);
    console.log(`    ${rows.length} row(s) returned.`);
    if (rows.length) {
      const allKeys = new Set();
      for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
      console.log(`    Columns (union across all rows): ${[...allKeys].join(', ')}`);
      console.log('    First 10 rows:');
      rows.slice(0, 10).forEach((r, j) => console.log(`      ${j + 1}.`, JSON.stringify(r)));
    }
  } catch (e) {
    console.log(`    error - ${e.message}`);
  }
}
process.exit(0);
