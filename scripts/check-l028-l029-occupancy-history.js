// Michael confirmed L028 (Edmonton) / L029 (Abingdon) were "just added" to the portfolio -- but
// check-recent-gap-sites.js showed `occupancy` already has rows for both going back to 2023-07-01.
// Two very different explanations fit that: (a) these are real operating sites Cinch has owned/run
// since mid-2023, only recently brought into THIS portal's SITELINK_LOCATIONS scope -- in which case
// the occupancy history is genuine and the other 5 reports are worth backfilling the same way; or
// (b) SiteLink auto-creates an OccupancyStatistics-style record from account/site creation even for
// a site that wasn't actually operating yet, in which case those early months could be placeholder/
// zero data not worth backfilling anything against.
// This pulls occupancy's actual parsed numbers for L028/L029 across the full 2023-07..2026-06
// window and prints occupied units/area month by month, so we can see directly whether it looks
// like a real ramp-up (occupied units near 0 early, climbing over time -- consistent with a new
// site filling up) vs flat/placeholder values, without needing to guess.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-l028-l029-occupancy-history.js
import { admin } from '../lib/supabaseAdmin.js';

const SITES = ['L028', 'L029'];

async function fetchSiteRows(site) {
  const { data, error } = await admin
    .from('raw_report')
    .select('month,data,pulled_at')
    .eq('report', 'occupancy')
    .eq('site_code', site)
    .order('month');
  if (error) throw new Error(`${site}: ${error.message}`);
  return data || [];
}

for (const site of SITES) {
  const rows = await fetchSiteRows(site);
  console.log(`\n=== ${site}: ${rows.length} occupancy rows ===`);
  console.log('month        occupied_units   occupied_area   total_units   total_area');
  for (const r of rows) {
    let d = r.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
    // Print whatever the parser's actual field names are -- pulling a few likely candidates rather
    // than assuming one exact shape, since reportMap.js's occupancy parser hasn't been re-read here.
    const occUnits = d?.occupied_units ?? d?.occUnits ?? d?.units_occupied ?? '?';
    const occArea = d?.occupied_area ?? d?.occArea ?? d?.area_occupied ?? '?';
    const totUnits = d?.total_units ?? d?.totalUnits ?? d?.units_total ?? '?';
    const totArea = d?.total_area ?? d?.totalArea ?? d?.area_total ?? '?';
    console.log(`${String(r.month).slice(0, 10).padEnd(12)} ${String(occUnits).padStart(14)}  ${String(occArea).padStart(13)}  ${String(totUnits).padStart(11)}  ${String(totArea).padStart(10)}`);
  }
  if (rows.length) {
    let d0 = rows[0].data; if (typeof d0 === 'string') { try { d0 = JSON.parse(d0); } catch {} }
    console.log(`\nFull raw record for ${site}'s EARLIEST stored month (${rows[0].month}):`);
    console.log(JSON.stringify(d0, null, 2));
  }
}
process.exit(0);
