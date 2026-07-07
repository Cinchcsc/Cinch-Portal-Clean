// Follow-up to probe-reservations.js: ReportingWs.asmx has NO reservation-related report method
// (confirmed 2 Jul 2026 — 63 methods listed, none matching /reserv/i). Earlier in this project we
// found CallCenterWs.asmx exposes reservation/payment/marketing methods instead of reporting
// methods (that's why we switched to ReportingWs for the regular pulls) — so this checks
// CallCenterWs.asmx specifically for a reservation-list method the "Reservations vs Move-outs"
// KPI widget needs.
// PII-SAFE: only prints method names, and (if a candidate is called) row/column shape — never
// prints tenant-level data beyond what's needed to identify the right fields.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-reservations-ccws.js
import soap from 'soap';

const REPORTING_WSDL = process.env.SITELINK_WSDL || '';
const CCWS_WSDL = REPORTING_WSDL.replace(/ReportingWs\.asmx/i, 'CallCenterWs.asmx');
if (CCWS_WSDL === REPORTING_WSDL) {
  console.log('Could not derive CallCenterWs URL from SITELINK_WSDL (' + REPORTING_WSDL + ') — check it manually.');
  process.exit(1);
}
console.log('CallCenterWs WSDL:', CCWS_WSDL, '\n');

const client = await soap.createClientAsync(CCWS_WSDL);
const methods = Object.keys(client).filter((k) => k.endsWith('Async')).map((k) => k.replace(/Async$/, ''));
console.log(`CallCenterWs exposes ${methods.length} methods.\n`);
console.log('ALL METHODS:\n' + methods.join(', '));

const candidates = methods.filter((m) => /reserv/i.test(m));
console.log('\nCANDIDATE METHODS (name hints at "reservation"):');
console.log(candidates.join(', ') || '(none found by name either — Reservations may need a different SiteLink API entirely.)');

if (candidates.length) {
  console.log('\nDescribing each candidate (parameter shape):');
  const desc = client.describe();
  for (const m of candidates) {
    for (const svc of Object.values(desc)) for (const port of Object.values(svc)) {
      if (port[m]) console.log(`\n${m}:`, JSON.stringify(port[m], null, 2));
    }
  }
}
process.exit(0);
