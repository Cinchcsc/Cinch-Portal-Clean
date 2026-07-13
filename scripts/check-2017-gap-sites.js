// Follow-up to check-all-backfill-coverage.js: the OLDER gap (~2017-02 through 2018-06) in five
// of the six reports (scheduled_outs, marketing, rate_changes, true_revenue, reservations -- NOT
// rent_roll, which only has a single stray 2017-02 combo) is a completely separate story from the
// L028/L029 2023-07..2026-06 gap already resolved. This checks WHICH SITES it hits, testing the
// same hypothesis that explained L028/L029: maybe some of the ORIGINAL sites weren't actually
// owned/onboarded by Cinch yet back in 2017-2018 (portfolio composition changes over a decade),
// in which case this is also placeholder/non-existent history rather than a real gap.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-2017-gap-sites.js
import { admin } from '../lib/supabaseAdmin.js';

const REPORTS_TO_CHECK = ['rent_roll', 'scheduled_outs', 'marketing', 'rate_changes', 'true_revenue', 'reservations'];
const OLD_START = '2016-06-01'; // occupancy's earliest observed month, per earlier findings
const OLD_END = '2018-06-30';

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

const isOldCanonicalMonth = (mk) => mk >= OLD_START && mk <= OLD_END && /-01$/.test(mk);

const occRows = await fetchAllCombos('occupancy');
const occCombos = new Set(occRows.map((r) => `${r.site_code}|${r.month}`));
const occOldCombos = new Set([...occCombos].filter((c) => isOldCanonicalMonth(c.split('|')[1])));
const occOldMonths = [...new Set([...occOldCombos].map((c) => c.split('|')[1]))].sort();
console.log(`occupancy old-window (${OLD_START}..${OLD_END}) site/month combos: ${occOldCombos.size}, months: ${occOldMonths.join(', ')}\n`);

const siteMissingCounts = {};

for (const rep of REPORTS_TO_CHECK) {
  const rows = await fetchAllCombos(rep);
  const combos = new Set(rows.map((r) => `${r.site_code}|${r.month}`));
  const missing = [...occOldCombos].filter((c) => !combos.has(c));
  const bySite = {};
  for (const m of missing) {
    const [site, month] = m.split('|');
    (bySite[site] ||= []).push(month);
    (siteMissingCounts[site] ||= new Set()).add(rep);
  }
  const sites = Object.keys(bySite).sort();
  console.log(`${rep}: ${missing.length} missing combos across ${sites.length} site(s) in old window.`);
  for (const s of sites) {
    const months = bySite[s].sort();
    console.log(`   ${s}: ${months.length} months missing (${months[0]}..${months[months.length - 1]})`);
  }
  console.log('');
}

console.log('--- Sites affected across multiple reports (old window) ---');
const allSites = Object.keys(siteMissingCounts).sort();
for (const s of allSites) {
  console.log(`${s}: missing in ${siteMissingCounts[s].size}/${REPORTS_TO_CHECK.length} reports (${[...siteMissingCounts[s]].join(', ')})`);
}

// Also print each affected site's EARLIEST occupancy month overall (not just in this window) --
// if a site's earliest-ever occupancy row is already inside/after this window, that confirms it
// wasn't part of the portfolio before then (same placeholder-vs-real-history question as L028/L029).
console.log('\n--- Earliest stored occupancy month per affected site (any report) ---');
const earliestBySite = {};
for (const r of occRows) {
  if (!earliestBySite[r.site_code] || r.month < earliestBySite[r.site_code]) earliestBySite[r.site_code] = r.month;
}
for (const s of allSites) {
  console.log(`${s}: earliest occupancy month = ${earliestBySite[s] || 'none'}`);
}
process.exit(0);
