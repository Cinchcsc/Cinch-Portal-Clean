// PROBE (22 Jul 2026), task #308/#403/#404/#405 — combines the two fixes just confirmed:
//
//   1. probe-realrate-nocredit-all-sites.js: Newbury hit an EXACT £0.00 gap using Rent alone (no
//      Credit, no Discounts) -- Credit was never supposed to be subtracted from True Revenue Rent.
//   2. probe-transfer-row-shape.js: every Transfer=true row on MoveInsAndMoveOuts, across 4 sites
//      sampled, has MoveIn=false AND MoveOut=false (not "both true" as first suspected), with
//      MovedInArea consistently positive and MovedOutArea consistently 0 -- these are real area
//      additions that the rewind's `if (!inFlag && !outFlag) continue` guard was silently skipping
//      entirely. That under-counts area added since month-end, leaving rewound past-month area too
//      LARGE, which understates Real Rate -- exactly the one-directional undershoot seen everywhere.
//
// Fix applied here: netSince() now ALSO counts any row with Transfer=true (even with both MoveIn/
// MoveOut false) as contributing (MovedInArea - MovedOutArea) to net area since month-end, same as a
// normal MoveIn/MoveOut row would. Re-runs the full 25-site June comparison with BOTH fixes (Rent
// alone + corrected rewind) to see how close this lands across the whole portfolio.
//
// Run:  node --env-file=.env scripts/probe-realrate-fixed-all-sites.js
import { callReport, callCustomReport, extractNamedTable } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const str = (v) => String(v ?? '').trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const isSS = (t) => /self.?storage/i.test(String(t || ''));

function summarize(rows, filterFn) {
  let area = 0, occArea = 0;
  const unitType = new Map();
  for (const r of rows) {
    if (!filterFn(r)) continue;
    const a = num(r.Area ?? r.Area1);
    area += a;
    if (yes(r.bRented)) occArea += a;
    const un = str(r.sUnitName);
    if (un) unitType.set(un, str(r.sTypeName));
  }
  return { area: R2(area), occArea: R2(occArea), unitType };
}

async function liveOccupiedToday(site) {
  const now = new Date();
  const { rows } = await callReport('RentRoll', site, new Date(now.getFullYear(), now.getMonth(), 1), now);
  return { totalStore: summarize(rows, () => true), ss: summarize(rows, (r) => isSS(r.sTypeName)) };
}

// FIXED: rows with Transfer=true now also count, using (MovedInArea - MovedOutArea), instead of being
// silently skipped by the old "!inFlag && !outFlag -> continue" guard.
async function netSinceFixed(site, start, end, unitTypeLookup) {
  const { rows } = await callReport('MoveInsAndMoveOuts', site, start, end);
  let netAreaTotal = 0, netAreaSS = 0;
  let transferRowsCounted = 0;
  for (const r of rows) {
    const inFlag = yes(r.MoveIn), outFlag = yes(r.MoveOut), transferFlag = yes(r.Transfer);
    if (!inFlag && !outFlag && !transferFlag) continue;

    let deltaArea;
    if (inFlag || outFlag) {
      const a = inFlag ? num(r.MovedInArea) : num(r.MovedOutArea);
      const sign = (inFlag ? 1 : 0) - (outFlag ? 1 : 0);
      deltaArea = sign * a;
    } else {
      // Transfer=true but neither flag set -- real area change, previously dropped entirely.
      deltaArea = num(r.MovedInArea) - num(r.MovedOutArea);
      transferRowsCounted++;
    }
    netAreaTotal += deltaArea;

    let typeStr = str(r.sUnitType);
    if (!typeStr) typeStr = unitTypeLookup.get(str(r.sUnitName)) || '';
    if (isSS(typeStr)) netAreaSS += deltaArea;
  }
  return { netAreaTotal: R2(netAreaTotal), netAreaSS: R2(netAreaSS), transferRowsCounted };
}

async function trueRevenueRent(site, start, end) {
  const { raw } = await callCustomReport(781861, site, start, end);
  const rows = extractNamedTable(raw, 'Table1');
  let total = 0, ss = 0;
  for (const r of rows) {
    if (str(r.ChargeDesc).toLowerCase() !== 'rent') continue;
    const v = num(r.TruePeriod);
    total += v; if (isSS(r.UnitType)) ss += v;
  }
  return { total: R2(total), ss: R2(ss) };
}

