// PROBE (22 Jul 2026), task #308. Two follow-ups from the v2 exhaustive sweep, while waiting on R6:
//
//  1. CustomReportListByCorp returned 80 rows -- a whole catalog of custom reports configured for
//     this corp, beyond the one we already use (ReportID 781861 / True Revenue). The sweep only
//     printed boolean flag distributions (bDevelopmentOnly, bAllowCCC, etc.), not the actual report
//     IDs/names. This prints full rows so we can see if any other custom report exists that might be
//     exactly what R6's warehouse reads.
//
//  2. ChargesAndPaymentsByLedgerID (confirmed working, already returned 115 rows for one tenant) has
//     dChgStrt/dChgEnd per charge. If some tenants are genuinely billed every 28 days and others
//     monthly, their Rent-category charges should show that directly as a measurable span -- ~28 days
//     for one group, ~30-31 for the other -- regardless of what any field is named. This sidesteps the
//     entire "what's it called" problem: instead of searching for a flag, it measures an outcome.
//     Loops every occupied tenant at the site, pulls their charges, filters to Rent, computes
//     (dChgEnd - dChgStrt) in days for each, and reports the distribution plus which specific tenants
//     cluster around 28 days.
//
// This will make one live call per occupied tenant for part 2 (~300+ at L001) -- slower than previous
// probes, expect a few minutes.
//
// Run:  node --env-file=.env scripts/probe-charge-period-length.js [siteCode]
import { callReport, callCallCenterMethod, describeCcws } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-charge-period-length.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());

console.log(`Site: ${site}   Month: ${start.toISOString().slice(0, 7)}\n`);

// === Part 1: full CustomReportListByCorp rows ===
console.log('=== CustomReportListByCorp: full rows ===');
const { rows: reportList } = await callReport('CustomReportListByCorp', site, start, now);
console.log(`${reportList.length} custom report(s) configured for this corp.`);
reportList.forEach((r, i) => console.log(`  ${i + 1}.`, JSON.stringify(r)));

// === Part 2: charge-period-length distribution across every occupied tenant ===
console.log('\n=== ChargesAndPaymentsByLedgerID sweep: measuring actual Rent charge-period lengths ===');
const { rows: rrRows } = await callReport('RentRoll', site, start, now);
const occ = rrRows.filter((r) => yes(r.bRented) && r.LedgerID != null);
console.log(`${occ.length} occupied tenants to check.`);

const d = await describeCcws();
const port = Object.values(Object.values(d)[0])[0];
const inputSchema = port['ChargesAndPaymentsByLedgerID']?.input || {};
const ledgerKey = Object.keys(inputSchema).find((k) => /ledgerid/i.test(k));
if (!ledgerKey) { console.error('Could not find a LedgerID-shaped param on ChargesAndPaymentsByLedgerID. Input schema:', JSON.stringify(inputSchema)); process.exit(1); }
const wantsInt = /^i/.test(ledgerKey);
console.log(`Using param key "${ledgerKey}" (${wantsInt ? 'int' : 'string'}).`);

const spanHistogram = {}; // days -> count, across every Rent charge row seen
const perTenant = []; // { sUnitName, TenantID, LedgerID, mostRecentSpan }
let errors = 0;

for (let i = 0; i < occ.length; i++) {
  const t = occ[i];
  const args = { [ledgerKey]: wantsInt ? Number(t.LedgerID) : String(t.LedgerID) };
  try {
    const { rows } = await callCallCenterMethod('ChargesAndPaymentsByLedgerID', site, args);
    const rentRows = rows.filter((r) => String(r.sChgCategory ?? '').toLowerCase() === 'rent' && r.dChgStrt && r.dChgEnd);
    const spans = rentRows.map((r) => {
      const s = new Date(r.dChgStrt), e = new Date(r.dChgEnd);
      return Math.round((e - s) / 86400000);
    }).filter((n) => Number.isFinite(n) && n > 0 && n < 120); // sanity bounds, drop obvious junk
    for (const sp of spans) spanHistogram[sp] = (spanHistogram[sp] || 0) + 1;
    // most recent = latest dChgStrt
    if (rentRows.length) {
      const latest = rentRows.reduce((a, b) => (new Date(a.dChgStrt) > new Date(b.dChgStrt) ? a : b));
      const s = new Date(latest.dChgStrt), e = new Date(latest.dChgEnd);
      const span = Math.round((e - s) / 86400000);
      perTenant.push({ sUnitName: t.sUnitName, TenantID: t.TenantID, LedgerID: t.LedgerID, span });
    }
  } catch (e) {
    errors++;
  }
  if ((i + 1) % 25 === 0 || i === occ.length - 1) console.log(`  ...${i + 1}/${occ.length} tenants checked (${errors} errors so far)`);
}

console.log(`\n${errors} tenant(s) errored (likely no charge history / access issue), ${occ.length - errors} succeeded.`);

console.log('\n=== Histogram: every Rent-category charge span seen (days), all tenants combined ===');
const sortedSpans = Object.keys(spanHistogram).map(Number).sort((a, b) => a - b);
for (const sp of sortedSpans) console.log(`  ${sp} day(s): ${spanHistogram[sp]} charge row(s)`);

const shortSpanTenants = perTenant.filter((t) => t.span >= 24 && t.span <= 29);
const longSpanTenants = perTenant.filter((t) => t.span >= 30 && t.span <= 32);
const otherTenants = perTenant.filter((t) => t.span < 24 || t.span > 32);
console.log(`\n=== Per-tenant most-recent-Rent-charge span buckets (${perTenant.length} tenants with at least one Rent charge) ===`);
console.log(`24-29 days (candidate 4-weekly/28-day billers): ${shortSpanTenants.length}`);
console.log(`30-32 days (candidate calendar-month billers): ${longSpanTenants.length}`);
console.log(`other (outside both ranges -- partial periods, anomalies, etc.): ${otherTenants.length}`);

if (shortSpanTenants.length) {
  console.log('\n--- Tenants whose most recent Rent charge spans 24-29 days ---');
  for (const t of shortSpanTenants) console.log(`  ${t.sUnitName} (TenantID ${t.TenantID}, LedgerID ${t.LedgerID}): ${t.span} days`);
}
process.exit(0);
