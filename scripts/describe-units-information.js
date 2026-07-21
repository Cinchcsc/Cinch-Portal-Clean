// Follow-up to list-all-wsdl-methods.js (21 Jul 2026) — Michael's live method dump turned up
// UnitsInformation (+ variants) on CallCenterWs.asmx, which the earlier UnitStatus check never
// matched (it only searched for the literal word "status"). This prints each variant's real input
// parameter names/types from the WSDL's own describe() output, so we know how to actually call one
// without guessing blind. Run locally:  node --env-file=.env scripts/describe-units-information.js
import { describeCcws } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const candidates = [
  'UnitsInformation', 'UnitsInformation_v2', 'UnitsInformation_v3',
  'UnitsInformationAvailableUnitsOnly', 'UnitsInformationAvailableUnitsOnly_v2',
  'UnitsInformationByUnitID', 'UnitsInformationByUnitName', 'UnitsInformationInternal',
];

const d = await describeCcws();
const port = Object.values(Object.values(d)[0])[0];

for (const name of candidates) {
  if (!port[name]) { console.log(`\n${name}: NOT on this WSDL`); continue; }
  console.log(`\n=== ${name} ===`);
  console.log('input: ', JSON.stringify(port[name].input));
  if (port[name].output) console.log('output:', JSON.stringify(port[name].output));
}
process.exit(0);
