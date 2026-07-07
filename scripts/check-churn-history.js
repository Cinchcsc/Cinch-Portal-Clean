// Read-only, no SiteLink calls: dumps the trailing 12 months of `history` (the array Customer Churn
// is computed from) so we can see exactly which months have real moveOuts/occ data vs missing/zero
// — Michael reported Customer Churn showing 15.1% vs the legacy portal's ~94%, which only makes
// sense if some months in the trailing-12 window are missing moveOuts data (diluting the sum).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-churn-history.js
import { admin } from '../lib/supabaseAdmin.js';

const { data: pr, error } = await admin
  .from('portal_payload').select('payload,generated_at').eq('id', 1)
  .order('generated_at', { ascending: false }).limit(1);
if (error) { console.log('read error:', error.message); process.exit(1); }
let p = pr?.[0]?.payload; if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }

if (!p?.history?.length) { console.log('No history array in payload.'); process.exit(0); }

console.log(`Total months in history: ${p.history.length}\n`);
const h12 = p.history.slice(-12);
console.log('Trailing 12 months (what Customer Churn actually sums):');
console.log('month      occ    moveIns  moveOuts');
console.log('---------------------------------------');
for (const m of h12) console.log(`${m.month}   ${String(m.occ).padStart(5)}   ${String(m.moveIns).padStart(6)}   ${String(m.moveOuts).padStart(7)}`);

const moveOutsSum = h12.reduce((a, m) => a + (m.moveOuts || 0), 0);
const avgOcc = h12.reduce((a, m) => a + (m.occ || 0), 0) / h12.length;
console.log(`\nΣ moveOuts (12mo): ${moveOutsSum}`);
console.log(`avg occ (12mo): ${avgOcc.toFixed(0)}`);
console.log(`Churn % = ${(avgOcc ? (moveOutsSum / avgOcc * 100) : 0).toFixed(1)}%`);
process.exit(0);
