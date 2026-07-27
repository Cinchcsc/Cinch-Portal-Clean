// PROBE (27 Jul 2026), READ-ONLY — follow-up to probe-insurance-roll-julycount-check.js. That script
// (filtering on the EXACT canonical month key '2026-07-01') found L001's stored+fresh-reparsed
// insured_new_customers.count both correctly read 25 -- yet the LIVE portal (built from
// buildIndex()/recordFor() in buildPayload.js) shows 0 for the same site/month. buildIndex()'s own
// comment explains its de-dupe logic exists specifically because "two raw rows [can] collapse to the
// same YYYY-MM (e.g. legacy end-of-month keys vs canonical -01 keys)" and picks whichever has the
// LATEST pulled_at. reparse-report.js and the other probes all filter with an EXACT `.eq('month',
// '2026-07-01')` -- if a SECOND row exists for the same site/report with a DIFFERENT exact month
// value (e.g. '2026-07-31') that also normalizes to "2026-07", it would have been silently skipped by
// every exact-match query so far, never reparsed, and could still be the row buildIndex() actually
// picks if its pulled_at happens to be later.
//
// This does a PREFIX match (month LIKE '2026-07%') instead of an exact match, for one report/site, to
// surface every row that would collapse into the same "2026-07" bucket -- zero writes.
//
// Run:  node --env-file=.env scripts/probe-insurance-roll-duplicate-month-rows.js [siteCode] [report]
import { admin } from '../lib/supabaseAdmin.js';

const site = process.argv[2] || 'L001';
const report = process.argv[3] || 'insurance_roll';

const { data: rows, error } = await admin
  .from('raw_report').select('id,month,pulled_at,data')
  .eq('site_code', site).eq('report', report)
  .gte('month', '2026-07-01').lt('month', '2026-08-01')
  .order('pulled_at', { ascending: true });
if (error) { console.error('Fetch error:', error.message); process.exit(1); }

console.log(`${site} / report=${report} — rows with month in [2026-07-01, 2026-08-01):\n`);
if (!rows || !rows.length) { console.log('No rows found in this range at all.'); process.exit(0); }

for (const r of rows) {
  console.log(`id=${r.id}  month=${r.month}  pulled_at=${r.pulled_at}`);
  console.log(`  insured_new_customers: ${JSON.stringify(r.data && r.data.insured_new_customers)}`);
  console.log(`  monthly-ish fields: insured_units=${r.data && r.data.insured_units}  monthly_premium=${r.data && r.data.monthly_premium}\n`);
}

if (rows.length > 1) {
  const latest = [...rows].sort((a, b) => (a.pulled_at || '') < (b.pulled_at || '') ? 1 : -1)[0];
  console.log(`>>> ${rows.length} rows collapse to "2026-07" for this site/report -- buildIndex() would pick`);
  console.log(`>>> id=${latest.id} (pulled_at=${latest.pulled_at}, the latest) as "the" July record, REGARDLESS of`);
  console.log(`>>> which one any exact-month-string script (reparse-report.js, other probes) happened to touch.`);
} else {
  console.log('>>> Only 1 row -- not a duplicate-month-key issue for this site/report. Root cause is elsewhere.');
}
process.exit(0);