const SITES = {
  L001: ['Bicester', 28.02, 26.39], L002: ['Leighton Buzzard', 30.92, 31.24], L003: ['Letchworth', 29.55, 28.69],
  L004: ['Chippenham', 29.40, 28.85], L005: ['Brighton', 25.31, 25.29], L006: ['Huntingdon', 19.07, 16.64],
  L007: ['Newmarket', 20.63, 21.49], L008: ['Enfield', 16.86, 18.39], L009: ['Newbury', 22.01, 21.63],
  L010: ['Mitcham', 33.03, 32.99], L011: ['Sittingbourne', 29.27, 28.05], L012: ['Gillingham', 29.54, 30.01],
  L013: ['Brentwood', 19.83, 20.40], L014: ['Earlsfield', 26.78, 26.65], L015: ['Watford', 20.97, 20.02],
  L016: ['Seaford', 17.84, 17.91], L017: ['Southend', 21.88, 21.47], L018: ['Woking', 22.17, 21.99],
  L019: ['Sidcup', 27.03, 25.79], L020: ['Dunstable', 17.96, 16.95], L022: ['Swindon', 17.00, 16.34],
  L023: ['Wisbech', 11.78, 11.36], L024: ['Newcastle', 10.95, 11.02], L025: ['Shoreham-By-Sea', 10.22, 9.68],
  L027: ['Exeter', 8.12, 8.21],
};

const now = new Date();
const juneEnd = new Date(2026, 5, 30);
const windowStart = new Date(2026, 5, 30 + 1);
const juneStart = new Date(2026, 5, 1);

const results = [];
for (const [code, [name, ssTarget, totalTarget]] of Object.entries(SITES)) {
  try {
    const today = await liveOccupiedToday(code);
    const net = await netSinceFixed(code, windowStart, now, today.totalStore.unitType);
    const areaTotal = R2(today.totalStore.occArea - net.netAreaTotal);
    const areaSS = R2(today.ss.occArea - net.netAreaSS);
    const rent = await trueRevenueRent(code, juneStart, juneEnd);

    const rTotal = areaTotal ? R2(rent.total / areaTotal * 12) : 0;
    const rSS = areaSS ? R2(rent.ss / areaSS * 12) : 0;
    const gapTotal = R2(rTotal - totalTarget), gapSS = R2(rSS - ssTarget);

    results.push({ code, name, gapTotal, gapSS });
    console.log(`${code} ${name.padEnd(18)} transferRowsFixed=${net.transferRowsCounted}   Total: ours=£${rTotal.toFixed(2).padStart(6)} target=£${totalTarget.toFixed(2)} gap=£${gapTotal.toFixed(2).padStart(6)}   SS: ours=£${rSS.toFixed(2).padStart(6)} target=£${ssTarget.toFixed(2)} gap=£${gapSS.toFixed(2).padStart(6)}`);
  } catch (e) {
    console.log(`${code} ${name.padEnd(18)} FAILED: ${e.message}`);
  }
}

const within1 = results.filter((r) => Math.abs(r.gapTotal) < 0.01).length;
const within5 = results.filter((r) => Math.abs(r.gapTotal) < 0.05).length;
const within25 = results.filter((r) => Math.abs(r.gapTotal) < 0.25).length;
const avgAbs = R2(results.reduce((s, r) => s + Math.abs(r.gapTotal), 0) / results.length);
const avgSigned = R2(results.reduce((s, r) => s + r.gapTotal, 0) / results.length);

console.log(`\n${'='.repeat(100)}`);
console.log(`Sites tested: ${results.length}/${Object.keys(SITES).length}`);
console.log(`Total-scope: within 1p: ${within1}/${results.length}   within 5p: ${within5}/${results.length}   within 25p: ${within25}/${results.length}`);
console.log(`Average |gap|: £${avgAbs}   Average signed gap: £${avgSigned}`);
console.log('='.repeat(100));
process.exit(0);
