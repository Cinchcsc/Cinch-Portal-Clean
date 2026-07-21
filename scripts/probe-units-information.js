// PROBE (21 Jul 2026, follow-up to list-all-wsdl-methods.js / describe-units-information.js):
// now that UnitsInformation* is confirmed to exist on CallCenterWs, make a REAL live call and dump
// the returned row shape. This answers the next gating question for Occupancy by Floor: does the
// API expose floor and occupancy/rentable flags directly, or only generic unit metadata?
//
// Usage:
//   node --env-file=.env scripts/probe-units-information.js <LOCATION> [METHOD] [JSON_EXTRA_ARGS]
//
// Examples:
//   node --env-file=.env scripts/probe-units-information.js L001
//   node --env-file=.env scripts/probe-units-information.js L001 UnitsInformation_v2 '{"lngLastTimePolled":"0"}'
//   node --env-file=.env scripts/probe-units-information.js L001 UnitsInformation_v3 '{"lngLastTimePolled":"0","bReturnExcludedFromWebsiteUnits":true}'
import { callCallCenterMethod, describeCcws } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) {
  console.error('Missing env:', miss.join(', '));
  process.exit(1);
}

const locationCode = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!locationCode) {
  console.error('Usage: node --env-file=.env scripts/probe-units-information.js <LOCATION> [METHOD] [JSON_EXTRA_ARGS]');
  console.error('No LOCATION arg provided and SITELINK_LOCATIONS is blank.');
  process.exit(1);
}

const method = (process.argv[3] || 'UnitsInformation').trim();
let extraArgs = {};
if (process.argv[4]) {
  try { extraArgs = JSON.parse(process.argv[4]); }
  catch (e) {
    console.error(`Could not parse JSON_EXTRA_ARGS: ${e.message}`);
    process.exit(1);
  }
}

console.log(`Location: ${locationCode}`);
console.log(`Method:   ${method}`);
console.log(`Args:     ${JSON.stringify(extraArgs)}`);

try {
  const d = await describeCcws();
  const port = Object.values(Object.values(d)[0])[0];
  if (port[method]) console.log('Input params:', JSON.stringify(port[method].input));
  else console.log(`Method ${method} is not present on this CallCenter WSDL.`);
} catch (e) {
  console.log('describeCcws() failed:', e.message);
}

try {
  const { rows, raw } = await callCallCenterMethod(method, locationCode, extraArgs);
  console.log(`\nReturned ${rows.length} row(s).`);
  if (rows[0]) {
    console.log('REAL COLUMNS →', Object.keys(rows[0]).join(', '));
    console.log('SAMPLE ROW →', JSON.stringify(rows[0]).slice(0, 1800));
    if (rows.length > 1) console.log('SECOND ROW  →', JSON.stringify(rows[1]).slice(0, 1800));
  } else {
    console.log('RAW (first 1800 chars) →', JSON.stringify(raw).slice(0, 1800));
  }
} catch (e) {
  console.error(`\n${method} call failed: ${e.message}`);
  process.exit(1);
}
