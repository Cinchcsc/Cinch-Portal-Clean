// PROBE (20 Jul 2026), READ-ONLY, cheap (counts + small samples only, no full-table data pull) —
// quantifying how large raw_report has grown, to test the hypothesis behind the 20 Jul portal_payload
// rebuild timeouts (see lib/rebuildPayload.js's withRetry() comment): buildPayload()'s buildIndex()/
// fetchAllRaw() intentionally scans raw_report's ENTIRE unfiltered history on every single rebuild
// (current+history views both need every month ever pulled), a scan that can only ever grow as daily
// crons + backfills add more rows, with no ceiling. This counts total rows, rows + stored month range
// per report, and samples average parsed `data` size per report (bytes matter as much as row count —
// a report with fewer but much WIDER rows can cost more transfer time than raw row count alone
// suggests). Gives a concrete baseline to compare against if/when the timeout recurs.
//
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-rawreport-growth.js
import { admin } from '../lib/supabaseAdmin.js';
import { REPORTS } from '../lib/reportMap.js';

const { count: totalCount, error: countErr } = await admin.from('raw_report').select('id', { count: 'exact', head: true });
if (countErr) { console.error('Total count failed:', countErr.message); process.exit(1); }
console.log(`raw_report total rows: ${totalCount}\n`);

console.log('Per-report breakdown (row count, oldest stored month -> newest stored month):');
for (const reportKey of Object.keys(REPORTS)) {
  const { count, error } = await admin.from('raw_report').select('id', { count: 'exact', head: true }).eq('report', reportKey);
  if (error) { console.log(`  ${reportKey.padEnd(20)} count FAILED — ${error.message}`); continue; }
  const { data: oldest } = await admin.from('raw_report').select('month').eq('report', reportKey).order('month', { ascending: true }).limit(1);
  const { data: newest } = await admin.from('raw_report').select('month').eq('report', reportKey).order('month', { ascending: false }).limit(1);
  const oldestMonth = oldest && oldest[0] ? String(oldest[0].month).slice(0, 7) : 'n/a';
  const newestMonth = newest && newest[0] ? String(newest[0].month).slice(0, 7) : 'n/a';
  console.log(`  ${reportKey.padEnd(20)} ${String(count ?? 0).padStart(6)} rows   ${oldestMonth} -> ${newestMonth}`);
}

console.log('\nSampled avg parsed `data` size per report (JSON-stringified bytes, 20-row sample):');
let estTotalBytes = 0;
for (const reportKey of Object.keys(REPORTS)) {
  const { data: sample, error } = await admin.from('raw_report').select('data').eq('report', reportKey).limit(20);
  if (error || !sample || !sample.length) continue;
  const avgBytes = Math.round(sample.reduce((sum, r) => sum + JSON.stringify(r.data || {}).length, 0) / sample.length);
  const { count } = await admin.from('raw_report').select('id', { count: 'exact', head: true }).eq('report', reportKey);
  const estReportBytes = avgBytes * (count || 0);
  estTotalBytes += estReportBytes;
  console.log(`  ${reportKey.padEnd(20)} ~${avgBytes.toLocaleString().padStart(8)} bytes/row  x ${String(count ?? 0).padStart(6)} rows  ~= ${(estReportBytes / 1e6).toFixed(1)} MB`);
}
console.log(`\nEstimated total 'data' payload fetchAllRaw() reads on every unfiltered buildPayload() call: ~${(estTotalBytes / 1e6).toFixed(1)} MB`);
console.log('(This is the "data" JSONB column only, at ~1000 rows/page keyset pagination — actual wire/DB-side cost also depends on Supabase compute tier + concurrent load at call time.)');
process.exit(0);
