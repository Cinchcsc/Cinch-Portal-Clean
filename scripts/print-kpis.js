// Prints every wired KPI/stat-card number, portfolio-wide, in one place — no portal UI needed.
// Reads straight from the last built portal_payload (no SiteLink calls). Mirrors exactly what the
// Dashboard/KPIs/Financials/Ancillaries pages compute (lib/buildPayload.js's totals block), so you
// can eyeball these against the legacy portal / target screenshots without opening the preview.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/print-kpis.js
import { admin } from '../lib/supabaseAdmin.js';

const { data: pr, error } = await admin
  .from('portal_payload').select('payload,generated_at').eq('id', 1)
  .order('generated_at', { ascending: false }).limit(1);
if (error) { console.log('err', error.message); process.exit(1); }
let p = pr?.[0]?.payload; if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }
if (!p?.totals) { console.log('no usable portal_payload row.'); process.exit(0); }

const t = p.totals;
const money = (n) => '£' + Math.round(n || 0).toLocaleString('en-GB');
const pct = (n) => (n ?? 0).toFixed(1) + '%';
const rate = (n) => '£' + (n ?? 0).toFixed(2);

console.log(`generated ${pr[0].generated_at} · current_month ${p.current_month} · prev_month ${p.prev_month} · ${p.sites.length} sites\n`);

console.log('--- Dashboard KPI row ---');
console.log(`Occupancy (% of CLA): ${pct(t.claPC)}`);
console.log(`Occupied Units: ${t.occ} of ${t.tot}`);

console.log('\n--- Rates per ft² (portfolio) ---');
console.log(`Total Rate: ${rate(t.rate)}   Real Total Rate: ${rate(t.realRate)}`);
console.log(`Self Storage Rate: ${rate(t.ssRate)}   Self Storage Real Rate: ${rate(t.ssReal)}`);
console.log(`Offices Rate: ${rate(t.officesRate)}`);

console.log('\n--- Offices / Indoor Self Storage Occupancy ---');
console.log(`Self Storage: ${t.ssOcc} of ${t.ssTot}  (${pct(t.ssOccPC)})`);
console.log(`Offices: ${t.officesOcc} of ${t.officesTot}  (${pct(t.officesOccPC)})`);

// Enquiries + Move-ins/Move-outs are sourced from the PREVIOUS complete month on each site record
// (see lib/buildPayload.js) — sum across sites here the same way the frontend does.
const sum = (k) => p.sites.reduce((a, s) => a + (s[k] || 0), 0);
const esum = (k) => p.sites.reduce((a, s) => a + ((s.enquiries && s.enquiries[k]) || 0), 0);
console.log(`\n--- Enquiries (last complete month, ${p.prev_month}) ---`);
console.log(`Phone: ${esum('phone')}   Walk-ins: ${esum('walkin')}   Web (Web+Email): ${esum('web')}   Total: ${esum('total')}`);

console.log(`\n--- Move-ins & Move-outs (last complete month, ${p.prev_month}) ---`);
console.log(`Move-ins: ${sum('moveIns')}   Move-outs: ${sum('moveOuts')}   Net ft²: ${sum('netArea')}`);

console.log('\n--- Debtor Levels ---');
console.log(`Tenant %: ${pct(t.debtorTenantPct)}   Rent Roll %: ${pct(t.debtorRentRollPct)}   Total overdue: ${money(t.debtorTotal)}`);

console.log('\n--- Autobill ---');
console.log(`Autobill %: ${pct(t.autobillPC)}`);

console.log('\n--- Reservations vs Move-outs ---');
console.log(`Active Reservations: ${t.reservationsActive}   Scheduled Move-outs: ${t.scheduledOuts}   Net: ${t.reservationsNet}`);

console.log('\n--- Insurance Roll ---');
console.log(`Premiums: ${money(t.insurancePremium)}   % Rent Roll: ${pct(t.insurancePctRoll)}   % Insured: ${pct(t.insurancePctInsured)}`);

console.log('\n--- Units by Customer Type ---');
console.log(`Business: ${t.customerType.business.units} units (${pct(t.customerType.business.pct)}) @ ${rate(t.customerType.business.rate)}`);
console.log(`Residential: ${t.customerType.residential.units} units (${pct(t.customerType.residential.pct)}) @ ${rate(t.customerType.residential.rate)}`);

console.log('\n--- Financials (derived) ---');
const avgCustValue = t.occ ? Math.round((t.rent / t.occ) * 100) / 100 : 0;
console.log(`Avg customer value: ${money(avgCustValue)}`);
process.exit(0);
