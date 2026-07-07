// Read-only, no SiteLink calls: dumps every site's full rate breakdown (asking + real, SS + Total)
// from the current portal_payload, so we can check Michael's recollection of Bicester's Self
// Storage REAL rate being ~£28.02-28.20 "last week" against what's live now — the pull-output
// reconciliation table only prints ssRate (asking) and rate (asking Total), not the real-rate
// pair, so this fills in the missing columns.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-site-rates.js
import { admin } from '../lib/supabaseAdmin.js';

const { data: pr, error } = await admin
  .from('portal_payload').select('payload,generated_at').eq('id', 1)
  .order('generated_at', { ascending: false }).limit(1);
if (error) { console.log('read error:', error.message); process.exit(1); }
let p = pr?.[0]?.payload; if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }

console.log(`Payload generated_at: ${pr?.[0]?.generated_at}\n`);
console.log('site               ssRate(ask)  ssReal   totalRate(ask)  realRate');
console.log('-------------------------------------------------------------------');
for (const s of (p?.sites || [])) {
  console.log(
    `${(s.name || s.code).padEnd(18)} £${(s.ssRate || 0).toFixed(2).padStart(9)}  £${(s.ssReal || 0).toFixed(2).padStart(6)}   £${(s.rate || 0).toFixed(2).padStart(11)}   £${(s.realRate || 0).toFixed(2).padStart(6)}`
  );
}
process.exit(0);
