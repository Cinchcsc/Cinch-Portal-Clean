// Decisive: check-site-realrate.js proved the CRON-persisted portal_payload has Bicester
// realRate=9.38 / ssReal=9.96 -- exactly matching my own independent recompute. But the browser
// screenshot (with the "LIVE" badge, meaning the global month/range selector is engaged) shows
// £7.51 / £7.99 -- a near-exact x0.8 of EVERY site's real rate, no exceptions. The Rates per ft²
// table's row-mapping reads straight off s.ssReal/s.realRate with no client-side math (page.js
// ~line 1078), so if the selector is on "current month" the browser's sites[] is coming from
// buildPayloadRange() (lib/buildPayload.js) -- a totally different query path than the cached
// portal_payload table check-site-realrate.js read. buildPayloadRange() calls the same recordFor()
// (annualizeFactor=12, confirmed correct) and mergeSiteAcrossRange() re-derives realRate with the
// identical formula/field names -- so on paper it should match. This calls buildPayloadRange()
// directly, exactly like /api/portfolio?from=<thisMonth>&to=<thisMonth> does, and prints Bicester's
// real rate straight from its output -- settling whether the bug is actually in THIS path (e.g.
// buildIndex()/fetchAllRaw() picking a different/older raw_report row than the cron job used) or
// somewhere else entirely (e.g. a frontend fetch race, unrelated to any backend computation).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-range-realrate.js
import { buildPayloadRange } from '../lib/buildPayload.js';

const now = new Date();
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

const payload = await buildPayloadRange(monthStart, monthStart);
console.log(`buildPayloadRange(${monthStart.toISOString().slice(0, 7)} -> ${monthStart.toISOString().slice(0, 7)}) · generated ${payload.generated_at} · ${payload.sites.length} sites\n`);

const bic = payload.sites.find((s) => /bicester/i.test(s.name || ''));
if (bic) {
  console.log(`Bicester (${bic.code}): realRate=${bic.realRate}  ssReal=${bic.ssReal}`);
  console.log(`  trueRevenueNumerator=${bic.trueRevenueNumerator}  areaTotalAll=${bic.areaTotalAll}`);
  console.log(`  ssTrueRevenueNumerator=${bic.ssTrueRevenueNumerator}  ssAreaTotalAll=${bic.ssAreaTotalAll}`);
  console.log(`\n  compare to cron-persisted portal_payload: realRate=9.38 ssReal=9.96, trueRevenueNumerator=19483.82,`);
  console.log(`  areaTotalAll=24932, ssTrueRevenueNumerator=14090.98, ssAreaTotalAll=16981`);
} else {
  console.log('Bicester not found in buildPayloadRange output.');
}

console.log('\nPortfolio totals.realRate/ssReal:', payload.totals ? `realRate=${payload.totals.realRate} ssReal=${payload.totals.ssReal}` : 'n/a');
process.exit(0);
