// Finds the real ManagementSummary rows/columns SiteLink uses for Delinquency and Occupied Unit
// Rates, so we can implement the authoritative Debtor Levels formula (legacy portal tooltip,
// confirmed 2 Jul 2026):
//   Tenant %   = ManagementSummary -> Delinquency -> Units  /  ManagementSummary -> Occupancy -> Occupied Units
//   Rent Roll% = ManagementSummary -> Delinquency -> Total  /  ManagementSummary -> Occupancy -> Actual Occupied Unit Rates
// The current management parser (lib/reportMap.js) only reads rows by sDesc label for move-ins/
// outs/transfers/leads (iDCount/iMCount/iYCount) — it has never looked for a Delinquency or
// Occupied-Unit-Rates line item, so this dumps EVERY row's sDesc + all numeric columns to find them.
// PII-SAFE: ManagementSummary rows are portfolio/site summary line items (labeled totals), not
// tenant-level data, so this is safe to print in full.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-debtor.js
import { callReport } from '../lib/sitelink.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const end = now;

console.log(`ManagementSummary · site ${loc} · ${start.toISOString().slice(0, 10)} -> ${end.toISOString().slice(0, 10)}\n`);
const { rows } = await callReport('ManagementSummary', loc, start, end);
console.log('row count:', rows.length);
if (!rows.length) { console.log('no rows for this period.'); process.exit(0); }

const cols = Object.keys(rows[0]).filter((k) => !/^(diffgr|msdata)/i.test(k));
console.log('\nALL COLUMNS:\n' + cols.join(', '));

console.log('\nEVERY ROW (sDesc + all columns) — look for a "Delinquen*" or "Occupied Unit Rate*" label:');
for (const r of rows) {
  console.log('-'.repeat(60));
  for (const c of cols) console.log(`  ${c.padEnd(20)} ${r[c]}`);
}

console.log('\n\nCANDIDATE ROWS (sDesc hints at delinquency/occupied/rate):');
for (const r of rows) {
  if (/delinquen|occupied|rate/i.test(String(r.sDesc ?? ''))) {
    console.log(`  sDesc="${r.sDesc}"  ` + cols.filter(c => c !== 'sDesc').map(c => `${c}=${r[c]}`).join('  '));
  }
}
process.exit(0);
