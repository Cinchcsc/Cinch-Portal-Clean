// Dumps the Month-on-Month "Self Storage Rate" trend (lib/buildPayload.js's buildHistory(), same
// data the MoM page charts) across every stored month, to spot an anomaly without needing to open
// the UI. Likely suspects for something "looking off": (a) a month captured under an OLDER, since-
// fixed version of the Rate/ft² formula (raw_report stores the PARSED OUTPUT at pull time, and
// once a month is locked/closed it is never re-parsed, so formula fixes made THIS session don't
// retroactively apply to already-captured historical months), or (b) a month with very little/no
// rent_roll self-storage data producing a near-zero or wildly skewed rate.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-mom-ssrate.js
import { buildPayloadRange, listStoredMonths } from '../lib/buildPayload.js';

const months = await listStoredMonths();
console.log(`${months.length} stored months\n`);
console.log('month      ssRate   ssAreaSum   ssRentSum   occ');
for (const mk of months) {
  const [y, m] = mk.split('-').map(Number);
  const p = await buildPayloadRange(new Date(y, m - 1, 1), new Date(y, m - 1, 1));
  const ssAreaSum = p.sites.reduce((a, s) => a + (s.ssAreaSum || 0), 0);
  const ssRentSum = p.sites.reduce((a, s) => a + (s.ssRentSum || 0), 0);
  console.log(`${mk}   £${(p.totals.ssRate ?? 0).toFixed(2).padStart(7)}   ${String(Math.round(ssAreaSum)).padStart(9)}   ${String(Math.round(ssRentSum)).padStart(9)}   ${p.totals.occ}`);
}
process.exit(0);
