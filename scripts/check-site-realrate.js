// Decisive: check-payload.js confirmed the STORED portal_payload has a portfolio-wide
// totals.realRate (£5.44) / totals.ssReal (£5.59) -- but that's the whole-portfolio blended
// average across all 29 sites, not comparable to any one site's screenshot figure (e.g. Bicester
// £7.51) or my scripts' individual recomputes (Bicester £9.38-9.39 from probe-realrate-stored-vs-live.js).
// check-payload.js's per-site loop only ever prints plain rate/ssRate, never realRate/ssReal -- so
// we still don't know what the BACKEND actually stored for Real Rate, site by site. recordFor()
// (buildPayload.js) exposes the raw ingredients on every site record (trueRevenueNumerator,
// areaTotalAll, ssTrueRevenueNumerator, ssAreaTotalAll), but it's not yet confirmed whether it ALSO
// writes a precomputed realRate/ssReal per site the way it does for totals. This script prints
// BOTH -- whatever's actually on the stored record (if anything) AND a manual recompute from the
// raw ingredients -- for every site, no SiteLink calls, so we can hold the true stored numbers up
// directly against the screenshot and against my earlier scripts' recomputes.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-site-realrate.js
import { admin } from '../lib/supabaseAdmin.js';

const { data: pr, error } = await admin
  .from('portal_payload').select('payload,generated_at').eq('id', 1)
  .order('generated_at', { ascending: false }).limit(1);
if (error) { console.log('portal_payload read error:', error.message); process.exit(1); }
let p = pr?.[0]?.payload; if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }
if (!p?.sites?.length) { console.log('no usable payload'); process.exit(1); }

console.log(`portal_payload · generated ${pr[0].generated_at} · ${p.sites.length} sites\n`);
console.log('site               plain-SS  plain-Tot  |  real-SS(calc)  real-Tot(calc)  |  stored realRate/ssReal field?');
console.log('---------------------------------------------------------------------------------------------------------');

for (const s of p.sites) {
  const realTot = s.areaTotalAll ? (s.trueRevenueNumerator / s.areaTotalAll) * 12 : null;
  const realSS = s.ssAreaTotalAll ? (s.ssTrueRevenueNumerator / s.ssAreaTotalAll) * 12 : null;
  const hasField = (s.realRate != null || s.ssReal != null)
    ? `YES -> realRate=${s.realRate}  ssReal=${s.ssReal}`
    : 'not present on site record';
  console.log(
    `${(s.name || s.code).padEnd(18)} £${(s.ssRate || 0).toFixed(2).padStart(7)}  £${(s.rate || 0).toFixed(2).padStart(7)}  |  £${(realSS ?? 0).toFixed(2).padStart(9)}   £${(realTot ?? 0).toFixed(2).padStart(9)}   |  ${hasField}`
  );
}

// Print the full raw record for Bicester specifically, since that's the exact site/number
// (screenshot £7.51 vs scripts £9.38-9.39) the whole investigation hinges on.
const bic = p.sites.find(x => /bicester/i.test(x.name || ''));
if (bic) {
  console.log('\n--- Full stored record for Bicester (every field) ---');
  console.log(JSON.stringify(bic, null, 2));
}
process.exit(0);
