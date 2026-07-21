import { client, ccwsClient } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const flag = (name) => /unit|status|floor/i.test(name) ? '  >>> ' : '      ';

console.log('=== ReportingWs.asmx ===');
console.log('URL:', process.env.SITELINK_WSDL);
try {
  const c = await client();
  const methods = Object.keys(c).filter((k) => k.endsWith('Async')).map((k) => k.replace(/Async$/, ''));
  console.log(`${methods.length} methods:\n`);
  methods.sort().forEach((m) => console.log(flag(m) + m));
} catch (e) { console.log('FAILED to connect:', e.message); }

console.log('\n=== CallCenterWs.asmx ===');
console.log('URL:', (process.env.SITELINK_CCWS_WSDL || '(not set)'));
try {
  const cc = await ccwsClient();
  const methods = Object.keys(cc).filter((k) => k.endsWith('Async')).map((k) => k.replace(/Async$/, ''));
  console.log(`${methods.length} methods:\n`);
  methods.sort().forEach((m) => console.log(flag(m) + m));
} catch (e) { console.log('FAILED to connect:', e.message); }
process.exit(0);
