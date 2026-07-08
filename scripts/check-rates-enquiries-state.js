// Diagnostic for two reported symptoms (8 Jul 2026): "rates showing 0" and "enquiries are
// 51/37/1797/1885" (1885 is suspiciously exactly the OLD pre-fix total cited in buildPayload.js's
// own history comment — before the 7 Jul ManagementSummary swap, back when lead_funnel used the
// unfixed sRentalType='Inquiry' filter). Read-only, no SiteLink calls — just inspects what's
// actually sitting in Supabase right now, including WHEN it was last pulled, to tell staleness
// (never re-pulled since today's code fixes) apart from a genuine new bug.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-rates-enquiries-state.js
import { admin } from '../lib/supabaseAdmin.js';

const months = ['2026-07-01', '2026-06-01'];

for (const month of months) {
  console.log(`\n=== ${month} ===`);
  for (const report of ['lead_funnel', 'rent_roll']) {
    const { data, error } = await admin.from('raw_report').select('site_code,pulled_at,data').eq('month', month).eq('report', report);
    if (error) { console.log(`  ${report}: read error: ${error.message}`); continue; }
    if (!data || !data.length) { console.log(`  ${report}: NO ROWS AT ALL for this month.`); continue; }
    const pulledAts = data.map((r) => r.pulled_at).sort();
    console.log(`  ${report}: ${data.length} site-rows. Oldest pulled_at=${pulledAts[0]}  Newest pulled_at=${pulledAts[pulledAts.length - 1]}`);
    if (report === 'lead_funnel') {
      let phone = 0, walkin = 0, web = 0, total = 0;
      for (const r of data) { const d = r.data || {}; phone += d.phone || 0; walkin += d.walkin || 0; web += d.web || 0; total += d.total_enquiries || 0; }
      console.log(`    STORED sums: phone=${phone} walkin=${walkin} web=${web} total_enquiries=${total}`);
    }
    if (report === 'rent_roll') {
      let areaSum = 0, stdRentSum = 0, rentSum = 0, zeroSites = [], missingSites = [];
      const seen = new Set();
      for (const r of data) {
        seen.add(r.site_code);
        const d = r.data || {};
        areaSum += d.area_sum || 0; stdRentSum += d.std_rent_sum || 0; rentSum += d.rent_sum || 0;
        if (!d.area_sum && !d.std_rent_sum && !d.rent_sum) zeroSites.push(r.site_code);
      }
      const { data: allSites } = await admin.from('sites').select('code');
      for (const s of (allSites || [])) if (!seen.has(s.code)) missingSites.push(s.code);
      console.log(`    STORED sums: area_sum=${areaSum} std_rent_sum=${stdRentSum} rent_sum=${rentSum}`);
      console.log(`    Sites with all-zero rent_roll fields: ${zeroSites.length ? zeroSites.join(', ') : '(none)'}`);
      console.log(`    Sites in 'sites' table with NO rent_roll row at all this month: ${missingSites.length ? missingSites.join(', ') : '(none)'}`);
    }
  }
}

console.log('\n=== portal_payload freshness ===');
const { data: pp, error: ppErr } = await admin.from('portal_payload').select('generated_at').eq('id', 1).single();
if (ppErr) console.log('  read error:', ppErr.message);
else console.log(`  generated_at = ${pp.generated_at}  (compare to now: ${new Date().toISOString()})`);
process.exit(0);
