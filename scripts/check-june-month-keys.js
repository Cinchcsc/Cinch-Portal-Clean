// Follow-up to the still-unresolved June gap (7 Jul 2026): /api/portfolio?from=2026-06&to=2026-06
// STILL returns 0 sites and June is STILL missing from the `months` array even after the concurrent
// management repull finished — ruling out "just a timing/concurrency artifact" as the full story.
// Direct query already confirmed raw_report has 27/27 valid occupancy rows for month='2026-06-01'
// with real total_units. New theory: buildIndex()'s own comment says it explicitly expects to see
// TWO DIFFERENT `month` DATE VALUES that both collapse to the same "YYYY-06" key ("legacy end-of-month
// keys vs canonical -01 keys", e.g. '2026-06-30' alongside '2026-06-01') — the unique constraint is on
// the exact `month` value, not the sliced key, so both can coexist as separate rows. If a '2026-06-30'-
// (or similar) keyed row exists with a LATER pulled_at than the good '2026-06-01' row, buildIndex()'s
// de-dupe would let it win and overwrite the good in-memory data with whatever that row contains — if
// its `data` is empty/bad, that would exactly explain occupancy.total_units failing the gate for every
// site despite the '01'-keyed row being fine. This checks for exactly that: any occupancy row for June
// 2026 whose `month` value is NOT the canonical '2026-06-01'.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-june-month-keys.js
import { admin } from '../lib/supabaseAdmin.js';

const { data, error } = await admin.from('raw_report').select('site_code,month,report,data,pulled_at').eq('report', 'occupancy').gte('month', '2026-06-01').lt('month', '2026-07-01').order('site_code').order('month');
if (error) { console.error(error.message); process.exit(1); }

console.log(`${data.length} occupancy row(s) found with month in June 2026 (any day, not just the 1st):\n`);
const bySite = {};
for (const r of data) { (bySite[r.site_code] ??= []).push(r); }
let sitesWithMultiple = 0;
for (const [site, rows] of Object.entries(bySite)) {
  if (rows.length > 1) {
    sitesWithMultiple++;
    console.log(`${site}: ${rows.length} rows for June —`);
    for (const r of rows) {
      const tu = r.data && r.data.total_units;
      console.log(`    month=${r.month}  total_units=${tu}  pulled_at=${r.pulled_at}  dataKeys=${r.data ? Object.keys(r.data).length : 0}`);
    }
  }
}
console.log(`\n${sitesWithMultiple} of ${Object.keys(bySite).length} sites have MORE THAN ONE occupancy row for June 2026 (multiple \`month\` date values collapsing to the same June key).`);
if (sitesWithMultiple === 0) {
  console.log(`\nNo duplicate month-keys found — this theory is ruled out.`);
}

// Second check: simulate fetchAllRaw()'s exact pagination (order by id, 1000/page) against the WHOLE
// table (not just June/occupancy) and confirm June's 27 occupancy rows actually come back through it.
// Rules in/out a pagination bug on a table that's grown large after the recent repulls.
const ALL_REPORTS = ['occupancy', 'rent_roll', 'management', 'move_ins_outs', 'past_due', 'scheduled_outs',
  'insurance_roll', 'insurance_activity', 'lead_funnel', 'marketing', 'merchandise', 'financial', 'rate_changes',
  'reservations', 'true_revenue', 'rental_activity'];
const { count: totalCount } = await admin.from('raw_report').select('id', { count: 'exact', head: true }).in('report', ALL_REPORTS);
console.log(`\nTotal raw_report rows across ALL_REPORTS: ${totalCount}`);

const PAGE = 1000;
let all = [];
for (let from = 0; ; from += PAGE) {
  const { data: page, error: pErr } = await admin.from('raw_report').select('site_code,month,report').in('report', ALL_REPORTS).order('id').range(from, from + PAGE - 1);
  if (pErr) { console.error('pagination error:', pErr.message); break; }
  all = all.concat(page);
  if (!page || page.length < PAGE) break;
}
const juneOccInPagedResult = all.filter((r) => r.report === 'occupancy' && String(r.month).slice(0, 7) === '2026-06').length;
console.log(`fetchAllRaw()-style full pagination retrieved ${all.length} rows total.`);
console.log(`June 2026 occupancy rows found via that same pagination: ${juneOccInPagedResult} (should be 27).`);
if (juneOccInPagedResult < 27) {
  console.log(`\nCONFIRMED: the pagination itself is dropping June's occupancy rows even with no concurrent`);
  console.log(`writes running — this is a real pagination bug, not a timing artifact. Total row count above`);
  console.log(`tells us how large the table has gotten, which is the likely trigger.`);
} else if (sitesWithMultiple === 0) {
  console.log(`\nBoth theories ruled out — pagination retrieves June fine in isolation here, and there are no`);
  console.log(`duplicate month-keys. Something else in buildIndex()'s in-memory reduction must differ from`);
  console.log(`this script's — worth comparing timing (is this being run at a different moment than the API`);
  console.log(`call?) or double-checking the live dev server process picked up recent code with no stale state.`);
}
process.exit(0);
