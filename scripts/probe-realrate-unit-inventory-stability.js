// PROBE (24 Jul 2026), task #308/#404 follow-up to probe-realrate-rewound-area-all-sites.js and
// probe-enfield-movedetail-july.js.
//
// Enfield (L008) is the one site where the rewound-area denominator made the Rate gap WORSE, not
// better (frozen +1.05 -> rewound -1.10), while 6/7 other known outliers were fixed cleanly. The
// per-row move dump ruled out a move-counting bug: net moves since 1 Jul are a genuine, mundane +62
// sqft (26 move-ins/2,360sqft vs 23 move-outs/2,298sqft, hand-verified). Since rewoundArea =
// today.occArea - netMovesSinceJuly1, and that net figure is confirmed small and correct, the ~1,729
// sqft gap between frozen-June and rewound-June must actually be a gap between TODAY's live area and
// frozen-June's recorded area that predates 1 Jul entirely -- i.e. it happened in June or earlier,
// not because of a computation bug.
//
// Two live explanations for a gap that big, at one site specifically: (a) frozen-June's rent_roll
// snapshot simply understated Enfield's true occupied area by an unusually wide margin (bigger than
// any other site's snapshot error, but still just a snapshot error), or (b) the PROPERTY'S OWN TOTAL
// UNIT INVENTORY changed between whenever frozen-June was captured and today -- a renovation bringing
// new units online, a reconfiguration merging/splitting units, or units added/removed from the roll
// entirely. The rewind formula (occupied(monthEnd) = occupied(today) - netMoves) implicitly assumes
// the unit inventory itself is stable and only OCCUPANCY (tenanted vs vacant) is changing -- it has no
// way to see a change in the total number/size of units that exist at all, since MoveInsAndMoveOuts
// only records tenancy events, not unit-roster changes.
//
// This checks (b) directly and portfolio-wide: for every site, compares frozen-June's TOTAL unit
// count/area (ALL rows, occupied AND vacant -- i.e. the property's whole roll, not just bRented rows)
// against TODAY's live TOTAL unit count/area. If Enfield's total inventory shifted meaningfully more
// than everyone else's, that points at (b); if it's stable like every other site, that leaves (a) --
// a plain, if unusually large, snapshot error -- as the remaining explanation.
//
// Run:  node --env-file=.env scripts/probe-realrate-unit-inventory-stability.js
import { callReport, extractRows } from '../lib/sitelink.js';
import { admin } from '../lib/supabaseAdmin.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };

const JUNE_KEY = '2026-06-01';
const now = new Date();

async function frozenJuneTotalInventory(site) {
  const { data, error } = await admin.from('raw_report').select('raw_response')
    .eq('site_code', site).eq('month', JUNE_KEY).eq('report', 'rent_roll').limit(1);
  if (error || !data?.length || !data[0].raw_response) return null;
  let raw = data[0].raw_response;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return null; } }
  const rows = extractRows(raw);
  let area = 0, units = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) { area += num(r.Area ?? r.Area1); units++; }
  return { area: R2(area), units };
}

async function todayTotalInventory(site) {
  const { rows } = await callReport('RentRoll', site, new Date(now.getFullYear(), now.getMonth(), 1), now);
  let area = 0, units = 0;
  for (const r of rows) { area += num(r.Area ?? r.Area1); units++; }
  return { area: R2(area), units };
}

const SITES = {
  L001: 'Bicester', L002: 'Leighton Buzzard', L003: 'Letchworth', L004: 'Chippenham', L005: 'Brighton',
  L006: 'Huntingdon', L007: 'Newmarket', L008: 'Enfield', L009: 'Newbury', L010: 'Mitcham',
  L011: 'Sittingbourne', L012: 'Gillingham', L013: 'Brentwood', L014: 'Earlsfield', L015: 'Watford',
  L016: 'Seaford', L017: 'Southend', L018: 'Woking', L019: 'Sidcup', L020: 'Dunstable',
  L022: 'Swindon', L023: 'Wisbech', L024: 'Newcastle', L025: 'Shoreham-By-Sea', L027: 'Exeter',
};

const results = [];
for (const [code, name] of Object.entries(SITES)) {
  try {
    const frozen = await frozenJuneTotalInventory(code);
    if (!frozen) { console.log(`${code} ${name.padEnd(18)} SKIPPED: no frozen June rent_roll`); continue; }
    const today = await todayTotalInventory(code);
    const areaDiff = R2(today.area - frozen.area);
    const unitDiff = today.units - frozen.units;
    const areaPct = frozen.area ? R2(areaDiff / frozen.area * 100) : 0;
    results.push({ code, name, frozen, today, areaDiff, unitDiff, areaPct });
    const flag = Math.abs(areaPct) > 2 ? '  <-- inventory shift >2%' : '';
    console.log(`${code} ${name.padEnd(18)} frozen TOTAL=${frozen.area}sqft(${frozen.units}u)  today TOTAL=${today.area}sqft(${today.units}u)  diff=${areaDiff}sqft/${unitDiff}u (${areaPct}%)${flag}`);
  } catch (e) {
    console.log(`${code} ${name.padEnd(18)} FAILED: ${e.message}`);
  }
}

console.log(`\n${'='.repeat(110)}`);
const avgAbsPct = R2(results.reduce((a, r) => a + Math.abs(r.areaPct), 0) / results.length);
console.log(`Portfolio: ${results.length} sites, avg|total-inventory shift|=${avgAbsPct}%`);
const sorted = [...results].sort((a, b) => Math.abs(b.areaPct) - Math.abs(a.areaPct));
console.log(`\nRanked by |inventory shift| (largest first) -- Enfield's rank here is the key read:`);
sorted.forEach((r, i) => console.log(`  ${i + 1}. ${r.code} ${r.name.padEnd(18)} ${r.areaPct}%  (${r.areaDiff}sqft / ${r.unitDiff}u)`));
console.log('='.repeat(110));
process.exit(0);
