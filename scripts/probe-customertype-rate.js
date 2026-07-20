// PROBE (20 Jul 2026), READ-ONLY — Michael asked why we can't just visit legacy's KPIs page one store
// at a time and add the "Rate per ft² by Customer Type" numbers together to get a portfolio figure
// (legacy's own portfolio view for this widget is currently blank — see task #345, a JS crash in a
// different widget, ReservationsVsMoveOutsWidget, aborts legacy's own update loop before this one's
// turn whenever more than one store is selected).
//
// The reason a plain average of 29 stores' rates doesn't work: the widget shows a RATE (already
// divided: rent ÷ area), and a naive average of 29 already-divided rates weights every store equally
// regardless of size — the same "average-of-averages" mistake this project has had to guard against
// on our own side repeatedly (buildPayload.js sums raw rent/area across every site FIRST and only
// divides once at the very end — see aggregateTotals()'s custSum()).
//
// This proves that out with real numbers instead of just asserting it: it independently recomputes the
// Personal/Business portfolio rate straight from raw_report's stored RentRoll parse (the same
// customer_type.business/residential {area,rent} that feeds buildPayload.js), the CORRECT way
// (sum-then-divide-once), then ALSO computes the WRONG way (plain average of each site's own rate) on
// the exact same data, so the two can be compared side by side. It also reads the live portal_payload
// row so we can confirm the portal's on-screen figure matches the correct recompute (i.e. no
// aggregation-layer bug), not just take the frontend's word for it.
//
// Run: cd cinch-portal-clean && node --env-file=.env scripts/probe-customertype-rate.js
import { admin } from '../lib/supabaseAdmin.js';
import { writeFileSync } from 'fs';

const now = new Date();
const curMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

const { data: rrRows, error: rrErr } = await admin
  .from('raw_report').select('site_code,data,pulled_at')
  .eq('month', curMonthKey).eq('report', 'rent_roll');
if (rrErr) { console.error('rent_roll fetch failed:', rrErr.message); process.exit(1); }

const perSite = (rrRows || []).map((r) => {
  let d = r.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
  const biz = d?.customer_type?.business || { units: 0, area: 0, rent: 0, rate_per_sqft_ann: 0 };
  const res = d?.customer_type?.residential || { units: 0, area: 0, rent: 0, rate_per_sqft_ann: 0 };
  return {
    site_code: r.site_code,
    pulled_at: r.pulled_at,
    business: { units: biz.units || 0, area: biz.area || 0, rent: biz.rent || 0, own_rate: biz.rate_per_sqft_ann || 0 },
    residential: { units: res.units || 0, area: res.area || 0, rent: res.rent || 0, own_rate: res.rate_per_sqft_ann || 0 },
  };
}).sort((a, b) => a.site_code.localeCompare(b.site_code));

function correctRate(seg) {
  // Sum raw rent + area across every site FIRST, divide ONCE. This is the only mathematically valid
  // way to combine per-site rates when sites differ in size (a big store's rent/area should carry
  // more weight than a small store's, which happens automatically here since we're summing the actual
  // pounds and square feet, not the pre-divided rates).
  const sitesWithSeg = perSite.filter((s) => s[seg].area > 0);
  const rentSum = sitesWithSeg.reduce((a, s) => a + s[seg].rent, 0);
  const areaSum = sitesWithSeg.reduce((a, s) => a + s[seg].area, 0);
  return { rate: areaSum ? +(rentSum / areaSum * 12).toFixed(2) : null, rent_sum: +rentSum.toFixed(2), area_sum: +areaSum.toFixed(2), sites_counted: sitesWithSeg.length };
}
function naiveAverageRate(seg) {
  // The WRONG way, computed on purpose for comparison: just average each site's own already-divided
  // rate. A tiny site and a huge site count the same here, which is the mistake.
  const sitesWithSeg = perSite.filter((s) => s[seg].area > 0 && s[seg].own_rate > 0);
  const avg = sitesWithSeg.length ? sitesWithSeg.reduce((a, s) => a + s[seg].own_rate, 0) / sitesWithSeg.length : null;
  return { rate: avg !== null ? +avg.toFixed(2) : null, sites_counted: sitesWithSeg.length };
}

const correct = { business: correctRate('business'), residential: correctRate('residential') };
const naive = { business: naiveAverageRate('business'), residential: naiveAverageRate('residential') };

// Live comparison: what the portal is actually showing right now, straight from the last rebuild.
const { data: pr, error: prErr } = await admin
  .from('portal_payload').select('payload,generated_at').eq('id', 1)
  .order('generated_at', { ascending: false }).limit(1);
let livePayload = pr?.[0]?.payload;
if (typeof livePayload === 'string') { try { livePayload = JSON.parse(livePayload); } catch { livePayload = null; } }
const live = livePayload?.totals?.customerType || null;

const out = {
  probed_at: now.toISOString(),
  current_month: curMonthKey,
  sites_found: perSite.length,
  correct_sum_then_divide_once: {
    business_rate: correct.business.rate,
    residential_rate: correct.residential.rate,
    detail: correct,
  },
  naive_average_of_site_rates_WRONG_METHOD: {
    business_rate: naive.business.rate,
    residential_rate: naive.residential.rate,
    detail: naive,
  },
  live_portal_payload: {
    generated_at: pr?.[0]?.generated_at || null,
    business_rate: live?.business?.rate ?? null,
    residential_rate: live?.residential?.rate ?? null,
  },
  per_site: perSite,
};

const outPath = new URL('../../customertype-rate-probe.json', import.meta.url);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath.pathname}`);
console.log(`\nCorrect (sum-then-divide-once):  Personal £${correct.residential.rate}   Business £${correct.business.rate}`);
console.log(`Naive average of site rates:      Personal £${naive.residential.rate}   Business £${naive.business.rate}`);
console.log(`Live portal right now:            Personal £${out.live_portal_payload.residential_rate}   Business £${out.live_portal_payload.business_rate}`);
process.exit(0);
