// From probe-report-catalog.js's diff against Michael's legacy report-picker screenshot: "Income
// Analysis" is a REAL, untested SOAP method (IncomeAnalysis) neither of us had pulled before. First
// look — print row count, columns, and a values-only sample (no field names assumed PII-safe until
// we've actually SEEN the shape; if a column looks like a tenant name/email we redact it rather than
// guess). Purpose: does this report break income down by category in a way that already isolates
// "new customer" merchandise, or is it just another revenue-by-ChargeDesc cut like True Revenue/
// FinancialSummary (in which case it doesn't help and we move to ConsolidatedManagementSummary next).
// Run: cd cinch-portal-clean && node --env-file=.env scripts/probe-income-analysis.js [siteCode] [YYYY-MM]
import { callReport } from '../lib/sitelink.js';

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
console.log(`=== IncomeAnalysis probe, ${siteCode}, ${fmt(start)} to ${fmt(end)} ===\n`);

const { rows, raw } = await callReport('IncomeAnalysis', siteCode, start, end);
console.log(`${rows.length} row(s) returned.`);
if (!rows.length) {
  console.log('No rows — dumping raw response shape instead:');
  console.log(JSON.stringify(raw).slice(0, 2000));
  process.exit(0);
}
const cols = Object.keys(rows[0]);
console.log(`Columns (${cols.length}): ${cols.join(', ')}\n`);

// Flag anything that LOOKS like it could carry PII by column name, so we know what to redact before
// printing sample rows.
const piiLike = cols.filter((c) => /name|email|phone|address|tenant|customer/i.test(c) && !/^i|count|num$/i.test(c));
if (piiLike.length) console.log(`(!) Columns that look like they might carry PII, redacting from the sample below: ${piiLike.join(', ')}\n`);

console.log('Sample rows (up to 5), PII-flagged columns redacted:');
for (const r of rows.slice(0, 5)) {
  const safe = {};
  for (const c of cols) safe[c] = piiLike.includes(c) ? '[redacted]' : r[c];
  console.log(JSON.stringify(safe));
}

// If there's an obvious numeric/category column set, also print portfolio-agnostic totals per
// distinct category-like column (first non-PII string column) so we can see the shape of the
// breakdown without needing every row.
const catCol = cols.find((c) => !piiLike.includes(c) && typeof rows[0][c] === 'string' && !/^d|^i[A-Z]/.test(c));
if (catCol) {
  const byCat = {};
  for (const r of rows) { const k = r[catCol] || '(blank)'; byCat[k] = (byCat[k] || 0) + 1; }
  console.log(`\nRow counts by "${catCol}":`);
  for (const [k, v] of Object.entries(byCat)) console.log(`  ${k.padEnd(30)} ${v}`);
}
process.exit(0);
