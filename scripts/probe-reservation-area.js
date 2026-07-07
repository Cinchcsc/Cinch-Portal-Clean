// Checks whether ReservationList (CallCenterWs.asmx) carries a unit size/area column at all, before
// building a "Reserved Scheduled Sqft" KPI widget on top of it. PII-SAFE: only prints column names,
// counts, and numeric samples — never name/phone/email/comment fields.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-reservation-area.js
import soap from 'soap';
import { extractRows, checkReturnCode } from '../lib/sitelink.js';

const REPORTING_WSDL = process.env.SITELINK_WSDL || '';
const CCWS_WSDL = REPORTING_WSDL.replace(/ReportingWs\.asmx/i, 'CallCenterWs.asmx');
const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const loc = locations[0];

const client = await soap.createClientAsync(CCWS_WSDL);
const user = (process.env.SITELINK_CORP_USER || '').split(':::')[0];
const args = {
  sCorpCode: process.env.SITELINK_CORP_CODE,
  sLocationCode: loc,
  sCorpUserName: `${user}:::${process.env.SITELINK_LICENSE_KEY}`,
  sCorpPassword: process.env.SITELINK_CORP_PASSWORD,
  iGlobalWaitingNum: 0,
};
const [result] = await client.ReservationListAsync(args);
checkReturnCode(result);
const rows = extractRows(result);
console.log(`${rows.length} total rows for site ${loc}\n`);
if (!rows.length) { console.log('No rows returned — cannot inspect columns.'); process.exit(0); }

console.log('All column names on a ReservationList row:');
console.log(Object.keys(rows[0]).sort().join('\n'));

const sizeLike = Object.keys(rows[0]).filter(k => /size|area|width|length|sqft|dc(w|l)/i.test(k));
console.log('\nColumns that LOOK size/area-related:', sizeLike.length ? sizeLike.join(', ') : '(none found)');
if (sizeLike.length) {
  console.log('\nSample values (first 5 rows):');
  for (const r of rows.slice(0, 5)) console.log(Object.fromEntries(sizeLike.map(k => [k, r[k]])));
}
