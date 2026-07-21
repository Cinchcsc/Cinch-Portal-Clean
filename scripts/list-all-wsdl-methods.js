// One-off diagnostic (21 Jul 2026) — Michael pushed back on the "UnitStatus isn't a callable SOAP
// method" claim while looking at the Unit Status report live in SiteLink's own UI. That claim was
// based on an earlier probe (scripts/verify-new-widget-sources.js, deleted 13 Jul cleanup) that only
// checked ReportingWs.asmx, plus a separate, less certain check of CallCenterWs.asmx. Rather than
// keep asserting the old conclusion, this prints the COMPLETE, unfiltered method list from BOTH
// WSDLs SiteLink exposes, so anyone can eyeball it directly instead of trusting a summary. No
// filtering/fuzzy-matching — every method name is printed, "unit"/"status"/"floor" ones are just
// marked with ">>>" so they're easy to spot in a long list.
// Run locally:  npm run list:wsdl-methods
import { client, ccwsClient } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', '), '\nRun: node --env-file=.env scripts/list-all-wsdl-methods.js'); process.exit(1); }

const flag = (name) => /unit|status|floor/i.test(name) ? '  >>> ' : '      ';

console.log('=== ReportingWs.asmx ===');
console.log('URL:', process.env.SITELINK_WSDL);
try {
  const c = await client();
  const methods = Object.keys(c).filter((k) => k.endsWith('Async')).map((k) => k.replace(/Async$/, ''));
  console.log(`${methods.length} methods:\n`);
  methods.sort().forEach((m) => console.log(flag(m) + m));
} catch (e) {
  console.log('FAILED to connect:', e.message);
}

console.log('\n=== CallCenterWs.asmx ===');
console.log('URL:', (process.env.SITELINK_CCWS_WSDL || '(not set — falling back to derived URL, see lib/sitelink.js ccwsClient())'));
try {
  const cc = await ccwsClient();
  const methods = Object.keys(cc).filter((k) => k.endsWith('Async')).map((k) => k.replace(/Async$/, ''));
  console.log(`${methods.length} methods:\n`);
  methods.sort().forEach((m) => console.log(flag(m) + m));
} catch (e) {
  console.log('FAILED to connect:', e.message);
}

console.log('\nDone. Anything marked >>> above containing "Unit"/"Status"/"Floor" is worth telling Claude about verbatim — that\'s the whole point of this script.');
process.exit(0);
