// PROBE (20 Jul 2026), READ-ONLY — Michael asked me to try to confirm the two remaining UNCONFIRMED
// widgets on the formula reference doc (Enquiry -> Reservation + its YoY variant, Marketing page).
// Live-checking today turned up a real gap that doesn't match this project's own history: our June
// 2026 portfolio Enquiry -> Reservation reads 14.5% live right now, but lib/reportMap.js's own comment
// (17 Jul, task #310) records Michael validating June at 23.9% ours vs legacy's confirmed 19.8% —
// "same ballpark", accepted. Legacy itself, freshly re-checked today, shows 19.9% for June (portfolio,
// 26 sites — legacy's Marketing page has no Bedford/Paulton row, same gap noted in the Enquiries
// spot-check earlier this week). So: legacy hasn't moved (19.8% -> 19.9%, noise), but OUR OWN June
// figure has moved a lot (23.9% -> 14.5%) in three days for a period that's fully closed and shouldn't
// still be changing. This checks two things directly instead of guessing:
//   1) Does our current live figure match what's actually stored (rules out a display bug)?
//   2) Does dropping Bedford/Paulton (sites legacy's Marketing page doesn't track at all) to match
//      legacy's exact scope close some of the gap?
//
// Run: cd cinch-portal-clean && node --env-file=.env scripts/probe-enquiry-reservation-gap.js
import { admin } from '../lib/supabaseAdmin.js';
import { writeFileSync } from 'fs';

const JUNE_KEY = '2026-06-01';
const NOT_IN_LEGACY_MARKETING = ['L021', 'L026']; // Bedford, Paulton — confirmed absent from legacy's own Marketing page rows

const { data: rows, error } = await admin
  .from('raw_report').select('site_code,data,pulled_at')
  .eq('month', JUNE_KEY).eq('report', 'lead_funnel');
if (error) { console.error('lead_funnel fetch failed:', error.message); process.exit(1); }

const perSite = (rows || []).map((r) => {
  let d = r.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
  return {
    site_code: r.site_code,
    pulled_at: r.pulled_at,
    total_enquiries: d?.total_enquiries ?? null,
    reservation_stage_count: d?.reservation_stage_count ?? null,
  };
}).sort((a, b) => a.site_code.localeCompare(b.site_code));

function portfolioRatio(sites) {
  const usable = sites.filter((s) => s.total_enquiries !== null && s.reservation_stage_count !== null);
  const enqSum = usable.reduce((a, s) => a + s.total_enquiries, 0);
  const resSum = usable.reduce((a, s) => a + s.reservation_stage_count, 0);
  return { pct: enqSum ? +(resSum / enqSum * 100).toFixed(1) : null, enq_sum: enqSum, res_sum: resSum, sites_counted: usable.length };
}

const all29 = portfolioRatio(perSite);
const excl2 = portfolioRatio(perSite.filter((s) => !NOT_IN_LEGACY_MARKETING.includes(s.site_code)));

const { data: pr } = await admin
  .from('portal_payload').select('payload,generated_at').eq('id', 1)
  .order('generated_at', { ascending: false }).limit(1);
let livePayload = pr?.[0]?.payload;
if (typeof livePayload === 'string') { try { livePayload = JSON.parse(livePayload); } catch { livePayload = null; } }
// liveHistory-style per-month record isn't in totals (that's current-period only) — this cross-check
// is against the live PAGE figure Michael and I both just read in the browser for June (Prior Month).

const out = {
  probed_at: new Date().toISOString(),
  checked_month: JUNE_KEY,
  context: {
    project_history_17_jul: 'reportMap.js comment: June ours=23.9% vs legacy=19.8%, called "same ballpark", accepted (task #310)',
    live_today_ours: '14.5% (Marketing page, Prior Month = Jun 2026, all 29 sites, read in-browser 20 Jul)',
    live_today_legacy: '19.9% (Marketing page, All Sites, Jun 2026, read in-browser 20 Jul, 26 sites — no Bedford/Paulton rows)',
  },
  recomputed_from_raw_report: {
    all_29_sites: all29,
    excluding_bedford_paulton_26_sites: excl2,
  },
  per_site: perSite,
};

const outPath = new URL('../../enquiry-reservation-gap-probe.json', import.meta.url);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath.pathname}`);
console.log(`\nRecomputed from raw_report, June 2026:`);
console.log(`  All 29 sites:              ${all29.pct}%  (${all29.res_sum} / ${all29.enq_sum}, ${all29.sites_counted} sites)`);
console.log(`  Excl. Bedford+Paulton (26): ${excl2.pct}%  (${excl2.res_sum} / ${excl2.enq_sum}, ${excl2.sites_counted} sites)`);
console.log(`\nFor reference: legacy today = 19.9%  |  our live page today = 14.5%  |  17 Jul note said ours was 23.9%`);
process.exit(0);
