// Follow-up to check-discounts-breakdown.js: G019/S047A/G015 each appeared twice in the July
// move-in-filtered sample. Need to know if these are the same ChargeID (real duplicate/bug) or
// different ChargeID/sChgDesc (legitimate separate charge lines that should be summed, not
// deduplicated) before trusting any count or average built from this report.
// Run: node --env-file=.env scripts/check-discounts-duplicates.js [siteCode] [YYYY-MM]
import { callReport } from '../lib/sitelink.js';
const siteCode = process.argv[2] || 'L001';
const monthArg = process.argv[3];
const now = new Date();
let start, end, y, m;
if (monthArg) { [y, m] = monthArg.split('-').map(Number); start = new Date(y, m - 1, 1); end = new Date(y, m, 0); }
else { y = now.getFullYear(); m = now.getMonth() + 1; start = new Date(y, m - 1, 1); end = now; }
const { rows } = await callReport('Discounts', siteCode, start, end);

const byUnit = {};
for (const r of rows) (byUnit[r.sUnitName] ??= []).push(r);

console.log('=== Units appearing more than once in the raw result ===');
for (const [unit, rs] of Object.entries(byUnit)) {
  if (rs.length < 2) continue;
  console.log(`\n${unit} (${rs.length} rows):`);
  for (const r of rs) {
    console.log(`  ChargeID=${r.ChargeID} sChgDesc=${r.sChgDesc} dChgStrt=${String(r.dChgStrt).slice(0,10)} dcAmt=${r.dcAmt} dcDiscount=${r.dcDiscount} plan=${r.sConcessionPlan}`);
  }
}
console.log(`\nTotal rows: ${rows.length}, distinct ChargeIDs: ${new Set(rows.map(r => r.ChargeID)).size}, distinct units: ${new Set(rows.map(r => r.sUnitName)).size}`);
process.exit(0);
