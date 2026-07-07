// Read-only, no SiteLink calls: dumps the RAW sums (not just the final rate) behind Bicester's
// Self Storage Real Rate, so Michael can line them up directly against his Excel sums (ΣdcRent,
// ΣdcStandardRate, ΣArea) for occupied Self Storage rows — same filters he used (bRented=1,
// sTypeName contains "self storage") — to find exactly where a ~£0.40-0.50 gap comes from
// (numerator, denominator, or just live-vs-export timing drift).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-bicester-rentroll-sums.js
import { admin } from '../lib/supabaseAdmin.js';

const SITE = process.argv[2] || 'L001';   // Bicester
const now = new Date();
const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

const { data, error } = await admin
  .from('raw_report')
  .select('pulled_at,data')
  .eq('site_code', SITE)
  .eq('month', monthKey)
  .eq('report', 'rent_roll')
  .maybeSingle();

if (error) { console.log('read error:', error.message); process.exit(1); }
if (!data) { console.log(`No rent_roll row for ${SITE} / ${monthKey}.`); process.exit(0); }

const d = data.data || {};
console.log(`Site: ${SITE}   Month: ${monthKey}   pulled_at: ${data.pulled_at}\n`);
console.log('These are the SUMS behind the rate (already occupied-only, from lib/reportMap.js):\n');
console.log(`Self Storage:  ΣdcRent=£${(d.self_storage?.rent_sum ?? 0).toFixed(2)}   ΣdcStandardRate=£${(d.self_storage?.std_rent_sum ?? 0).toFixed(2)}   ΣArea=${d.self_storage?.area_sum ?? 0} ft²`);
console.log(`  -> SS Rate (ask) = ${(d.self_storage?.rent_sum ?? 0)} / ${(d.self_storage?.area_sum ?? 0)} x 12 = £${(d.self_storage?.rate_per_sqft_ann ?? 0).toFixed(2)}`);
console.log(`  -> SS Real Rate  = ${(d.self_storage?.std_rent_sum ?? 0)} / ${(d.self_storage?.area_sum ?? 0)} x 12 = £${(d.self_storage?.real_rate_per_sqft_ann ?? 0).toFixed(2)}`);
console.log(`\nAll unit types:  ΣdcRent=£${(d.rent_sum ?? 0).toFixed(2)}   ΣdcStandardRate=£${(d.std_rent_sum ?? 0).toFixed(2)}   ΣArea=${d.area_sum ?? 0} ft²`);
console.log(`  -> Total Rate (ask) = £${(d.rate_per_sqft_ann ?? 0).toFixed(2)}`);
console.log(`  -> Total Real Rate  = £${(d.real_rate_per_sqft_ann ?? 0).toFixed(2)}`);
console.log(`\nOccupied tenant count (all types): ${d.tenants ?? 0}`);
process.exit(0);
