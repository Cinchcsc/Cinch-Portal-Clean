// PROBE (17 Jul 2026, full-portal review follow-up) — read-only, zero SiteLink calls, mirrors
// reparse-report.js's raw_response-reuse pattern but makes NO writes.
//
// WHY: today's live-portal check found InsuranceActivity's `cancellations` figure at Bicester (L001)
// implausibly high for a single month — 340 (May), 349 (Jun), 244 (Jul MTD) at a site with ~348 TOTAL
// units. That's the whole book "cancelling" roughly every month, which isn't a credible cancellation
// rate. `new_policies` from the exact same ungated loop looked fine (23/21/21) — but both counters
// share the same rows with zero per-row date filtering (reportMap.js's `insurance_activity` parser
// takes no startDate/endDate at all, unlike lead_funnel's isPlacedInWindow or insurance_roll's
// inWindow(dMovedIn)). Same failure shape already root-caused and fixed for lead_funnel's
// reservationStageCount on 17 Jul: SiteLink's raw response for a date-ranged call is NOT already
// trimmed to that window, so anything not explicitly filtered client-side leaks in out-of-window rows.
//
// This script tests that directly using ALREADY-STORED raw_response (no live calls, seconds not
// hours): for InsuranceActivity at a sample of sites, across every month we have raw_response stored
// for, print the raw row COUNT, every column name on one sample row (to find a usable per-row date
// field, if one exists), and whether the SAME row count recurs across different requested months
// (strong evidence the report ignores the date window, same tell as rate_changes/scheduled_outs
// before their fixes).
//
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-insurance-activity-window.js [SITE_CODE]
// Default site: L001 (Bicester). Pass a second arg of 'all' to scan every stored site instead.
import { admin } from '../lib/supabaseAdmin.js';
import { extractRows } from '../lib/sitelink.js';

const site = process.argv[2] || 'L001';
const scanAll = process.argv[3] === 'all';

async function fetchStoredMonths(siteCode) {
  let q = admin.from('raw_report').select('id,site_code,month').eq('report', 'insurance_activity').not('raw_response', 'is', null).order('month');
  if (!scanAll) q = q.eq('site_code', siteCode);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

const rows = await fetchStoredMonths(site);
console.log(`Found ${rows.length} stored insurance_activity raw_response row(s)${scanAll ? ' (all sites)' : ` for ${site}`}.`);
if (!rows.length) {
  console.log('\nNothing stored yet for this report/site — run npm run pull (or a targeted repull for insurance_activity) first.');
  process.exit(0);
}

let sampleCols = null;
const summary = [];
for (const r of rows) {
  const { data, error } = await admin.from('raw_report').select('raw_response').eq('id', r.id).single();
  if (error) { console.error(`  ${r.site_code}/${String(r.month).slice(0, 7)}: FAILED — ${error.message}`); continue; }
  const extracted = extractRows(data.raw_response);
  if (!sampleCols && extracted.length) sampleCols = Object.keys(extracted[0]);
  let newPol = 0, cancelled = 0;
  for (const row of extracted) {
    if (row.sNewPolicy) newPol++;
    if (row.sCancelledPolicy || row.bCancelled) cancelled++;
  }
  summary.push({ site: r.site_code, month: String(r.month).slice(0, 7), rowCount: extracted.length, newPol, cancelled });
}

console.log('\nColumn names on a sample row (hunt for a usable per-row date field, e.g. something like dNewPolicy/dCancelled/dPolicyDate/dEffective):');
console.log(sampleCols ? sampleCols.join(', ') : '(no rows found on any stored month)');

console.log('\nsite   month     rawRowCount  newPol  cancelled');
console.log('----------------------------------------------------');
for (const s of summary) {
  console.log(`${s.site.padEnd(6)} ${s.month.padEnd(9)} ${String(s.rowCount).padStart(11)}  ${String(s.newPol).padStart(6)}  ${String(s.cancelled).padStart(9)}`);
}
console.log('\nIf rowCount (or cancelled) is the same or nearly the same across different months for the same');
console.log('site, that confirms InsuranceActivity ignores the requested date window — same tell as the');
console.log('already-fixed rate_changes/scheduled_outs bugs. If a column above looks like a per-row date,');
console.log('that is the field to filter on (mirroring insurance_roll\'s inWindow(dMovedIn) pattern).');
process.exit(0);
