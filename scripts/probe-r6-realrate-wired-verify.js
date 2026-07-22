// VERIFY (22 Jul 2026), task #308/#403 — URGENT re-check before any more custom-report hunting.
// Everything found this session about the "£6.52/sqft/yr gap" (Credits £1,446.86, Discounts £2,353.04/
// £5,431.89, CSales Collections, etc.) was tested against an AD-HOC Real Rate built from scratch in
// probe scripts: RentRoll's adjRentSum (billing-adjusted dcRent) minus manually-found Discounts/
// Credits, divided by total area x12. Re-reading lib/buildPayload.js's recordFor() just now (lines
// 120-160) shows that is NOT what's actually wired into the live portal. The ACTUAL production Real
// Rate is:
//
//   trueRevenueNumerator = Σ true_revenue's by_type[].truePeriod   (CorpReportID 781861, "TruePeriod"
//                          column -- SiteLink's OWN net-of-adjustments revenue figure, confirmed via
//                          task #87/the 8 Jul probe: TruePeriod already nets adjustments out internally,
//                          so subtracting Discounts/Credits/etc AGAIN would double-count)
//   totalArea            = rent_roll's total_area_all_units (incl. vacant)
//   realRate              = trueRevenueNumerator / totalArea * 12
//
// This has NEVER been checked this session -- probe-r6-formula-wired-verify.js (22 Jul) only verified
// Rate (dcRent-based), not Real Rate. Every subsequent probe (Credits/Discounts/CSales/Valuation) tested
// adjustments against RentRoll rent, a numerator the live code doesn't even use for Real Rate. Before
// hunting further for Credits, need to know: does the ACTUAL wired trueRevenueNumerator-based Real Rate
// already land near legacy's £18.66, or does it have the same/a different gap? This mirrors
// probe-r6-formula-wired-verify.js's exact method (duplicate recordFor()'s real logic verbatim, run it
// through pullReport() against live data) but for realRate/ssReal instead of rate/ssRate.
//
// Run:  node --env-file=.env scripts/probe-r6-realrate-wired-verify.js [siteCode]
import { pullReport } from '../lib/reportMap.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-r6-realrate-wired-verify.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

console.log(`Site: ${site}   Month: ${start.toISOString().slice(0, 7)}\n`);

// Pull through the ACTUAL reportMap.js dispatch/parse path -- same unwrap lesson as
// probe-r6-formula-wired-verify.js (pullReport returns { data, rowcount, raw }, not the data directly).
const { data: rr } = await pullReport('rent_roll', site, start, now);
const { data: tr } = await pullReport('true_revenue', site, start, now);

console.log(`rent_roll: total_area_all_units=${rr.total_area_all_units}, ss.total_area_all_units=${rr.self_storage.total_area_all_units}`);
console.log(`rent_roll: real_rate_per_sqft_ann (fallback)=${rr.real_rate_per_sqft_ann}, ss fallback=${rr.self_storage.real_rate_per_sqft_ann}`);
console.log(`true_revenue: ${(tr.by_type || []).length} by_type row(s): ${(tr.by_type || []).map((r) => `${r.desc}=${r.truePeriod}`).join(', ')}\n`);

// === Verbatim copy of recordFor()'s realRate/ssReal logic (lib/buildPayload.js lines ~120-160) ===
const byType = tr.by_type || [];
const hasTrueRevenue = byType.length > 0;
const totalArea = rr.total_area_all_units || 0;
const realRateFallback = rr.real_rate_per_sqft_ann || 0;
const trueRevenueNumerator = hasTrueRevenue
  ? byType.reduce((a, r) => a + (r.truePeriod || 0), 0)
  : realRateFallback * totalArea / 12;
const annualizeFactor = 12;
const realRate = totalArea ? R2(trueRevenueNumerator / totalArea * annualizeFactor) : realRateFallback;

const ssArea = (rr.self_storage && rr.self_storage.total_area_all_units) || 0;
const ssRealFallback = (rr.self_storage && rr.self_storage.real_rate_per_sqft_ann) || 0;
const ssTrueRevenueNumerator = hasTrueRevenue
  ? byType.filter((r) => String(r.desc || '').toLowerCase().includes('self storage')).reduce((a, r) => a + (r.truePeriod || 0), 0)
  : ssRealFallback * ssArea / 12;
const ssReal = ssArea ? R2(ssTrueRevenueNumerator / ssArea * annualizeFactor) : ssRealFallback;
// === end verbatim copy ===

console.log(`hasTrueRevenue: ${hasTrueRevenue}`);
console.log(`trueRevenueNumerator (Total): £${R2(trueRevenueNumerator)}   totalArea: ${totalArea}`);
console.log(`ssTrueRevenueNumerator: £${R2(ssTrueRevenueNumerator)}   ssArea: ${ssArea}\n`);
console.log(`WIRED Real Rate (Total):        £${realRate} per sqft/yr`);
console.log(`WIRED Real Rate (Self Storage): £${ssReal} per sqft/yr\n`);
console.log('=== Legacy reference (screenshot, Jul 2026) ===');
console.log('Bicester Real Rate: Total £18.66 (SS figure not separately confirmed in this task so far)');
console.log(`\nGap (Total): £${R2(realRate - 18.66)}  (${R2((realRate - 18.66) / 18.66 * 100)}%)`);
console.log('\nThis numerator (TruePeriod, from CorpReportID 781861) is DIFFERENT from the RentRoll-rent-based');
console.log('numerator every other probe this session (Credits/Discounts/CSales/Valuation) tested adjustments');
console.log('against -- if the gap above differs from the £6.52/£7.22 figures reported earlier, those findings');
console.log('need to be re-targeted at THIS numerator, not RentRoll rent, before being called relevant or not.');
process.exit(0);
