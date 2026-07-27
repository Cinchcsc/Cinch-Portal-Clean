// PROBE (27 Jul 2026), READ-ONLY — follow-up to probe-stale-parse-shape-sweep.js. That sweep found
// insurance_activity's CURRENT month (Jul 2026) reads new_policies=0 for nearly every site when
// reparsed with today's code, even though cancellations comes back with plausible non-zero counts
// (e.g. L019: 0 new / 110 cancelled). Stored data for the same sites shows new_policies EQUAL TO
// cancellations (e.g. L019: 508/508) -- which is the EXACT signature of the pre-17-Jul-2026 bug this
// report already had (str()-based truthy check on a Y/N string counted every row as both new AND
// cancelled; see the FIXED 17 Jul 2026 comment in reportMap.js). That match is reassuring -- it
// suggests stored July data is simply stale (predates the fix), not that today's code is newly
// broken -- but new_policies reading a flat 0 across every checked site is still worth eyeballing
// directly before trusting a reparse, in case sNewPolicy itself has drifted (renamed column, always
// blank this month, etc.) rather than genuinely being "no new policies yet".
//
// This dumps the RAW sNewPolicy / sCancelledPolicy / bCancelled values (with counts of each distinct
// value seen) for Insur_InsuranceActivity, straight from the already-stored raw_response for one site
// -- zero new SiteLink calls, zero writes.
//
// Run:  node --env-file=.env scripts/probe-insurance-activity-newpolicy-values.js [siteCode] [YYYY-MM]
import { admin } from '../lib/supabaseAdmin.js';
import { extractNamedTable } from '../lib/sitelink.js';

const site = process.argv[2] || 'L019';
const monthArg = process.argv[3];
const now = new Date();
const monthKey = monthArg ? `${monthArg}-01` : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

const { data: row, error } = await admin
  .from('raw_report').select('id,pulled_at,raw_response,data')
  .eq('site_code', site).eq('month', monthKey).eq('report', 'insurance_activity')
  .order('id', { ascending: false }).limit(1).maybeSingle();
if (error) { console.error('Fetch error:', error.message); process.exit(1); }
if (!row) { console.log(`No insurance_activity row for ${site}/${monthKey}.`); process.exit(0); }

console.log(`${site} / ${monthKey.slice(0, 7)} — raw_report id=${row.id}, pulled_at=${row.pulled_at}`);
console.log(`Currently stored data: ${JSON.stringify(row.data)}\n`);

const rows = extractNamedTable(row.raw_response, 'Insur_InsuranceActivity');
console.log(`Insur_InsuranceActivity rows in this raw_response: ${rows.length}\n`);

const tally = (key) => {
  const counts = {};
  for (const r of rows) { const v = JSON.stringify(r[key]); counts[v] = (counts[v] || 0) + 1; }
  return counts;
};
console.log('Distinct sNewPolicy values seen:', tally('sNewPolicy'));
console.log('Distinct sCancelledPolicy values seen:', tally('sCancelledPolicy'));
console.log('Distinct bCancelled values seen:', tally('bCancelled'));

console.log('\nFirst 5 rows (sNewPolicy / sCancelledPolicy / bCancelled / dcPremium / dActivity or similar date field):');
for (const r of rows.slice(0, 5)) {
  console.log(' ', JSON.stringify({
    sNewPolicy: r.sNewPolicy, sCancelledPolicy: r.sCancelledPolicy, bCancelled: r.bCancelled,
    dcPremium: r.dcPremium, dActivity: r.dActivity, dMovedIn: r.dMovedIn, dPaidThru: r.dPaidThru,
  }));
}
console.log('\nIf sNewPolicy is consistently "N"/blank/false across ALL rows above (not just missing from');
console.log('the sample), new_policies=0 is a real reading, not a parsing bug -- the reparse is safe to trust.');
console.log('If sNewPolicy has a truthy value on some rows that still failed to increment newPol, or the');
console.log('field name looks different/renamed, that points to a real bug in today\'s parser needing a fix');
console.log('before reparsing (reparsing now would just bake in the same miscount, silently, as 0 instead of');
console.log('an inflated equal-to-cancelled number).');
process.exit(0);
