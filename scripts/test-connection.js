// Confirms credentials + WSDL, prints the real method + parameter names (describe), and makes
// one live OccupancyStatistics call to reveal the actual COLUMN names — which is what we need to
// finalise the field mapping in reportMap.js. Run locally:  npm run test:connection
import { describe, listMethods, callReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter(k => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', '), '\nFill .env (see .env.example) then run: node --env-file=.env scripts/test-connection.js'); process.exit(1); }

console.log('WSDL:', process.env.SITELINK_WSDL);
const methods = await listMethods();
console.log(`\n✓ Connected. ${methods.length} SOAP methods. The reports we use:`);
['OccupancyStatistics', 'RentRoll', 'ManagementSummary', 'MoveInsAndMoveOuts', 'PastDueBalances', 'ScheduledMoveOuts',
 'InsuranceRoll', 'InsuranceActivity', 'InquiryTracking', 'MarketingSummary', 'MerchandiseSummary', 'FinancialSummary',
 'TenantRentChangeHistory'].forEach(m => console.log('   ', methods.includes(m) ? '✓' : '✗ MISSING', m));

try {
  const d = await describe();
  const port = Object.values(Object.values(d)[0])[0];
  if (port.OccupancyStatistics) console.log('\nOccupancyStatistics input params:', JSON.stringify(port.OccupancyStatistics.input));
} catch (e) { console.log('describe() failed:', e.message); }

const loc = (process.env.SITELINK_LOCATIONS || '').split(',')[0];
if (loc) {
  const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth(), 1);
  try {
    const { rows, raw } = await callReport('OccupancyStatistics', loc, start, now);
    console.log(`\n✓ OccupancyStatistics ${loc}: ${rows.length} rows`);
    if (rows[0]) { console.log('REAL COLUMNS →', Object.keys(rows[0]).join(', ')); console.log('SAMPLE ROW →', JSON.stringify(rows[0]).slice(0, 900)); }
    else { console.log('RAW (first 1500 chars) →', JSON.stringify(raw).slice(0, 1500)); }
  } catch (e) { console.log('\nOccupancyStatistics call:', e.message); }
}
process.exit(0);
