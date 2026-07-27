// PROBE (27 Jul 2026), READ-ONLY — generalizes today's Rate=£0.00 incident into a sweep. That bug
// (KPIs/MoM Rate + Self Storage Rate showing £0.00 for the CURRENT month only) turned out to be
// stale-parse-shape data: rent_roll's stored `data` for July was captured with an older parser
// version and was missing std_rent_sum/area_sum/rent_sum/unit_rows entirely, even though the
// CURRENTLY deployed reportMap.js parser has always produced them. Fixed for rent_roll via
// `npm run reparse rent_roll 2026-07`. That fix was report-specific and month-specific — it says
// nothing about whether OTHER reports also got a stale/incomplete shape captured for the CURRENT
// month during the same window (e.g. if a cron pull landed while a broken deploy was being served,
// or some other timing drift). This sweeps every report this codebase knows about, for the CURRENT
// month only, across every site, and flags any place where re-parsing the SAME already-stored
// raw_response with TODAY's parser code produces a DIFFERENT shape than what's currently saved.
//
// Deliberately scoped to the CURRENT month only, not full history — historical drift after a parser
// fix is an already-understood, already-documented condition in this codebase (reparse-report.js's
// own header comment describes it), and the standing practice is to reparse the specific
// report/month whenever a parser bug gets fixed. What would be NEW and worth acting on immediately
// is the current, live month being wrong right now, the same way rent_roll was — that's what this
// looks for.
//
// SAFE: this never writes anything. It only reads raw_report.raw_response and raw_report.data,
// re-parses the raw_response in memory, and diffs the result against the stored data. Zero SiteLink
// calls, zero DB writes.
//
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-stale-parse-shape-sweep.js
import { admin } from '../lib/supabaseAdmin.js';
import { REPORTS } from '../lib/reportMap.js';
import { extractRows } from '../lib/sitelink.js';

const now = new Date();
const curMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
const [y, m] = curMonthKey.split('-').map(Number);
const startDate = new Date(y, m - 1, 1);
const endDate = now; // current (open) month — same "isCurrentMonth" convention reparse-report.js uses

console.log(`Stale-parse-shape sweep — current month ${curMonthKey.slice(0, 7)} only, all reports, all sites.`);
console.log(`Re-parsing each stored raw_response with TODAY's reportMap.js and diffing vs the saved data.\n`);

// Bounded, human-readable diff: recurse into plain objects up to a small depth; for arrays, only
// report a length change (not per-element diffs — rent_roll's unit_rows can be hundreds of rows and
// we already know that story; a length/presence change is enough signal to flag it here).
function diff(freshVal, storedVal, path, out, depth) {
  if (depth > 3) return;
  const freshIsArr = Array.isArray(freshVal), storedIsArr = Array.isArray(storedVal);
  if (freshIsArr || storedIsArr) {
    const fLen = freshIsArr ? freshVal.length : null, sLen = storedIsArr ? storedVal.length : null;
    if (fLen !== sLen) out.push(`${path}: array length fresh=${fLen ?? '(missing/not array)'} stored=${sLen ?? '(missing/not array)'}`);
    return;
  }
  const freshIsObj = freshVal && typeof freshVal === 'object';
  const storedIsObj = storedVal && typeof storedVal === 'object';
  if (freshIsObj || storedIsObj) {
    if (!freshIsObj || !storedIsObj) { out.push(`${path}: fresh=${JSON.stringify(freshVal)} stored=${JSON.stringify(storedVal)}`); return; }
    const keys = new Set([...Object.keys(freshVal || {}), ...Object.keys(storedVal || {})]);
    for (const k of keys) diff(freshVal[k], storedVal[k], path ? `${path}.${k}` : k, out, depth + 1);
    return;
  }
  if (freshVal !== storedVal) out.push(`${path}: fresh=${JSON.stringify(freshVal)} stored=${JSON.stringify(storedVal)}`);
}

const reportKeys = Object.keys(REPORTS);
let totalRows = 0, totalDiffs = 0;
const summaryByReport = {};

for (const reportKey of reportKeys) {
  const spec = REPORTS[reportKey];
  const { data: rows, error } = await admin
    .from('raw_report').select('id,site_code,data,raw_response')
    .eq('report', reportKey).eq('month', curMonthKey)
    .not('raw_response', 'is', null);
  if (error) { console.error(`${reportKey}: fetch error — ${error.message}`); continue; }
  if (!rows || !rows.length) { console.log(`${reportKey}: no stored raw_response rows for the current month — skipped.`); continue; }

  let reportDiffCount = 0;
  const examples = [];
  for (const row of rows) {
    totalRows++;
    let fresh;
    try {
      const extracted = extractRows(row.raw_response);
      fresh = spec.parse(extracted, startDate, endDate, row.raw_response);
    } catch (e) {
      examples.push(`  ${row.site_code}: RE-PARSE THREW — ${e.message}`);
      reportDiffCount++;
      continue;
    }
    const out = [];
    diff(fresh, row.data || {}, '', out, 0);
    if (out.length) {
      reportDiffCount++;
      totalDiffs++;
      if (examples.length < 3) examples.push(`  ${row.site_code} (raw_report id=${row.id}):\n    ${out.slice(0, 8).join('\n    ')}`);
    }
  }

  summaryByReport[reportKey] = { checked: rows.length, diffCount: reportDiffCount };
  console.log(`${reportKey}: ${rows.length} site(s) checked, ${reportDiffCount} with a diff between fresh reparse and stored data.`);
  for (const ex of examples) console.log(ex);
  if (examples.length) console.log('');
}

console.log(`${'='.repeat(70)}\nSUMMARY\n${'='.repeat(70)}`);
console.log(`${totalRows} (report, site) rows checked across ${reportKeys.length} report types for ${curMonthKey.slice(0, 7)}.`);
console.log(`${totalDiffs} row(s) where today's parser produces something different from what's stored.`);
if (totalDiffs) {
  console.log(`\nAffected reports: ${Object.entries(summaryByReport).filter(([, v]) => v.diffCount).map(([k, v]) => `${k} (${v.diffCount})`).join(', ')}`);
  console.log(`\nFix for any affected report: node --env-file=.env scripts/reparse-report.js <report> ${curMonthKey.slice(0, 7)}`);
} else {
  console.log(`\nNothing else looks stale for the current month — today's rent_roll fix appears to have been an isolated incident, not a wider pattern.`);
}
process.exit(0);
