// PROBE (24 Jul 2026), task #308/#404 — next step after today's basis-gap work. Established so far:
//   - True Revenue "Rent" TruePeriod ALONE ÷ occupied area × 12 (V2a) is the best candidate tested
//     across all 25 sites: avg gap £0.78, 18/25 within £1 (probe-realrate-rentroll-vs-truerevenue-basis.js).
//   - Subtracting Credit or Discounts from EITHER basis makes things worse, no exceptions, confirmed
//     on 25/25 sites (probe-realrate-truerevenue-minus-discounts-only.js) — that whole line of
//     hypotheses is now closed.
//   - 7 sites still miss by >£1: Chippenham, Swindon, Exeter, Sidcup, Brighton, Sittingbourne, Enfield.
//
// Everything tested so far used the FROZEN June rent_roll snapshot's own occupied-area (Σ Area where
// bRented) as the denominator for BOTH variants — never questioned, just held constant so the
// numerator comparison was clean. But task #404 (still open) flagged a real reason to doubt that
// frozen figure specifically: probe-check-frozen-history-coverage.js found EVERY historical rent_roll/
// occupancy snapshot before ~22 Jul was captured via a single bulk backfill, not at each month's true
// close — so the "frozen June 30" snapshot doesn't actually reflect June 30's real state, it reflects
// whatever the account looked like on the day of that backfill. probe-realrate-rewind-occupied-area.js
// (22 Jul, recovered from git history) validated a fix for exactly this, for Bicester alone: rewind
// TODAY's live (trustworthy) occupied units/area back to any past month-end using MoveInsAndMoveOuts'
// real, dated net-move events — occupied(monthEnd) = occupied(today) − netMoves(monthEnd, today] — and
// confirmed it landed EXACTLY on Michael's June screenshot (314/348), where the frozen snapshot itself
// was off by 3 units (317/348). That validated method has never been applied across all 25 sites, or
// combined with today's best formula candidate (V2a) — this does both, to see whether the frozen
// snapshot's area error is what's actually driving the 7-site residual gap.
//
// For each site: computes the rewound June 30 occupied area (TODAY's live RentRoll minus net moves
// since 1 Jul, via MoveInsAndMoveOuts), compares it directly against the frozen snapshot's own area
// (how far apart are they, per site?), then recomputes V2a's Rate with BOTH denominators side by side
// so any improvement at the known outlier sites is directly visible.
//
// Run:  node --env-file=.env scripts/probe-realrate-rewound-area-all-sites.js
import { callReport, callCustomReport, extractNamedTable, extractRows } from '../lib/sitelink.js';
import { admin } from '../lib/supabaseAdmin.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const str = (v) => String(v ?? '').trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());

const JUNE_KEY = '2026-06-01';
const juneStart = new Date(2026, 5, 1), juneEnd = new Date(2026, 5, 30);
const julyStart = new Date(2026, 6, 1); // day after June 30 -- start of the rewind window
const now = new Date();

// --- Frozen June rent_roll (Supabase) -- the denominator every prior probe today has used ---
async function frozenJuneOccArea(site) {
  const { data, error } = await admin.from('raw_report').select('raw_response')
    .eq('site_code', site).eq('month', JUNE_KEY).eq('report', 'rent_roll').limit(1);
  if (error || !data?.length || !data[0].raw_response) return null;
  let raw = data[0].raw_response;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return null; } }
  const rows = extractRows(raw);
  let occArea = 0, occUnits = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!yes(r.bRented)) continue;
    occArea += num(r.Area ?? r.Area1); occUnits++;
  }
  return { occArea: R2(occArea), occUnits };
}

// --- TODAY's live occupied units/area (trustworthy -- current month, not a stale snapshot) ---
async function liveOccupiedToday(site) {
  const { rows } = await callReport('RentRoll', site, new Date(now.getFullYear(), now.getMonth(), 1), now);
  let occArea = 0, occUnits = 0;
  for (const r of rows) { if (!yes(r.bRented)) continue; occArea += num(r.Area ?? r.Area1); occUnits++; }
  return { occArea: R2(occArea), occUnits };
}

// --- Net moved-in-minus-moved-out area/units from julyStart through today (Total store only --
// same field names probe-realrate-rewind-occupied-area.js already established: MoveIn/MoveOut flags,
// MovedInArea/MovedOutArea) ---
async function netMovesSinceJuly1(site) {
  const { rows } = await callReport('MoveInsAndMoveOuts', site, julyStart, now);
  let netUnits = 0, netArea = 0;
  for (const r of rows) {
    const inFlag = yes(r.MoveIn), outFlag = yes(r.MoveOut);
    if (!inFlag && !outFlag) continue;
    const sign = (inFlag ? 1 : 0) - (outFlag ? 1 : 0);
    const a = inFlag ? num(r.MovedInArea) : num(r.MovedOutArea);
    netUnits += sign; netArea += sign * a;
  }
  return { netUnits, netArea: R2(netArea), rowCount: rows.length };
}

