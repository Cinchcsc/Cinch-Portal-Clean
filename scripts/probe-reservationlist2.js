// Follow-up to probe-reservationlist.js: QTRentalStatusID/QTRentalTypeID/dCancelled/dNeeded need to
// be correlated to find which combination matches the legacy tooltip's exact filter (confirmed 2 Jul
// 2026): "Converted To RSV and Needed is not cancelled, is not moved in, is in the future."
// PII-SAFE: only prints counts/correlations and date fields, never name/phone/comment fields.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-reservationlist2.js
import soap from 'soap';
import { extractRows, checkReturnCode } from '../lib/sitelink.js';

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
const rows = extractRows(result);
console.log(`${rows.length} total rows for site ${loc}\n`);

const now = new Date();
const isBlank = (v) => v === undefined || v === null || v === '' || v === '0001-01-01T00:00:00';
const parseDate = (v) => isBlank(v) ? null : new Date(v);

// 1) QTRentalStatusID x QTRentalTypeID cross-tab
console.log('QTRentalStatusID x QTRentalTypeID counts:');
const cross = {};
for (const r of rows) { const k = `status=${r.QTRentalStatusID} type=${r.QTRentalTypeID}`; cross[k] = (cross[k] || 0) + 1; }
for (const [k, n] of Object.entries(cross).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);

// 2) dCancelled populated?
const cancelled = rows.filter(r => !isBlank(r.dCancelled));
console.log(`\ndCancelled populated (i.e. actually cancelled): ${cancelled.length} / ${rows.length}`);
if (cancelled.length) console.log('  sample dCancelled values:', cancelled.slice(0, 3).map(r => r.dCancelled));

// 3) QTCancellationTypeID distinct values (why it didn't show up in the <=12-distinct histogram)
const cancelTypes = {};
for (const r of rows) { const v = String(r.QTCancellationTypeID ?? '(blank)'); cancelTypes[v] = (cancelTypes[v] || 0) + 1; }
console.log(`\nQTCancellationTypeID distinct values: ${Object.keys(cancelTypes).length}`);
for (const [v, n] of Object.entries(cancelTypes).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${v.padEnd(10)} ${n}`);

// 4) dNeeded in the future vs past (relative to now)
const future = rows.filter(r => { const d = parseDate(r.dNeeded); return d && d > now; });
const past = rows.filter(r => { const d = parseDate(r.dNeeded); return d && d <= now; });
console.log(`\ndNeeded in the future: ${future.length}  |  dNeeded in the past/today: ${past.length}  |  blank: ${rows.length - future.length - past.length}`);

// 5) Candidate "active reservation" counts under a few plausible filter combinations, cross-tabbed
//    by QTRentalStatusID so we can see which status value corresponds to "still an open reservation"
//    (moved in / converted rows should have moved OUT of whatever status means "waiting").
console.log('\nFor dNeeded-in-the-future rows only, breakdown by QTRentalStatusID and dCancelled:');
const futureCross = {};
for (const r of future) {
  const k = `status=${r.QTRentalStatusID} cancelled=${!isBlank(r.dCancelled)}`;
  futureCross[k] = (futureCross[k] || 0) + 1;
}
for (const [k, n] of Object.entries(futureCross).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);

// 6) dUpdated / dCreated / dPlaced sanity — confirm dNeeded is the right "move-in wanted by" date
//    field (vs dPlaced = when the reservation was made).
console.log('\nSample of dPlaced vs dNeeded vs dExpires (first 5 rows, dates only — no tenant/unit identifiers):');
for (const r of rows.slice(0, 5)) console.log(`  placed=${r.dPlaced}  needed=${r.dNeeded}  expires=${r.dExpires}  cancelled=${r.dCancelled}  status=${r.QTRentalStatusID}  type=${r.QTRentalTypeID}`);
process.exit(0);
