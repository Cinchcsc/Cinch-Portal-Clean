// One-off: confirm the standalone "Discounts" SOAP method's real shape (as opposed to the
// $-totals-only "Discounts" table embedded inside ManagementSummary, already ruled insufficient).
// Run: node --env-file=.env scripts/check-discounts-method.js [siteCode] [YYYY-MM]
import { callReport } from '../lib/sitelink.js';
const siteCode = process.argv[2] || 'L001';
const monthArg = process.argv[3];
let start, end;
if (monthArg) {
  const [y, m] = monthArg.split('-').map(Number);
  start = new Date(y, m - 1, 1); end = new Date(y, m, 0);
} else { start = new Date(new Date().getFullYear(), new Date().getMonth(), 1); end = new Date(); }
const { rows } = await callReport('Discounts', siteCode, start, end);
console.log(`${rows.length} rows\n`);
for (const r of rows.slice(0, 10)) console.log(JSON.stringify(r));
process.exit(0);
