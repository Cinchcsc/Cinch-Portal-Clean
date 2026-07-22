// PROBE (22 Jul 2026), task #308/#403 follow-up. Michael, directly: "if we found the billing freq we
// can find this [Credits]." He's right that the same move is worth repeating: billing frequency was
// NEVER going to show up on any of the ~140 standard-report columns (confirmed by the full exhaustive
// sweep) -- it was found by going back to CustomReportListByCorp, SiteLink's catalog of ACCOUNT-
// SPECIFIC custom reports (80 rows, beyond the ~60 standard ReportingWs methods), and spotting one
// literally titled "Custom\Billing Frequency" (CorpReportID 999824).
//
// GeneralJournalEntries' "Credits Issued" bucket (task #403) turned out real and well-formed but ~7x
// too small to explain the Real Rate gap (~£2k/mo vs ~£12-18k/mo needed at Bicester) -- so rather than
// conclude Credits "isn't in SiteLink," this re-scans that SAME 80-row custom report catalog for
// anything else Credits/concession/waiver/adjustment-shaped, exactly the way Billing Frequency was
// found, instead of assuming GeneralJournalEntries was the only place to look.
//
// Prints the FULL unfiltered catalog first (every row, not just name-matches -- the whole reason the
// exhaustive sweep got rewritten as v2 earlier this session: don't trust name-matching alone to be
// exhaustive). Then separately highlights rows whose ENTIRE stringified row (not one assumed field
// name -- catalog field names weren't confirmed ahead of time) matches a wide credit/concession/
// waiver/adjustment/write-off/discount-ish pattern, and automatically pulls each highlighted candidate
// via CustomReportByReportID to show its real shape -- so a genuine candidate can be confirmed or ruled
// out in this one run, same as Billing Frequency was.
//
// Run:  node --env-file=.env scripts/probe-custom-report-catalog-credits.js [siteCode]
import { callReport, callCustomReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-custom-report-catalog-credits.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

console.log(`Site: ${site}   Month: ${start.toISOString().slice(0, 7)}\n`);

const { rows: reportList } = await callReport('CustomReportListByCorp', site, start, now);
console.log(`CustomReportListByCorp: ${reportList.length} custom report(s) configured for this corp.\n`);
console.log('=== Full unfiltered catalog ===');
reportList.forEach((r, i) => console.log(`  ${i + 1}.`, JSON.stringify(r)));

// Wide net -- match against the WHOLE stringified row, not one assumed field name (don't repeat the
// row[0]-only-shape-assumption mistake from earlier this session).
const pattern = /credit|concession|waiv|adjust|write.?off|discount|refund|nsf|bad.?debt|allowance/i;
const candidates = reportList
  .map((r, i) => ({ i, r, hit: pattern.test(JSON.stringify(r)) }))
  .filter((x) => x.hit);

console.log(`\n=== Candidates matching /credit|concession|waiv|adjust|write-off|discount|refund|nsf|bad debt|allowance/i ===`);
if (!candidates.length) {
  console.log('None matched by name in the catalog itself. Re-read the full catalog above manually -- the');
  console.log('right one might use different wording entirely (same risk that applied to Billing Frequency');
  console.log('before it was spotted).');
  process.exit(0);
}
for (const c of candidates) console.log(`  Row ${c.i + 1}:`, JSON.stringify(c.r));

// Auto-pull each candidate via CustomReportByReportID (same safe, already-integrated, read-only
// mechanism already used for True Revenue/781861 and Billing Frequency/999824) to see its real shape.
console.log('\n=== Pulling each candidate via CustomReportByReportID to see its actual shape ===');
for (const c of candidates) {
  const idKey = Object.keys(c.r).find((k) => /reportid/i.test(k));
  if (!idKey) { console.log(`  Row ${c.i + 1}: no ReportID-shaped field found on this row (keys: ${Object.keys(c.r).join(', ')}) -- skipping auto-pull.`); continue; }
  const id = c.r[idKey];
  console.log(`\n  --- Row ${c.i + 1}, ${idKey}=${id} ---`);
  try {
    const { rows } = await callCustomReport(Number(id), site, start, now);
    console.log(`    ${rows.length} row(s) returned.`);
    if (rows.length) {
      const allKeys = new Set();
      for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
      console.log(`    Columns (union across all rows): ${[...allKeys].join(', ')}`);
      console.log('    First 5 rows:');
      rows.slice(0, 5).forEach((r, j) => console.log(`      ${j + 1}.`, JSON.stringify(r)));
    }
  } catch (e) {
    console.log(`    error - ${e.message}`);
  }
}
process.exit(0);
