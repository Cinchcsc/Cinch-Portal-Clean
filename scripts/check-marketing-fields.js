// Read-only, no SiteLink calls: after today's pull, Michael reports Merchandise Sales, Merchandise
// Income per New Customer, and Insurance Conversion are STILL showing 0. This dumps the raw pieces
// each of those widgets is built from (June's financial/merchandise/insurance_roll/move_ins_outs
// reports) for a handful of sites, so we can see exactly which link in the chain is empty:
//   Merchandise Sales    <- financial.categories filtered to /merchandise/i, summed `charge`
//   Insurance Conversion <- insuredNewCustomers (move_ins_outs' move-in TenantIDs ∩ insurance_roll's
//                           insured_tenants) ÷ moveIns
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-marketing-fields.js
import { admin } from '../lib/supabaseAdmin.js';

const now = new Date();
const juneKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;   // last complete month label used below is computed properly
const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const prevKey = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}-01`;

const SITES = (process.argv[2] || 'L001,L002,L003').split(',');

const { data, error } = await admin
  .from('raw_report')
  .select('site_code,report,data,pulled_at')
  .in('site_code', SITES)
  .eq('month', prevKey)
  .in('report', ['financial', 'merchandise', 'insurance_roll', 'move_ins_outs']);

if (error) { console.log('read error:', error.message); process.exit(1); }

console.log(`Previous (complete) month being checked: ${prevKey}\n`);

const bySite = {};
for (const r of (data || [])) { (bySite[r.site_code] ??= {})[r.report] = r; }

for (const code of SITES) {
  const rows = bySite[code] || {};
  console.log(`=== ${code} ===`);
  for (const key of ['financial', 'merchandise', 'insurance_roll', 'move_ins_outs']) {
    const r = rows[key];
    if (!r) { console.log(`  ${key}: MISSING (no row for ${prevKey})`); continue; }
    console.log(`  ${key}: pulled_at=${r.pulled_at}`);
  }
  const fin = rows.financial?.data || {};
  const cats = fin.categories || [];
  const merchCats = cats.filter(c => /merchandise/i.test(c.category) || /merchandise/i.test(c.desc));
  console.log(`  financial.categories: ${cats.length} total, ${merchCats.length} matching /merchandise/i`);
  if (merchCats.length) console.log(`    matches: ${JSON.stringify(merchCats)}`);
  else if (cats.length) console.log(`    sample categories: ${cats.slice(0, 5).map(c => `${c.category}/${c.desc}`).join(', ')}`);

  const ins = rows.insurance_roll?.data || {};
  const insuredTenants = ins.insured_tenants || [];
  console.log(`  insurance_roll.insured_tenants: ${insuredTenants.length} rows`);

  const mio = rows.move_ins_outs?.data || {};
  const moveInIds = mio.move_in_tenant_ids || [];
  console.log(`  move_ins_outs.move_in_tenant_ids: ${moveInIds.length} rows, move_ins=${mio.move_ins ?? 'n/a'}`);

  const insuredSet = new Set(insuredTenants.map(t => String(t.tenantId)));
  const overlap = moveInIds.filter(id => insuredSet.has(String(id)));
  console.log(`  -> overlap (new customers who are insured): ${overlap.length}`);
  console.log();
}
process.exit(0);