async function trueRevenueRent(site) {
  const { raw } = await callCustomReport(781861, site, juneStart, juneEnd);
  const rows = extractNamedTable(raw, 'Table1');
  let total = 0;
  for (const r of rows) { if (str(r.ChargeDesc).toLowerCase() === 'rent') total += num(r.TruePeriod); }
  return R2(total);
}

const SITES = {
  L001: ['Bicester', 26.39], L002: ['Leighton Buzzard', 31.24], L003: ['Letchworth', 28.69],
  L004: ['Chippenham', 28.85], L005: ['Brighton', 25.29], L006: ['Huntingdon', 16.64],
  L007: ['Newmarket', 21.49], L008: ['Enfield', 18.39], L009: ['Newbury', 21.63],
  L010: ['Mitcham', 32.99], L011: ['Sittingbourne', 28.05], L012: ['Gillingham', 30.01],
  L013: ['Brentwood', 20.40], L014: ['Earlsfield', 26.65], L015: ['Watford', 20.02],
  L016: ['Seaford', 17.91], L017: ['Southend', 21.47], L018: ['Woking', 21.99],
  L019: ['Sidcup', 25.79], L020: ['Dunstable', 16.95], L022: ['Swindon', 16.34],
  L023: ['Wisbech', 11.36], L024: ['Newcastle', 11.02], L025: ['Shoreham-By-Sea', 9.68],
  L027: ['Exeter', 8.21],
};
const KNOWN_OUTLIERS = new Set(['L004', 'L022', 'L027', 'L019', 'L005', 'L011', 'L008']);

const results = [];
for (const [code, [name, target]] of Object.entries(SITES)) {
  try {
    const frozen = await frozenJuneOccArea(code);
    if (!frozen || !frozen.occArea) { console.log(`${code} ${name.padEnd(18)} SKIPPED: no frozen June rent_roll`); continue; }
    const today = await liveOccupiedToday(code);
    const net = await netMovesSinceJuly1(code);
    const rewoundArea = R2(today.occArea - net.netArea);
    const rewoundUnits = today.occUnits - net.netUnits;

    const trueRevRent = await trueRevenueRent(code);
    const rateFrozen = frozen.occArea ? R2(trueRevRent / frozen.occArea * 12) : 0;
    const rateRewound = rewoundArea ? R2(trueRevRent / rewoundArea * 12) : 0;
    const gapFrozen = R2(rateFrozen - target), gapRewound = R2(rateRewound - target);
    const flag = KNOWN_OUTLIERS.has(code) ? ' <-- known >£1 miss (frozen area)' : '';

    results.push({ code, name, target, frozen, rewoundArea, rewoundUnits, rateFrozen, rateRewound, gapFrozen, gapRewound });
    console.log(`${code} ${name.padEnd(18)} target=£${target.toFixed(2)}  area frozen=${frozen.occArea}(${frozen.occUnits}u) rewound=${rewoundArea}(${rewoundUnits}u) diff=${R2(rewoundArea - frozen.occArea)}sqft/${rewoundUnits - frozen.occUnits}u  |  Rate frozen=£${rateFrozen.toFixed(2)}(gap ${gapFrozen}) rewound=£${rateRewound.toFixed(2)}(gap ${gapRewound})${flag}`);
  } catch (e) {
    console.log(`${code} ${name.padEnd(18)} FAILED: ${e.message}`);
  }
}

function stats(key) {
  const gaps = results.map((r) => Math.abs(r[key]));
  return { avgAbs: R2(gaps.reduce((a, b) => a + b, 0) / gaps.length), within1: gaps.filter((g) => g < 1).length, n: results.length };
}
console.log(`\n${'='.repeat(110)}`);
const sF = stats('gapFrozen'), sR = stats('gapRewound');
console.log(`Frozen-snapshot area:  avg|gap|=£${sF.avgAbs}  within£1=${sF.within1}/${sF.n}`);
console.log(`Rewound (live-minus-MoveInsAndMoveOuts) area:  avg|gap|=£${sR.avgAbs}  within£1=${sR.within1}/${sR.n}`);
console.log(`\nArea discrepancy (rewound - frozen) at the 7 known outlier sites:`);
for (const r of results) {
  if (KNOWN_OUTLIERS.has(r.code)) {
    console.log(`  ${r.code} ${r.name}: area diff=${R2(r.rewoundArea - r.frozen.occArea)}sqft (${r.rewoundUnits - r.frozen.occUnits} units)  gap frozen=${r.gapFrozen} -> gap rewound=${r.gapRewound}`);
  }
}
console.log('='.repeat(110));
process.exit(0);
