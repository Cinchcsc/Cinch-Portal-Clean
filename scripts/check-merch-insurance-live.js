// Read-only, no SiteLink calls: checks the ACTUAL portfolio-wide Merchandise Sales and Insurance
// Conversion numbers the portal will render right now, mirroring app/portal-v2/page.js's own
// calculations (merchSalesSum from s.merchandise.chargeFromFinancial, insConvPct from insNewCount /
// moveInsSum) — as opposed to check-marketing-fields.js's per-site diagnostic dump, which still
// prints a stale /merchandise/i label left over from before today's "POS" category fix.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-merch-insurance-live.js
import { admin } from '../lib/supabaseAdmin.js';

const { data: pr, error } = await admin
  .from('portal_payload').select('payload,generated_at').eq('id', 1)
  .order('generated_at', { ascending: false }).limit(1);
if (error) { console.log('read error:', error.message); process.exit(1); }
let p = pr?.[0]?.payload; if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }

const sites = p?.sites || [];
console.log(`Payload generated_at: ${pr?.[0]?.generated_at}   sites: ${sites.length}\n`);

const merchSalesSum = sites.reduce((a, s) => a + ((s.merchandise && s.merchandise.chargeFromFinancial) || 0), 0);
const moveInsSum = sites.reduce((a, s) => a + (s.moveIns || 0), 0);
const insNewCount = sites.reduce((a, s) => a + ((s.insuredNewCustomers && s.insuredNewCustomers.count) || 0), 0);
const insConvPct = moveInsSum ? +(insNewCount / moveInsSum * 100).toFixed(0) : null;

console.log(`Merchandise Sales (Σ chargeFromFinancial): £${merchSalesSum.toFixed(2)}`);
console.log(`Merchandise Income per New Customer: £${moveInsSum ? (merchSalesSum / moveInsSum).toFixed(2) : '0.00'}  (÷ ${moveInsSum} move-ins)`);
console.log(`\nInsurance Conversion: insNewCount=${insNewCount} / moveIns=${moveInsSum} = ${insConvPct}%`);

console.log('\nPer-site breakdown (nonzero only):');
for (const s of sites) {
  const merch = (s.merchandise && s.merchandise.chargeFromFinancial) || 0;
  const insCount = (s.insuredNewCustomers && s.insuredNewCustomers.count) || 0;
  if (merch || insCount) console.log(`  ${(s.name || s.code).padEnd(18)} merch=£${merch.toFixed(2).padStart(9)}   insuredNewCustomers=${insCount}`);
}
process.exit(0);
