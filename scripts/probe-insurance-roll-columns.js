// Live SiteLink call (one site, current period) to get InsuranceRoll's REAL column names — needed
// because lib/reportMap.js's insurance_roll parser assumes a `TenantID` column (same name as
// RentRoll's), but insured_tenants is coming back empty even when insured_units is nonzero,
// suggesting the actual column is named differently on this report.
// PII-SAFE: prints only column NAMES, never a sample row (InsuranceRoll is tenant-level).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-insurance-roll-columns.js
import { callReport } from '../lib/sitelink.js';

const loc = (process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',')[0] || '').trim();
if (!loc) { console.error('No site code given and SITELINK_LOCATIONS not set'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

const { rows } = await callReport('InsuranceRoll', loc, start, now);
console.log(`Site ${loc}: ${rows ? rows.length : 0} rows`);
if (rows && rows[0]) {
  console.log('COLUMNS:', Object.keys(rows[0]).join(', '));
  const tenantIdLike = Object.keys(rows[0]).filter(k => /tenant/i.test(k));
  console.log('\nColumns containing "tenant":', tenantIdLike.length ? tenantIdLike.join(', ') : '(none found)');
  const activeLike = Object.keys(rows[0]).filter(k => /active/i.test(k));
  console.log('Columns containing "active":', activeLike.length ? activeLike.join(', ') : '(none found)');
} else {
  console.log('No rows returned.');
}
process.exit(0);
