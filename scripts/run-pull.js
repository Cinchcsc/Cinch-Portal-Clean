// Run a full pull locally (writes to Supabase via the service-role key) and print a per-site
// reconciliation table using the SAME fresh-current-month read path the live portal serves, so the
// numbers can be checked against the actual UI rather than the stored portal_payload row alone.
// npm run pull
import { runPull } from '../lib/pull.js';
import { readPortalPayloadFreshCurrentMonthStable } from '../lib/portalPayload.js';

const result = await runPull({ triggerLabel: 'cli:npm-run-pull' });
console.log('PULL RESULT:', JSON.stringify(result, null, 2));

try {
  const fresh = await readPortalPayloadFreshCurrentMonthStable();
  const p = fresh?.payload;
  if (p?.sites?.length) {
    console.log(`\nReconciliation — ${p.current_month} · generated ${fresh?.generatedAt || p.generated_at || 'unknown'} · Rate/ft² annualised (compare SS rate to your live portal):`);
    console.log('site               occ%   SelfStorage  TotalRate       rent');
    console.log('-------------------------------------------------------------');
    for (const s of p.sites) {
      console.log(
        `${(s.name || s.code).padEnd(18)} ${String(s.occPC).padStart(5)}   £${(s.ssRate || 0).toFixed(2).padStart(7)}   £${(s.rate || 0).toFixed(2).padStart(7)}  £${String(Math.round(s.rent || 0)).padStart(9)}`
      );
    }
    console.log('\nPortfolio totals:', JSON.stringify(p.totals));
  } else {
    console.log('\n(No usable live portal payload yet — check the PULL RESULT errors above.)');
  }
} catch (e) { console.log('\nReconciliation read failed:', e.message); }

process.exit(result.status === 'error' ? 1 : 0);
