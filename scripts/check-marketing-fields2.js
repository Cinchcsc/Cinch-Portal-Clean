// Follow-up to check-marketing-fields.js: that script showed (1) financial.categories has 25 rows
// but NONE match /merchandise/i — need the full category list to find what merchandise charges are
// actually labelled as, and (2) insurance_roll.insured_tenants is 0 for every site — need to know if
// InsuranceRoll returned ZERO rows for June entirely (same "not historical-aware" issue as
// RentRoll/OccupancyStatistics/ManagementSummary/ReservationList) or if it returned rows but none
// had iActive set.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-marketing-fields2.js
import { admin } from '../lib/supabaseAdmin.js';

const now = new Date();
const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const prevKey = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}-01`;
const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

const SITE = process.argv[2] || 'L001';

const { data, error } = await admin
  .from('raw_report')
  .select('month,report,data')
  .eq('site_code', SITE)
  .in('month', [prevKey, curKey])
  .in('report', ['financial', 'insurance_roll']);
if (error) { console.log('read error:', error.message); process.exit(1); }

for (const month of [prevKey, curKey]) {
  console.log(`\n=== ${SITE} / ${month} ===`);
  const fin = data.find(r => r.month.startsWith(month.slice(0, 7)) && r.report === 'financial')?.data;
  if (fin) {
    console.log(`financial: ${fin.categories?.length || 0} categories, total_charge=£${fin.total_charge}`);
    for (const c of (fin.categories || [])) console.log(`   ${c.category.padEnd(20)} / ${c.desc.padEnd(30)}  charge=£${c.charge}`);
  } else console.log('financial: NO ROW');

  const ins = data.find(r => r.month.startsWith(month.slice(0, 7)) && r.report === 'insurance_roll')?.data;
  if (ins) {
    console.log(`insurance_roll: insured_units=${ins.insured_units}, monthly_premium=£${ins.monthly_premium}, insured_tenants=${ins.insured_tenants?.length || 0}`);
  } else console.log('insurance_roll: NO ROW');
}
process.exit(0);
