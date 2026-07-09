// IncomeAnalysis via callReport()/extractRows() returned only 5 columns (diffgr:id, msdata:rowOrder,
// SiteID, iOrder, sDesc) and every row was a category LABEL ("Gross Potential", "Drive Up",
// "Enterprise", "Indoor Self Storage", "Mailbox", ...) with no dollar figure anywhere. The
// diffgr:id values ("Cash1", "Cash2", ...) reveal this table's real internal name is "Cash" — and
// extractRows() only ever returns the SINGLE LARGEST table in the diffgram (`if (v.length >
// found.length) found = v`), exactly the same bug already confirmed for ManagementSummary (which
// silently dropped its 8-row Delinquency Aging table in favor of the 13-row UnitActivity table).
// So "Cash" (65 rows) most likely just won a size contest against a smaller table that actually
// holds the £ values per category — this dumps EVERY table in the raw diffgram so we can see it.
// Run: cd cinch-portal-clean && node --env-file=.env scripts/dump-incomeanalysis-tables.js [siteCode] [YYYY-MM]
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
console.log(`=== IncomeAnalysis raw table dump, ${siteCode}, ${fmt(start)} to ${fmt(end)} ===\n`);

const { raw: result } = await callReport('IncomeAnalysis', siteCode, start, end);

let diff = null;
(function find(node) {
  if (!node || typeof node !== 'object' || diff) return;
  for (const [k, v] of Object.entries(node)) {
    if (diff) return;
    if (/diffgram/i.test(k) && v && typeof v === 'object') { diff = v; return; }
    if (v && typeof v === 'object') find(v);
  }
})(result);

const tables = [];
(function walk(node, path) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      const keys = Object.keys(v[0].attributes || v[0]);
      // PII-safety: redact any value under a column name that looks like it could carry PII;
      // numeric/category columns print as-is.
      const piiLike = keys.filter((c) => /name|email|phone|address|tenant|customer/i.test(c));
      const sample = {};
      for (const c of keys) {
        const val = (v[0].attributes || v[0])[c];
        sample[c] = piiLike.includes(c) ? '[redacted]' : val;
      }
      tables.push({ path: `${path}.${k}`, name: k, count: v.length, keys, sample });
    } else if (v && typeof v === 'object') walk(v, `${path}.${k}`);
  }
})(diff || result, 'root');

console.log(`Found ${tables.length} row-array table(s) in the raw IncomeAnalysis response:\n`);
for (const t of tables) {
  console.log(`"${t.name}" (${t.count} rows) — columns: ${t.keys.join(', ')}`);
  console.log(`  sample row: ${JSON.stringify(t.sample)}\n`);
}
process.exit(0);
