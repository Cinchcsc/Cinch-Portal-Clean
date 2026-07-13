// Follow-up to check-all-backfill-coverage.js: ALL SIX reports (rent_roll, scheduled_outs,
// marketing, rate_changes, true_revenue, reservations) share a gap in the SAME recent window
// (~2023-07 through 2026-06), on top of an older, lower-priority 2016-2018 gap. scheduled_outs and
// marketing even have the IDENTICAL missing-combo count (608) and month list -- suggesting a
// shared cause rather than six independent ones. This checks WHICH SITES are missing in the recent
// window for each report, to see whether it's the same handful of sites across the board (one root
// cause: e.g. these sites weren't in SITELINK_LOCATIONS or had an account issue for a period) vs.
// scattered across many different sites (six separate problems).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-recent-gap-sites.js
import { admin } from '../lib/supabaseAdmin.js';

const REPORTS_TO_CHECK = ['rent_roll', 'scheduled_outs', 'marketing', 'rate_changes', 'true_revenue', 'reservations'];
const RECENT_START = '2023-07-01'; // matches the shared gap window found by check-all-backfill-coverage.js
const RECENT_END = '2026-06-30';   // inclusive-ish; stray 2026-04-30/2026-05-31 combos excluded separately below

async function fetchAllCombos(rep) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('raw_report')
      .select('site_code,month')
      .eq('report', rep)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${rep}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const isRecentCanonicalMonth = (mk) => mk >= RECENT_START && mk <= RECENT_END && /-01$/.test(mk);

const occRows = await fetchAllCombos('occupancy');
const occCombos = new Set(occRows.map((r) => `${r.site_code}|${r.month}`));
const occRecentCombos = new Set([...occCombos].filter((c) => isRecentCanonicalMonth(c.split('|')[1])));
console.log(`occupancy recent-window (>= ${RECENT_START}) site/month combos: ${occRecentCombos.size}\n`);

const siteMissingCounts = {}; // site_code -> Set of reports that have a recent-window gap for it

for (const rep of REPORTS_TO_CHECK) {
  const rows = await fetchAllCombos(rep);
  const combos = new Set(rows.map((r) => `${r.site_code}|${r.month}`));
  const missing = [...occRecentCombos].filter((c) => !combos.has(c));
  const bySite = {};
  for (const m of missing) {
    const [site, month] = m.split('|');
    (bySite[site] ||= []).push(month);
    (siteMissingCounts[site] ||= new Set()).add(rep);
  }
  const sites = Object.keys(bySite).sort();
  console.log(`${rep}: ${missing.length} missing combos across ${sites.length} site(s) in recent window.`);
  for (const s of sites) {
    console.log(`   ${s}: ${bySite[s].length} months missing (${bySite[s][0]}..${bySite[s][bySite[s].length - 1]})`);
  }
  console.log('');
}

console.log('--- Sites affected across multiple reports (recent window) ---');
const allSites = Object.keys(siteMissingCounts).sort();
for (const s of allSites) {
  console.log(`${s}: missing in ${siteMissingCounts[s].size}/${REPORTS_TO_CHECK.length} reports (${[...siteMissingCounts[s]].join(', ')})`);
}
process.exit(0);
