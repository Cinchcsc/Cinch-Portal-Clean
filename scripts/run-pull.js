// Run a full pull locally (writes to Supabase via the service-role key) and print a per-site
// reconciliation table so the numbers can be checked against the live portal.  npm run pull
import { runPull } from '../lib/pull.js';
import { admin } from '../lib/supabaseAdmin.js';

const result = await runPull();
console.log('PULL RESULT:', JSON.stringify(result, null, 2));

try {
  const { data: pr } = await admin.from('portal_payload').select('payload,generated_at').eq('id', 1).order('generated_at', { ascending: false }).limit(1);
  let p = pr?.[0]?.payload; if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }
  if (p?.sites?.length) {
    console.log(`\nReconciliation — ${p.current_month} · Rate/ft² annualised (compare SS rate to your live portal):`);
    console.log('site               occ%   SelfStorage  TotalRate       rent');
    console.log('-------------------------------------------------------------');
    for (const s of p.sites) {
      console.log(
        `${(s.name || s.code).padEnd(18)} ${String(s.occPC).padStart(5)}   £${(s.ssRate || 0).toFixed(2).padStart(7)}   £${(s.rate || 0).toFixed(2).padStart(7)}  £${String(Math.round(s.rent || 0)).padStart(9)}`
      );
    }
    console.log('\nPortfolio totals:', JSON.stringify(p.totals));
  } else {
    console.log('\n(No portal_payload rows yet — check the PULL RESULT errors above.)');
  }
} catch (e) { console.log('\nReconciliation read failed:', e.message); }

process.exit(result.status === 'error' ? 1 : 0);
