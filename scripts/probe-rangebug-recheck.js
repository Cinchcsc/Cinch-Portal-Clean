// CORRECTION to probe-rangebug-historical.js (8 Jul 2026): that script's "MISMATCH" verdict was
// caused by a flaw in the PROBE, not in ManagementSummary or production pull.js. iDCount/iMCount/
// iYCount (see reportMap.js's `management` parser) are SiteLink's own Day/Month/Year-TO-DATE
// counters — iMCount for a call ending on date X is cumulative from the 1st of that calendar month
// through X, not a flexible sum over an arbitrary [start,end]. The old probe called ManagementSummary
// once per day and summed each day's `.mo` (iMCount) — but day 15's iMCount already includes days
// 1-14, so summing 30 of them adds a spurious triangular series (1x+2x+...+30x ≈ 15.5x the true
// month total for uniform activity), which is almost exactly the 12-25x "mismatch" seen. This script
// sums `.d` (iDCount, the single-day count) per day instead, which should land close to the one-call
// `.mo` value — confirming the one-call reading (what pull.js has always used) was correct.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-rangebug-recheck.js
import { callReport } from '../lib/sitelink.js';

const num = (row, ...keys) => {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== '') {
      const n = Number(String(row[k]).replace(/[£,%\s]/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
};
const str = (v) => (v == null ? '' : String(v)).trim();
const find = (rows, re) => { for (const r of rows) if (re.test(str(r.sDesc))) return r; return null; };

const locations = ['L001', 'L002'];
const start = new Date(2026, 5, 1);   // June 1
const end = new Date(2026, 5, 30);    // June 30 — same closed month as the original probe

const FIELDS = [
  ['move_ins', /move.?in/i], ['move_outs', /move.?out/i], ['walkin_leads', /walk.?in lead/i],
  ['phone_leads', /phone lead/i], ['web_leads', /web lead/i],
];

for (const loc of locations) {
  const { rows: fullRows } = await callReport('ManagementSummary', loc, start, end);
  const oneCall = {};
  for (const [key, re] of FIELDS) { const r = find(fullRows, re); oneCall[key] = r ? num(r, 'iMCount') : 0; }

  const dSum = Object.fromEntries(FIELDS.map(([k]) => [k, 0]));
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = new Date(d), de = new Date(d);
    process.stderr.write(`[recheck] ${loc} ${ds.toISOString().slice(0, 10)}...\n`);
    const { rows } = await callReport('ManagementSummary', loc, ds, de);
    for (const [key, re] of FIELDS) { const r = find(rows, re); dSum[key] += r ? num(r, 'iDCount') : 0; }
  }

  console.log(`\n${loc} — June 2026: one-call iMCount vs SUM of daily iDCount (corrected method):`);
  for (const [key] of FIELDS) {
    const a = oneCall[key], b = dSum[key];
    const diff = (a === 0 && b === 0) ? '0.0' : (((a - b) / (b || 1)) * 100).toFixed(1);
    console.log(`  ${key}: one-call(iMCount)=${a}   sum-of-daily(iDCount)=${b}   diff=${diff}%`);
  }
}
console.log('\nIf these two columns are now close (a few % apart, not 10-20x off): confirms the "range bug"');
console.log('was a flaw in the OLD probe (summing cumulative iMCount instead of daily iDCount), not a real');
console.log('defect in ManagementSummary or production pull.js. Task #95 stands down, no re-pull needed.');
process.exit(0);
