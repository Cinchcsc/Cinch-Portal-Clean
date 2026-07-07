// Finds the real column(s) SiteLink's InquiryTracking ("Lead Funnel") report uses for the
// enquiry source/origination, so we can implement the authoritative Enquiries formula
// (Michael, 1 Jul 2026): Phone / Walk-in / Web / Email counts from "Last Page -> Origination".
// PII-SAFE: prints column names + value histograms only, never row-level tenant data.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiries.js
import { callReport } from '../lib/sitelink.js';

const loc = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);

console.log(`InquiryTracking (Lead Funnel) · site ${loc} · ${start.toISOString().slice(0, 10)} -> ${end.toISOString().slice(0, 10)}\n`);
const { rows } = await callReport('InquiryTracking', loc, start, end);
console.log('row count:', rows.length);
if (!rows.length) { console.log('no rows for this period — try a busier month.'); process.exit(0); }

const cols = Object.keys(rows[0]).filter((k) => !/^(diffgr|msdata)/i.test(k));
console.log('\nALL COLUMNS:\n' + cols.join(', '));

// Any column whose NAME hints at page/origination/source, and any column whose VALUES look like
// a small categorical set (<=10 distinct values) that could plausibly be Phone/Walk-in/Web/Email —
// print a value histogram for each so we can spot the real one.
console.log('\nCANDIDATE COLUMNS (name hints at page/origin/source/channel/type):');
const nameHints = cols.filter((c) => /page|origin|source|channel|type|method|via/i.test(c));
console.log(nameHints.join(', ') || '(none by name — check the categorical dump below)');

console.log('\nVALUE HISTOGRAMS for every column with <=12 distinct values (categorical candidates):');
for (const c of cols) {
  const vals = {};
  for (const r of rows) { const v = String(r[c] ?? '(blank)'); vals[v] = (vals[v] || 0) + 1; }
  const distinct = Object.keys(vals);
  if (distinct.length >= 2 && distinct.length <= 12) {
    console.log(`\n${c}:`);
    for (const [v, n] of Object.entries(vals).sort((a, b) => b[1] - a[1])) console.log(`  ${v.padEnd(20)} ${n}`);
  }
}
process.exit(0);
