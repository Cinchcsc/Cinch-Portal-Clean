// PROBE (20 Jul 2026), READ-ONLY — investigating today's Dashboard spot-check finding: Self Storage
// Real Rate reads £11.30/ft² (ours) vs £14.42/ft² (legacy), ours ~22% LOWER — opposite direction and
// bigger than the plain Rate gap, which is the already-accepted methodology difference (task #228).
// Real Rate has a long history of coverage/formula issues on this project (tasks #77/#87/#107/
// #115-118/#176-181/#187), so before re-opening that whole investigation, testing the most likely
// NEW explanation first: today's true_revenue site-sharding (task #327, deployed this morning) means
// the 29 sites now get their True Revenue pulled across 4 different cron hours (5am/10am/11am/12pm)
// instead of one 5am batch. If today's rebuild-payload (8am) ran BEFORE some shards' scheduled pulls
// landed, those sites' true_revenue data is still whatever was last successfully pulled — which,
// given true_revenue was timing out portfolio-wide before today's fix, could be several days stale —
// while other sites are fresh. Real Rate is a straight sum-then-divide across all 29 sites
// (buildPayload.js's recordFor()/aggregateTotals()), so a stale subset skews the whole portfolio
// figure without any single site looking obviously broken.
//
// This recomputes each site's own Self Storage Real Rate contribution directly from raw_report
// (mirrors buildPayload.js's recordFor()/aggregateTotals() formula exactly) and tags it with which
// shard it belongs to and how stale its true_revenue pull is, so the hypothesis can be checked against
// real numbers instead of asserted from memory.
//
// Run: cd cinch-portal-clean && node --env-file=.env scripts/probe-realrate-freshness.js
import { admin } from '../lib/supabaseAdmin.js';
import { writeFileSync } from 'fs';

const now = new Date();
const curMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
const todayUTC = now.toISOString().slice(0, 10);

const allLocations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const shardOf = Object.fromEntries(allLocations.map((code, i) => [code, i % 4]));

const { data: trRows, error: trErr } = await admin.from('raw_report').select('site_code,data,pulled_at').eq('month', curMonthKey).eq('report', 'true_revenue');
const { data: rrRows, error: rrErr } = await admin.from('raw_report').select('site_code,data').eq('month', curMonthKey).eq('report', 'rent_roll');
if (trErr) { console.error('true_revenue fetch failed:', trErr.message); process.exit(1); }
if (rrErr) { console.error('rent_roll fetch failed:', rrErr.message); process.exit(1); }

const rrBySite = Object.fromEntries((rrRows || []).map(r => [r.site_code, r.data]));

const perSite = (trRows || []).map(r => {
  const byType = Array.isArray(r.data?.by_type) ? r.data.by_type : [];
  const ssTruePeriod = byType.filter(t => String(t.desc || '').toLowerCase().includes('self storage')).reduce((a, t) => a + (t.truePeriod || 0), 0);
  const ssArea = rrBySite[r.site_code]?.self_storage?.total_area_all_units || 0;
  const ssReal = ssArea ? +(ssTruePeriod / ssArea * 12).toFixed(2) : null;
  const pulledDate = r.pulled_at ? String(r.pulled_at).slice(0, 10) : null;
  return {
    site_code: r.site_code,
    shard: shardOf[r.site_code] ?? null,
    pulled_at: r.pulled_at,
    pulled_today: pulledDate === todayUTC,
    ss_true_period_sum: +ssTruePeriod.toFixed(2),
    ss_area_total_all: ssArea,
    ss_real_rate: ssReal,
    has_true_revenue_rows: byType.length > 0,
  };
});

const shardSummary = {};
for (const s of perSite) {
  const key = s.shard ?? 'unmatched';
  (shardSummary[key] ??= { sites: 0, pulled_today: 0, pulled_stale: 0 });
  shardSummary[key].sites += 1;
  if (s.pulled_today) shardSummary[key].pulled_today += 1; else shardSummary[key].pulled_stale += 1;
}

const portfolioSSReal = (() => {
  const num = perSite.reduce((a, s) => a + s.ss_true_period_sum, 0);
  const den = perSite.reduce((a, s) => a + s.ss_area_total_all, 0);
  return den ? +(num / den * 12).toFixed(2) : null;
})();
const freshOnly = perSite.filter(s => s.pulled_today);
const portfolioSSReal_freshOnly = (() => {
  const num = freshOnly.reduce((a, s) => a + s.ss_true_period_sum, 0);
  const den = freshOnly.reduce((a, s) => a + s.ss_area_total_all, 0);
  return den ? +(num / den * 12).toFixed(2) : null;
})();

const out = {
  probed_at: now.toISOString(),
  current_month: curMonthKey,
  today_utc: todayUTC,
  sites_configured: allLocations.length,
  sites_with_true_revenue_row: perSite.length,
  shard_summary: shardSummary,
  portfolio_ss_real_rate_all_sites: portfolioSSReal,
  portfolio_ss_real_rate_fresh_only: portfolioSSReal_freshOnly,
  fresh_site_count: freshOnly.length,
  per_site: perSite.sort((a, b) => (a.shard ?? 9) - (b.shard ?? 9)),
};
const outPath = new URL('../../realrate-freshness-probe.json', import.meta.url);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath.pathname}`);
console.log(`Portfolio SS Real Rate (all ${perSite.length} sites): £${portfolioSSReal}/ft²`);
console.log(`Portfolio SS Real Rate (${freshOnly.length} pulled today only): £${portfolioSSReal_freshOnly}/ft²`);
console.log('Shard summary:', JSON.stringify(shardSummary));
process.exit(0);
