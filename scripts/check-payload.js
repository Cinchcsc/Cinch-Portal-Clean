// Read-only: shows both the stored portal_payload singleton and the live portal's fresh-current-month
// merged view, so a current-month drift is obvious instead of silently inspecting the wrong layer.
// npm run check
import { admin } from '../lib/supabaseAdmin.js';
import { decodePortalPayloadStorageValue, readPortalPayloadFreshCurrentMonthStable, summarizeHistoricalMonthlyCoverage } from '../lib/portalPayload.js';
import { retryOnStatementTimeout } from '../lib/supabaseRetry.js';
import { PORTAL_PAYLOAD_BUILD_VERSION } from '../lib/buildPayload.js';

try {
  const pr = await retryOnStatementTimeout(async () => {
    const { data, error } = await admin
      .from('portal_payload').select('payload,generated_at').eq('id', 1)
      .order('generated_at', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    return data || [];
  });
  const p = decodePortalPayloadStorageValue(pr?.[0]?.payload);

  if (p?.sites?.length) {
    console.log(`stored portal_payload · generated ${pr[0].generated_at} · ${p.current_month} · ${p.sites.length} sites`);
    console.log('\nsite               occ%   SelfStorage  TotalRate       rent');
    console.log('-------------------------------------------------------------');
    for (const s of p.sites)
      console.log(`${(s.name || s.code).padEnd(18)} ${String(s.occPC).padStart(5)}   £${(s.ssRate || 0).toFixed(2).padStart(7)}   £${(s.rate || 0).toFixed(2).padStart(7)}  £${String(Math.round(s.rent || 0)).padStart(9)}`);
    console.log('\nPortfolio totals:', JSON.stringify(p.totals));
  } else {
    console.log('portal_payload: no usable rows (count=' + (pr?.length || 0) + ')');
  }

  // 13 Aug 2026 (egress audit): surfaces whether the Aug 11 historical-slice repair has actually
  // finished. Checks build_version's stamp AND independently re-runs the same structural coverage
  // check rebuildPayload.js uses, so a false-positive stamp (a run that deferred some months but
  // still wrote the "current" version tag — see lib/rebuildPayload.js's fullyRepairedThisRun fix)
  // shows up here even though the stamp alone would look clean.
  if (p) {
    const versionCurrent = p.build_version === PORTAL_PAYLOAD_BUILD_VERSION;
    console.log(`\nbuild_version: ${p.build_version || '(none)'} ${versionCurrent ? '(current)' : `(STALE — code expects ${PORTAL_PAYLOAD_BUILD_VERSION})`}`);
    const coverage = summarizeHistoricalMonthlyCoverage(p, { excludeMonth: p.current_month });
    if (coverage.incompleteMonths.length) {
      console.log(`still-incomplete historical month(s) (${coverage.incompleteMonths.length}): ${coverage.incompleteMonths.slice(0, 12).join(', ')}${coverage.incompleteMonths.length > 12 ? ', …' : ''}`);
      console.log(versionCurrent
        ? '-> build_version says current but these months still fail the coverage check — repair is NOT actually complete; rebuild crons will keep re-scanning history.'
        : '-> historical repair has not finished; rebuild crons will keep doing full-history reads until these clear.');
    } else if (versionCurrent) {
      console.log('-> historical repair looks complete: build_version is current and no month fails the structural coverage check.');
    } else {
      console.log('-> structurally the stored history looks fine, but build_version is still stale — the next rebuild will force one more full historical re-scan to confirm, then stamp it current.');
    }
  }

  try {
    const fresh = await readPortalPayloadFreshCurrentMonthStable();
    const live = fresh?.payload;
    if (live?.sites?.length) {
      console.log(`\nlive portal view · generated ${fresh?.generatedAt || live.generated_at || 'unknown'} · ${live.current_month} · ${live.sites.length} sites`);
      console.log('site               occ%   SelfStorage  TotalRate       rent');
      console.log('-------------------------------------------------------------');
      for (const s of live.sites)
        console.log(`${(s.name || s.code).padEnd(18)} ${String(s.occPC).padStart(5)}   £${(s.ssRate || 0).toFixed(2).padStart(7)}   £${(s.rate || 0).toFixed(2).padStart(7)}  £${String(Math.round(s.rent || 0)).padStart(9)}`);
      console.log('\nLive portfolio totals:', JSON.stringify(live.totals));
    }
  } catch (e) {
    console.log('\nlive portal read failed:', e.message);
  }

  const rr = await retryOnStatementTimeout(async () => {
    const { data, error } = await admin
      .from('raw_report').select('site_code,month,data').eq('report', 'occupancy').eq('site_code', 'L001')
      .order('month', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    return data || [];
  });
  let d = rr?.[0]?.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
  if (d) {
    console.log(`\nBicester L001 (${rr[0].month}) parsed occupancy (NOTE: these self_storage_rate_ann/`);
    console.log('total_rate_ann fields are OccupancyStatistics-based and are NOT the authoritative rate —');
    console.log('the locked spec (Michael, 1 Jul 2026) uses RentRoll only (see p.sites[].rate/ssRate above):');
    console.log(`  occ=${d.occupied_units}/${d.total_units}  SelfStorageRate=£${d.self_storage_rate_ann}  TotalRate=£${d.total_rate_ann}  rent=£${d.monthly_rent}`);
    console.log('  by unit type: ' + (d.unit_types || []).map(t => `${t.unit_type}=£${t.rate_per_sqft_ann}`).join('  '));
  }
  process.exit(0);
} catch (error) {
  console.log('payload verification failed after retries:', error.message);
  process.exit(1);
}
