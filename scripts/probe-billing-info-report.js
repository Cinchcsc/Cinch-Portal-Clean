// Looks for a real "Tenant Billing Info"-type report on the WSDL (Michael's KPI doc cites it
// separately from RentRoll for Autobill Conversion) that might carry the actual 28-day-billing-cycle
// field RentRoll doesn't expose (our last attempt wrongly matched iAutoBillType, which is the
// autobill/direct-debit enrollment flag, not a billing-cycle-LENGTH field — unrelated concept).
// Step 1: list every SOAP method on the WSDL, filter to anything billing/tenant-info-like.
// Step 2: if a plausible report method is found, call it for one site and dump its columns looking
// for a cycle/frequency/28-day field.
// PII-SAFE: prints method names and column names/counts only.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-billing-info-report.js
import { listMethods, callReport } from '../lib/sitelink.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);

const methods = await listMethods();
console.log(`${methods.length} total SOAP methods on ReportingWs.asmx WSDL.\n`);
const candidates = methods.filter(m => /bill|tenant.?info|autobill/i.test(m));
console.log('Candidate methods matching /bill|tenant.?info|autobill/i:');
console.log(candidates.length ? candidates.map(m => '  ' + m).join('\n') : '  (none found)');

if (!candidates.length) {
  console.log('\nNo billing-info-style report method exists on this WSDL. The 28-day-billing field (if it');
  console.log('exists at all for this account) is not reachable through any report method we can call —');
  console.log('this needs a direct question to SiteLink support, not another probe.');
  process.exit(0);
}

for (const method of candidates) {
  console.log(`\n=== Trying ${method} ===`);
  try {
    const { rows } = await callReport(method.replace(/Async$/, ''), loc, start, end);
    if (!rows.length) { console.log('  (no rows returned)'); continue; }
    const cols = Object.keys(rows[0]).filter(c => !/^(diffgr|msdata)/i.test(c));
    console.log('  COLUMNS:', cols.join(', '));
    const cycleCols = cols.filter(c => /cycle|frequen|28|period|bill.?day/i.test(c));
    if (cycleCols.length) {
      console.log('  Billing-cycle-like columns:', cycleCols.join(', '));
      console.log('  Sample values (first 5 rows):', rows.slice(0, 5).map(r => cycleCols.map(c => `${c}=${r[c]}`).join(' ')).join(' | '));
    } else {
      console.log('  No billing-cycle-like column found here either.');
    }
  } catch (e) { console.log('  error:', e.message); }
}
process.exit(0);
