// Michael (9 Jul 2026): Tax Adj is still showing £0 on the live Financials page, despite (1) the taxAdj
// derivation fix (taxInvoiced - netTax) landing in reportMap.js, and (2) an earlier reparse-report.js
// true_revenue run that reported "58/58 reparsed" success. Before guessing at another fix, check what's
// ACTUALLY stored in raw_report.data right now -- no SiteLink call, no fresh parse, just the exact
// bytes the live page reads -- to find out whether that reparse really landed the fix, or whether this
// is a different, new bug further down the pipeline (buildPayload.js or the frontend).
// Run: cd cinch-portal-clean && node --env-file=.env scripts/check-stored-truerevenue.js [siteCode] [YYYY-MM]
import { admin } from '../lib/supabaseAdmin.js';

const siteCode = process.argv[2] || 'L001';
const monthArg = process.argv[3]; // YYYY-MM, defaults to current month
const now = new Date();
const mk = monthArg || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const monthKey = `${mk}-01`;

const { data: row, error } = await admin.from('raw_report').select('data, pulled_at, raw_response')
  .eq('report', 'true_revenue').eq('site_code', siteCode).eq('month', monthKey).maybeSingle();
if (error) { console.error(error.message); process.exit(1); }
if (!row) { console.log(`No stored true_revenue row for ${siteCode}/${mk}.`); process.exit(0); }

console.log(`=== STORED raw_report.data for true_revenue, ${siteCode}, ${mk} (pulled_at: ${row.pulled_at}) ===\n`);
console.log(`Has raw_response stored (reparse-able without a live SiteLink call): ${row.raw_response ? 'yes' : 'no'}`);

const byDesc = row.data?.by_desc || [];
console.log(`\n${'ChargeDesc'.padEnd(28)} taxInvoiced    netTax      taxAdj (STORED, what the page reads)`);
let taxAdjSum = 0;
for (const r of byDesc) {
  taxAdjSum += r.taxAdj || 0;
  console.log(`${(r.desc || '').padEnd(28)} £${(r.taxInvoiced ?? 0).toFixed(2).padStart(10)}   £${(r.netTax ?? 0).toFixed(2).padStart(10)}   £${(r.taxAdj ?? 0).toFixed(2).padStart(10)}`);
}
console.log(`\nStored taxAdj sum across all ${byDesc.length} rows: £${taxAdjSum.toFixed(2)}`);
if (taxAdjSum === 0) {
  console.log(`\n*** Still £0 in STORAGE -- the reparse never actually landed the fix here. Needs a fresh`);
  console.log(`reparse (now using the fixed reparse-report.js, which hasn't been re-run since the`);
  console.log(`statement-timeout crash was fixed): node --env-file=.env scripts/reparse-report.js true_revenue ***`);
} else {
  console.log(`\n*** Storage looks correct. If the live page still shows £0, the bug is downstream`);
  console.log(`(buildPayload.js's True Revenue wiring, or the frontend table) -- not the stored data. ***`);
}
process.exit(0);
