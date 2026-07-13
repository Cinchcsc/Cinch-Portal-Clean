// buildIndex() (lib/buildPayload.js line 545) only counts a month as "stored" if at least one
// site's occupancy.total_units > 0 that month -- this is the ACTUAL definition behind
// listStoredMonths()'s 71-month list (2020-09 onward), not a hardcoded date. But check-2017-
// gap-sites.js just showed occupancy ROWS exist for all 27 original sites back to 2016-06. If
// listStoredMonths() only starts at 2020-09, that means every site's total_units reads as 0 for
// the ENTIRE 2016-06..2020-08 stretch (~51 months) -- surprising for real operating self-storage
// sites. This pulls a few sample months' raw occupancy data for a couple of original sites across
// that window to see directly whether total_units is genuinely 0 (real: maybe a system migration,
// legacy account, or these sites weren't open yet) or looks like a parsing/extraction problem
// (e.g. other fields populated but total_units specifically missing/mis-mapped).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-pre-2020-occupancy.js
import { admin } from '../lib/supabaseAdmin.js';

const SITES = ['L001', 'L004', 'L010'];
const SAMPLE_MONTHS = ['2016-06-01', '2017-06-01', '2018-06-01', '2019-06-01', '2020-01-01', '2020-06-01', '2020-08-01', '2020-09-01', '2020-10-01'];

for (const site of SITES) {
  console.log(`\n=== ${site} ===`);
  const { data, error } = await admin
    .from('raw_report')
    .select('month,data,pulled_at')
    .eq('report', 'occupancy')
    .eq('site_code', site)
    .in('month', SAMPLE_MONTHS)
    .order('month');
  if (error) { console.log('error:', error.message); continue; }
  for (const r of data || []) {
    let d = r.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
    console.log(`${String(r.month).slice(0, 10)}  total_units=${d?.total_units}  occupied_units=${d?.occupied_units}  total_area=${d?.total_area}  occ_pc=${d?.occ_pc}  pulled_at=${r.pulled_at}`);
  }
  // Print the FULL raw record for the earliest and latest sample months found, so we can see every
  // field -- not just the four summarized above -- in case total_units is 0 but other fields (unit
  // counts inside unit_mix[], for instance) show the site clearly WAS operating.
  const found = (data || []).filter((r) => ['2018-06-01', '2020-08-01'].includes(String(r.month).slice(0, 10)));
  for (const r of found) {
    let d = r.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
    console.log(`\nFull record, ${site} @ ${String(r.month).slice(0, 10)}:`);
    console.log(JSON.stringify(d, null, 2));
  }
}
process.exit(0);
