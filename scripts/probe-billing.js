// Find the RentRoll field that flags billing frequency (4-weekly vs monthly), so we can
// annualise the contracted rate correctly: ×13 for 4-weekly, ×12 for monthly.
// PII-SAFE: prints only column NAMES and the distinct values of billing/period-type fields.
//   node --env-file=.env scripts/probe-billing.js [LOC]
import { callReport } from '../lib/sitelink.js';

const loc = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',')[0].trim();
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);   // this month to date
const { rows } = await callReport('RentRoll', loc, start, now);
console.log(`RentRoll ${loc}: ${rows.length} rows`);
if (!rows.length) { console.log('no rows'); process.exit(0); }

console.log('\nALL COLUMNS:\n' + Object.keys(rows[0]).join(', '));

const occ = rows.filter(r => String(r.bRented) === '1' || /^(1|true|yes)$/i.test(String(r.bRented ?? '')));
const re = /period|freq|cycle|bill|interval|day|week|month|anniv|sched|type/i;
const keys = Object.keys(rows[0]).filter(k => re.test(k));
console.log(`\nBILLING-CANDIDATE fields — distinct values across ${occ.length} occupied units:`);
for (const k of keys) {
  const counts = {};
  for (const r of occ) { const v = String(r[k]); counts[v] = (counts[v] || 0) + 1; }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => `${v}×${n}`);
  console.log(`  ${k}: ${top.join(', ')}`);
}
// correlate dcRent with each candidate for 4 occupied units (rate fields only — no PII)
console.log('\nSAMPLE (dcRent + candidate fields only):');
occ.slice(0, 4).forEach(r => {
  const o = { dcRent: r.dcRent, Area: r.Area ?? r.Area1 };
  for (const k of keys) o[k] = r[k];
  console.log('  ' + JSON.stringify(o));
});
process.exit(0);
