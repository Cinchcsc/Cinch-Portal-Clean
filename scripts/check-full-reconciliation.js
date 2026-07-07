// Full reconciliation dump: every computed portfolio-level number, for EVERY stored month, in one
// place — meant to be held up against the legacy portal's own screens/screenshots for the same
// month, since this sandbox has no way to log into or read the legacy portal directly. Reads only
// already-stored raw_report data via buildPayloadRange() — no SiteLink calls.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-full-reconciliation.js
import { buildPayloadRange, listStoredMonths } from '../lib/buildPayload.js';

const months = await listStoredMonths();
console.log(`${months.length} stored month(s): ${months.join(', ')}\n`);

for (const mk of months) {
  const [y, m] = mk.split('-').map(Number);
  const p = await buildPayloadRange(new Date(y, m - 1, 1), new Date(y, m - 1, 1));
  const t = p.totals;
  console.log(`\n${'='.repeat(70)}\n${mk}  (${p.sites.length} sites with data)\n${'='.repeat(70)}`);

  console.log('\n-- Occupancy / Rate --');
  console.log(`occ=${t.occ}/${t.tot} (${t.occPC}%)  occA=${t.occA} claA=${t.claA} totA=${t.totA}  areaPC=${t.areaPC}%  claPC=${t.claPC}%`);
  console.log(`rate=£${t.rate}  realRate=£${t.realRate}  ssRate=£${t.ssRate}  ssReal=£${t.ssReal}  rent=£${t.rent}  gpot=£${t.gpot}`);
  console.log(`Self Storage occ: ${t.ssOcc}/${t.ssTot} (${t.ssOccPC}%)   Offices occ: ${t.officesOcc}/${t.officesTot} (${t.officesOccPC}%)  officesRate=£${t.officesRate}`);

  console.log('\n-- Debtor Levels / Past Due --');
  console.log(`debtorTenantPct=${t.debtorTenantPct}%  debtorRentRollPct=${t.debtorRentRollPct}%  debtorTotal=£${t.debtorTotal}`);

  console.log('\n-- Autobill --');
  console.log(`autobillPC (new-customer basis)=${t.autobillPC}%  autobillPC_allTenants=${t.autobillPC_allTenants}%`);

  console.log('\n-- Customer Type --');
  console.log(`Business: ${t.customerType?.business?.units} units (${t.customerType?.business?.pct}%) @ £${t.customerType?.business?.rate}`);
  console.log(`Residential: ${t.customerType?.residential?.units} units (${t.customerType?.residential?.pct}%) @ £${t.customerType?.residential?.rate}`);

  console.log('\n-- Reservations vs Scheduled Move-outs --');
  console.log(`reservationsActive=${t.reservationsActive}  scheduledOuts=${t.scheduledOuts}  net=${t.reservationsNet}`);

  console.log('\n-- Insurance --');
  console.log(`insurancePremium=£${t.insurancePremium}  insurancePctRoll=${t.insurancePctRoll}%  insurancePctInsured=${t.insurancePctInsured}%`);

  console.log('\n-- Merchandise / Move-ins-outs (per-site sums) --');
  const sum = (get) => p.sites.reduce((a, s) => a + (get(s) || 0), 0);
  console.log(`moveIns=${sum((s) => s.moveIns)}  moveOuts=${sum((s) => s.moveOuts)}  netArea=${sum((s) => s.netArea)}`);
  console.log(`merchandise.sales=£${sum((s) => s.merchandise?.sales)}  chargeFromFinancial=£${sum((s) => s.merchandise?.chargeFromFinancial)}`);
  console.log(`insuredNewCustomers.count=${sum((s) => s.insuredNewCustomers?.count)}`);
  console.log(`enquiries.total=${sum((s) => s.enquiries?.total)}  conversions=${sum((s) => s.enquiries?.conversions)}  reservationConversions=${sum((s) => s.enquiries?.reservationConversions)}`);

  console.log('\n-- True Revenue (top 8 by desc / by type) --');
  const descTotal = (t.trueRevenueByDesc || []).reduce((a, r) => a + (r.truePeriod || 0), 0);
  const typeTotal = (t.trueRevenueByType || []).reduce((a, r) => a + (r.truePeriod || 0), 0);
  console.log(`Grand total: byDesc=£${descTotal.toFixed(2)}  byType=£${typeTotal.toFixed(2)}  (${Math.abs(descTotal - typeTotal) < 1 ? 'match OK' : 'MISMATCH'})`);
  for (const r of (t.trueRevenueByDesc || []).slice(0, 8)) console.log(`  ${r.desc}: £${r.truePeriod}`);
  console.log('  by type:');
  for (const r of (t.trueRevenueByType || []).slice(0, 8)) console.log(`  ${r.desc}: £${r.truePeriod}`);
}
process.exit(0);
