// Follow-up to dump-incomeanalysis-tables.js, which found the real value columns: dcSubCol (£) and
// dcPercent, sitting on every row except the first ("Gross Potential" — likely the base/denominator
// row the percentages are computed against). Cash vs Accrual are the two accounting bases of the
// SAME category breakdown, not two different reports. This prints the FULL category list (all
// 60-65 rows, not just the first 3) for both tables, so we can see: (a) does a "Merchandise" line
// exist here with an independent £ figure we haven't tried as a numerator yet, and (b) is there
// anything resembling a customer/new-mover COUNT anywhere in this report at all (IncomeAnalysis has
// no obvious count column so far — SiteID/iOrder/sDesc/dcSubCol/dcPercent — but worth confirming
// across every row rather than assuming from 3 samples).
// Run: cd cinch-portal-clean && node --env-file=.env scripts/dump-incomeanalysis-categories.js [siteCode] [YYYY-MM]
import { callReport, extractNamedTable } from '../lib/sitelink.js';

const siteCode = process.argv[2] || 'L001';
const monthArg = process.argv[3];
const now = new Date();
let start, end;
if (monthArg) {
  const [y, m] = monthArg.split('-').map(Number);
  start = new Date(y, m - 1, 1);
  const fullMonthEnd = new Date(y, m, 0);
  const isCurrentMonth = y === now.getFullYear() && m === now.getMonth() + 1;
  end = isCurrentMonth && fullMonthEnd > now ? now : fullMonthEnd;
} else {
  start = new Date(now.getFullYear(), now.getMonth(), 1);
  end = now;
}
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
console.log(`=== IncomeAnalysis full category list, ${siteCode}, ${fmt(start)} to ${fmt(end)} ===\n`);

const { raw } = await callReport('IncomeAnalysis', siteCode, start, end);

for (const tableName of ['Cash', 'Accrual']) {
  const rows = extractNamedTable(raw, tableName);
  console.log(`--- ${tableName} (${rows.length} rows) ---`);
  for (const r of rows) {
    const flag = /merch|new.?cust|customer|mover/i.test(r.sDesc || '') ? '  <-- FLAGGED' : '';
    console.log(`  iOrder=${r.iOrder}  ${(r.sDesc || '').padEnd(28)} dcSubCol=${r.dcSubCol ?? '(none)'}  dcPercent=${r.dcPercent ?? '(none)'}${flag}`);
  }
  console.log('');
}
process.exit(0);
