// Follow-up to check-month-site-coverage.js's result (7 Jul 2026): that script confirmed occupancy has
// a stored raw_report ROW for all 27/27 sites in June 2026 — contradicting the earlier "genuine raw-
// data gap" theory for why /api/portfolio?from=2026-06&to=2026-06 returns only 14/27 sites (L014-L027).
// Since the row EXISTS for every site, the site-drop must be happening at the `total_units > 0` half of
// buildPayload.js's gate (`idx[code][mk].occupancy && idx[code][mk].occupancy.total_units > 0`), not the
// "row missing" half. This is a quick, READ-ONLY check of just that one field — NOT a re-pull, and much
// faster than a full historical repull — meant to confirm the exact root cause before committing to any
// long-running fix. If total_units really is 0/falsy for L001-L013 specifically, that points at either a
// genuine SiteLink data anomaly for that pull, or a parsing bug in reportMap.js's occupancy parser for
// whatever raw shape those 13 sites happened to return that day — worth knowing which before re-pulling.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-occupancy-totalunits.js [YYYY-MM]
import { admin } from '../lib/supabaseAdmin.js';

const monthArg = process.argv[2] || '2026-06';
const monthKey = `${monthArg}-01`;

const { data, error } = await admin.from('raw_report').select('site_code,data,pulled_at').eq('report', 'occupancy').eq('month', monthKey).order('site_code');
if (error) { console.error(error.message); process.exit(1); }

console.log(`${data.length} occupancy rows found for ${monthKey}.\n`);
console.log('site_code  total_units  (other occupancy fields present?)  pulled_at');
let zeroOrMissing = 0;
for (const r of data) {
  const tu = r.data && r.data.total_units;
  const looksEmpty = !r.data || Object.keys(r.data).length === 0;
  const flag = (!tu || tu <= 0) ? '  <-- FAILS total_units > 0 gate' : '';
  if (flag) zeroOrMissing++;
  console.log(`${r.site_code}       ${String(tu).padEnd(10)}  keys=${r.data ? Object.keys(r.data).length : 0}${looksEmpty ? ' (EMPTY data!)' : ''}  ${r.pulled_at}${flag}`);
}
console.log(`\n${zeroOrMissing} of ${data.length} sites fail the total_units > 0 gate for ${monthKey}.`);
if (zeroOrMissing > 0) {
  console.log(`\nThis confirms the site-drop is a DATA/VALUE issue (total_units is 0 or missing on an`);
  console.log(`existing row), not a missing-row issue. Before re-pulling, worth checking whether this is`);
  console.log(`consistent across nearby months too (e.g. try 2026-05, 2026-07) to see if it's June-specific`);
  console.log(`or a wider pattern for these exact sites.`);
}
process.exit(0);
