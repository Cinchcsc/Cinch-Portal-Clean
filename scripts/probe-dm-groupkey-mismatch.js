// Diagnostic for Michael's report (14 Jul 2026): the new District Manager page's "Watchdog -
// Discounted Units in Fully Occupied Groups" stat card shows 0 and its table says "no discounted
// units found ... this month" for EVERY site — suspicious given his own live Qstrom DM account
// screenshots show this kind of watchdog widget actually populated in practice.
//
// The widget joins two DIFFERENT SiteLink reports per site: RentRoll (lib/reportMap.js's rent_roll
// parser, producing unit_rows[] with groupKey = `${sTypeName}|${round(Area)}`) and RentalActivity
// (rental_activity parser, producing by_type_size[] with the SAME shape of key built in
// app/portal-v2/page.js: `${row.type}|${Math.round(row.area)}`, where row.type comes from
// RentalActivity's OWN `Type` field). rent_roll's isSS() helper already has a standing comment noting
// RentRoll's sTypeName can read "Indoor Self Storage" rather than a bare "Self Storage" — if
// RentalActivity's Type field uses different wording for the same logical unit type, EVERY groupKey
// join fails silently (Array.filter just returns []), matching Michael's all-zero symptom exactly.
// This script reads whatever's already in portal_payload (no new SiteLink calls) and shows, per site:
//   - the distinct `type` strings RentRoll uses vs the distinct `type` strings RentalActivity uses
//   - how many of RentRoll's per-unit groupKeys actually find a match in RentalActivity's groups
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-dm-groupkey-mismatch.js [siteCode]
import { admin } from '../lib/supabaseAdmin.js';

const wantSite = process.argv[2];

const { data: pr, error } = await admin
  .from('portal_payload').select('payload,generated_at')
  .eq('id', 1).order('generated_at', { ascending: false }).limit(1);
if (error) { console.error('portal_payload read error:', error.message); process.exit(1); }
let p = pr?.[0]?.payload; if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }
if (!p?.sites?.length) { console.error('portal_payload has no usable sites[] — run npm run pull / npm run check first.'); process.exit(1); }

console.log(`portal_payload generated ${pr[0].generated_at} — ${p.current_month || '(no current_month field)'}\n`);

let sites = p.sites;
if (wantSite) sites = sites.filter((s) => s.code === wantSite || s.name === wantSite);
if (!sites.length) { console.error(`No site matched "${wantSite}".`); process.exit(1); }

let totalUnitRows = 0, totalGroups = 0, totalMatched = 0;
for (const s of sites) {
  const unitRows = s.unitRows || [];
  const groups = s.rentalActivityByTypeSize || [];
  if (!unitRows.length && !groups.length) continue; // this site has neither array on this record — skip quietly

  const rrTypes = [...new Set(unitRows.map((u) => u.type))].sort();
  const raTypes = [...new Set(groups.map((g) => g.type))].sort();
  const groupKeySet = new Set(groups.map((g) => `${g.type}|${Math.round(g.area)}`));
  const matched = unitRows.filter((u) => groupKeySet.has(u.groupKey));
  totalUnitRows += unitRows.length; totalGroups += groups.length; totalMatched += matched.length;

  const typesDiffer = JSON.stringify(rrTypes) !== JSON.stringify(raTypes);
  console.log(`${(s.name || s.code).padEnd(20)} unit_rows=${String(unitRows.length).padStart(4)}  groups=${String(groups.length).padStart(3)}  matched=${String(matched.length).padStart(4)}${typesDiffer ? '  <-- TYPE STRINGS DIFFER' : ''}`);
  if (typesDiffer || wantSite) {
    console.log(`    RentRoll (sTypeName) types:      ${JSON.stringify(rrTypes)}`);
    console.log(`    RentalActivity (Type) types:     ${JSON.stringify(raTypes)}`);
    if (wantSite) {
      // Extra detail when probing a single site: show a couple of raw groupKeys side by side.
      console.log(`    Sample RentRoll groupKeys:       ${JSON.stringify(unitRows.slice(0, 5).map((u) => u.groupKey))}`);
      console.log(`    Sample RentalActivity groupKeys: ${JSON.stringify(groups.slice(0, 5).map((g) => `${g.type}|${Math.round(g.area)}`))}`);
    }
  }
}

console.log(`\nTotals across ${sites.length} site(s): ${totalUnitRows} unit_rows, ${totalGroups} groups, ${totalMatched} matched (${totalUnitRows ? (totalMatched / totalUnitRows * 100).toFixed(1) : 0}% of unit_rows found their group).`);
if (totalUnitRows && !totalMatched) console.log('\n=> 0% match confirms the groupKey join is broken — almost certainly the Type-string mismatch flagged above, not a genuine "no discounts" finding.');
process.exit(0);
