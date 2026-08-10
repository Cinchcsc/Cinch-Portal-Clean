// Read-only: shows both the stored portal_payload singleton and the live portal's fresh-current-month
// merged view, so a current-month drift is obvious instead of silently inspecting the wrong layer.
// npm run check
import { admin } from '../lib/supabaseAdmin.js';
import { readPortalPayloadFreshCurrentMonth } from '../lib/portalPayload.js';
import { retryOnStatementTimeout } from '../lib/supabaseRetry.js';

try {
  const pr = await retryOnStatementTimeout(async () => {
    const { data, error } = await admin
      .from('portal_payload').select('payload,generated_at').eq('id', 1)
      .order('generated_at', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    return data || [];
  });
  let p = pr?.[0]?.payload; if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }

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

  try {
    const fresh = await readPortalPayloadFreshCurrentMonth();
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
