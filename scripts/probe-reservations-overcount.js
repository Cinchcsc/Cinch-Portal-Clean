// The Reservations vs Move-outs KPI is reporting ~1471 active reservations portfolio-wide vs a
// true figure around ~446 on the legacy portal — about 3x too high. Working theory: ReservationList
// (CallCenterWs.asmx) returns reservations going back a long time, and some of those rows never get
// their dNeeded cleared or dCancelled set even after the prospect actually moved in and became a
// real tenant — so our filter (not cancelled + dNeeded in the future) still counts them as "open".
// This checks that theory directly: for each "active-looking" reservation row (not cancelled, dNeeded
// in the future), does its TenantID already show up as a CURRENTLY OCCUPIED unit in RentRoll? If so,
// that reservation has already converted and should NOT be counted as still-open.
// PII-SAFE: only prints counts/overlap statistics, never tenant names or contact info.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-reservations-overcount.js
import soap from 'soap';
import { extractRows, checkReturnCode, callReport } from '../lib/sitelink.js';

const REPORTING_WSDL = process.env.SITELINK_WSDL || '';
const CCWS_WSDL = REPORTING_WSDL.replace(/ReportingWs\.asmx/i, 'CallCenterWs.asmx');
const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];

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
const resRows = extractRows(result);

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const isBlank = (v) => v === undefined || v === null || v === '' || v === '0001-01-01T00:00:00';
const activeLooking = resRows.filter(r => isBlank(r.dCancelled) && !isBlank(r.dNeeded) && new Date(r.dNeeded) > now);
console.log(`site ${loc}: ${resRows.length} total reservation rows, ${activeLooking.length} pass our current filter (not cancelled + dNeeded in future)`);

const { rows: rrRows } = await callReport('RentRoll', loc, start, now);
const occupiedTenantIds = new Set(rrRows.filter(r => String(r.bRented) === 'true' || r.bRented === true || r.bRented === 1).map(r => String(r.TenantID)));
console.log(`RentRoll: ${rrRows.length} total rows, ${occupiedTenantIds.size} distinct occupied TenantIDs`);

const alreadyMovedIn = activeLooking.filter(r => occupiedTenantIds.has(String(r.TenantID)));
console.log(`\nOf the ${activeLooking.length} "active-looking" reservations, ${alreadyMovedIn.length} have a TenantID that is ALREADY an occupied unit in RentRoll (i.e. they moved in — should NOT be counted as still-open).`);
console.log(`True still-open count would be: ${activeLooking.length - alreadyMovedIn.length}`);

console.log('\nQTRentalStatusID breakdown of the already-moved-in group (to see if a status code cleanly identifies this):');
const statusCounts = {};
for (const r of alreadyMovedIn) { const k = String(r.QTRentalStatusID); statusCounts[k] = (statusCounts[k] || 0) + 1; }
for (const [k, n] of Object.entries(statusCounts)) console.log(`  status=${k}: ${n}`);

console.log('\nQTRentalStatusID breakdown of the genuinely-still-open group:');
const stillOpen = activeLooking.filter(r => !occupiedTenantIds.has(String(r.TenantID)));
const statusCounts2 = {};
for (const r of stillOpen) { const k = String(r.QTRentalStatusID); statusCounts2[k] = (statusCounts2[k] || 0) + 1; }
for (const [k, n] of Object.entries(statusCounts2)) console.log(`  status=${k}: ${n}`);
process.exit(0);
