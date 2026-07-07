// CallCenterWs.asmx's ReservationList is the candidate found by probe-reservations-ccws.js for the
// "Reservations vs Move-outs" KPI widget (legacy tooltip, confirmed 2 Jul 2026: Reservation List ->
// Converted To RSV, not cancelled, not moved in, in the future). It takes no date range — just
// iGlobalWaitingNum (0 likely means "all") — so it probably returns the whole current waiting list,
// which is inherently "not yet moved in" by definition. This dumps its real row shape (status flags,
// dates, cancellation reason etc.) so we can write a parser matching the tooltip's exact filter
// ("Converted To RSV" + not cancelled + not moved in + Needed date in the future).
// PII-SAFE NOTE: ReservationList rows likely include a prospective tenant name/phone/etc (it's a
// waiting-list/CRM report, not an aggregated summary) — this script prints the column NAMES always,
// but only prints full row VALUES if you pass --show-values, so we don't dump PII by default.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-reservationlist.js [--show-values]
import soap from 'soap';
import { extractRows, checkReturnCode } from '../lib/sitelink.js';

const REPORTING_WSDL = process.env.SITELINK_WSDL || '';
const CCWS_WSDL = REPORTING_WSDL.replace(/ReportingWs\.asmx/i, 'CallCenterWs.asmx');
const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const showValues = process.argv.includes('--show-values');

const client = await soap.createClientAsync(CCWS_WSDL);
const user = (process.env.SITELINK_CORP_USER || '').split(':::')[0];
const args = {
  sCorpCode: process.env.SITELINK_CORP_CODE,
  sLocationCode: loc,
  sCorpUserName: `${user}:::${process.env.SITELINK_LICENSE_KEY}`,
  sCorpPassword: process.env.SITELINK_CORP_PASSWORD,
  iGlobalWaitingNum: 0,
};

console.log(`ReservationList · site ${loc}\n`);
const [result] = await client.ReservationListAsync(args);
try { checkReturnCode(result); } catch (e) { console.log('SiteLink error:', e.message); process.exit(e.retCode === -1 ? 0 : 1); }

const rows = extractRows(result);
console.log('row count:', rows.length);
if (!rows.length) { console.log('no rows — try a site with a busier waiting list, or confirm iGlobalWaitingNum=0 means "all".'); process.exit(0); }

const cols = Object.keys(rows[0]).filter((k) => !/^(diffgr|msdata)/i.test(k));
console.log('\nALL COLUMNS:\n' + cols.join(', '));

console.log('\nVALUE HISTOGRAMS for every column with <=12 distinct values (status/flag candidates):');
for (const c of cols) {
  const vals = {};
  for (const r of rows) { const v = String(r[c] ?? '(blank)'); vals[v] = (vals[v] || 0) + 1; }
  const distinct = Object.keys(vals);
  if (distinct.length >= 1 && distinct.length <= 12) {
    console.log(`\n${c}:`);
    for (const [v, n] of Object.entries(vals).sort((a, b) => b[1] - a[1])) console.log(`  ${v.padEnd(20)} ${n}`);
  }
}

if (showValues) {
  console.log('\nFIRST ROW (all columns + values) — may contain a prospective tenant name/phone, only shown because --show-values was passed:');
  for (const c of cols) console.log(`  ${c.padEnd(25)} ${rows[0][c]}`);
} else {
  console.log('\n(Pass --show-values to also print one full row — omitted by default since this report may include a name/phone.)');
}
process.exit(0);
