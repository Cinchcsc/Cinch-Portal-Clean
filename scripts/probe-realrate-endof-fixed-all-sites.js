// PROBE (23 Jul 2026), task #308/#403/#404/#405/#407 — probe-monthend-exclusive-bug.js confirmed
// pull.js's endOf() silently drops the LAST DAY of the target month for InquiryTracking and
// FinancialSummary; probe-truerevenue-monthend-bug.js just confirmed the SAME ~3.4% miss for True
// Revenue Rent TruePeriod specifically (£50,280.38 -> £51,988.63 for L001/June, using the corrected
// end bound) -- independently landing on almost the exact same percentage as FinancialSummary's Rent
// Charge (3.4%) on a structurally different report engine. That's not a coincidence: it's the same
// mechanism, twice.
//
// probe-realrate-fixed-all-sites.js (yesterday's best result: Rent-alone + Transfer-row area fix) used
// juneEnd = new Date(2026,5,30) for the True Revenue call -- the exact buggy bound. If that's why only
// 3/25 sites landed within 5p and 13/25 within 25p (avg |gap| £0.28, with 5 sites at 50-72p), fixing
// JUST the True Revenue end bound (juneEnd -> July 1) -- nothing else changed, same area-rewind, same
// 25 sites, same targets -- should shrink or close most of that gap.
//
// Run:  node --env-file=.env scripts/probe-realrate-endof-fixed-all-sites.js
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

// UNCHANGED from probe-realrate-fixed-all-sites.js — MoveInsAndMoveOuts confirmed NOT affected by the
// endOf() bug (probe-monthend-exclusive-bug.js: identical row/aggregate counts, current vs fixed end
// bound, for L001/June), so the area side of the rewind needs no change.
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
// ONLY CHANGE vs probe-realrate-fixed-all-sites.js: juneEnd moved to the start of the NEXT month, so
// the True Revenue call stops silently excluding June 30.
const juneEnd = new Date(2026, 6, 1);
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
console.log(`\nCompare against yesterday's probe:realrate-fixed-all-sites result (avg |gap| £0.28,\nwithin 5p: 3/25, within 25p: 13/25) to see how much of the remaining gap this\nendOf()-bug fix alone closes.`);
process.exit(0);
