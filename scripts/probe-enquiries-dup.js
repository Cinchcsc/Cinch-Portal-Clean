// Enquiries portfolio-wide is ~1.55x the legacy target (6,491 vs 4,178) uniformly across every
// channel (phone/walk-in/web/email all inflated by a similar ratio) — that pattern smells like row
// duplication in what InquiryTracking returns, not a channel-classification bug. This checks Bicester
// (L001) specifically, where we already have an exact legacy target for June 2026 (Phone 3, Walk-in
// 7, Web 112, Total 122), and looks for duplicate rows by every ID-like column so we can see exactly
// what's being double-counted, if anything.
// PII-SAFE: prints only ID/type/date columns and duplicate counts — no names/contact info.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiries-dup.js
import { callReport } from '../lib/sitelink.js';

const loc = 'L001';
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const end = new Date(now.getFullYear(), now.getMonth(), 0);
console.log(`site ${loc} · window ${start.toDateString()} -> ${end.toDateString()}\n`);

const { rows } = await callReport('InquiryTracking', loc, start, end);
console.log('total rows:', rows.length);
console.log('target for this site (Jun 2026): Phone 3, Walk-in 7, Web 112 (Web+Email), Total 122\n');

const cols = Object.keys(rows[0] || {}).filter(k => !/^(diffgr|msdata)/i.test(k));
console.log('ALL COLUMNS:', cols.join(', '), '\n');

// Look for anything that looks like a unique row/inquiry ID.
const idCols = cols.filter(c => /id$/i.test(c) || /^s?inquiry/i.test(c) || /^tenantid$/i.test(c));
console.log('candidate ID-like columns:', idCols.join(', '), '\n');

for (const idc of idCols) {
  const seen = new Map();
  for (const r of rows) { const v = String(r[idc] ?? ''); seen.set(v, (seen.get(v) || 0) + 1); }
  const dupes = [...seen.values()].filter(n => n > 1).length;
  const maxDup = Math.max(0, ...seen.values());
  console.log(`${idc}: ${seen.size} distinct values, ${dupes} values appear more than once (max repeat count: ${maxDup})`);
}

// Show 5 sample rows (ID + type + date columns only, no PII) to eyeball for obvious repeats.
console.log('\nFirst 10 rows (id/type/date columns only):');
const sampleCols = [...new Set([...idCols, 'sInquiryType', 'dInquiryDate', 'dCreated'])].filter(c => cols.includes(c));
for (const r of rows.slice(0, 10)) console.log(sampleCols.map(c => `${c}=${r[c]}`).join('  '));
process.exit(0);
