// Verifies the new True Revenue integration (CustomReportByReportID, ReportID 781861 — "Financial \
// True Revenue Report - Daily Prorate", aka "Daily Pro Rate") actually works against this account's
// WSDL before trusting a full pull. Confirmed working in an earlier version of this project via
// Python/zeep — this checks the same call works through our Node/soap client.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-true-revenue.js
import { callCustomReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);

console.log(`site ${loc} · ReportID 781861 · ${start.toDateString()} -> ${end.toDateString()}\n`);
const { rows } = await callCustomReport(781861, loc, start, end);
console.log('total rows:', rows.length);
if (!rows.length) { console.log('No rows returned — check the WSDL supports this method, or try a different date range.'); process.exit(0); }

console.log('\nCOLUMNS:', Object.keys(rows[0]).filter(k => !/^(diffgr|msdata)/i.test(k)).join(', '));

const parsed = REPORTS.true_revenue.parse(rows);
console.log('\nBy ChargeDesc:');
for (const r of parsed.by_desc) console.log(`  ${r.desc.padEnd(24)} truePeriod=£${r.truePeriod.toFixed(2)}`);
const totalTruePeriod = parsed.by_desc.reduce((a, r) => a + r.truePeriod, 0);
console.log(`\nTOTAL True Period (this site, this month): £${totalTruePeriod.toFixed(2)}`);

console.log('\nBy UnitType:');
for (const r of parsed.by_type) console.log(`  ${r.desc.padEnd(24)} truePeriod=£${r.truePeriod.toFixed(2)}`);
process.exit(0);
