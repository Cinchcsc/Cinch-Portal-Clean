// PROBE (22 Jul 2026), task #308/#403/#404 — Michael pulled up the LEGACY portal directly
// (portal.cinchstorage.co.uk/financials, Dashboard's "REAL RATE PER FT²" widget) and it shows every
// one of its 25 sites' June 2026 Real Rate (Self Storage + Total), not just Bicester. This is a much
// stronger cross-check than waiting for another month to close: 25 independent site-level data points
// for the SAME already-closed month, read directly off the source with zero ambiguity, instead of
// one site across a few months where historical area data is compromised anyway.
//
// This runs the validated formula -- True Revenue "Rent" TruePeriod minus FinancialSummary's Rent
// Credit (Discounts subtraction CONFIRMED WRONG by probe-realrate-rewind-plus-discounts.js -- worse
// in all 4 months tested), divided by occupied area (rewound from TODAY's live RentRoll via
// MoveInsAndMoveOuts net moves, validated against Bicester's June screenshot: exact unit-count match)
// -- across ALL 25 legacy sites for June 2026, and compares against the real target read straight off
// the legacy Dashboard. If this lands close across most/all 25 sites, that's far stronger proof than
// anything gathered so far. If specific sites fail in a pattern, that's a clue to what's still missing.
//
// Legacy Dashboard June 2026 Real Rate targets (read directly, 22 Jul 2026):
//   Bicester 28.02/26.39, Leighton Buzzard 30.92/31.24, Letchworth 29.55/28.69, Chippenham 29.40/28.85,
//   Brighton 25.31/25.29, Huntingdon 19.07/16.64, Newmarket 20.63/21.49, Enfield 16.86/18.39,
//   Newbury 22.01/21.63, Mitcham 33.03/32.99, Sittingbourne 29.27/28.05, Gillingham 29.54/30.01,
//   Brentwood 19.83/20.40, Earlsfield 26.78/26.65, Watford 20.97/20.02, Seaford 17.84/17.91,
//   Southend 21.88/21.47, Woking 22.17/21.99, Sidcup 27.03/25.79, Dunstable 17.96/16.95,
//   Swindon 17.00/16.34, Wisbech 11.78/11.36, Newcastle 10.95/11.02, Shoreham-By-Sea 10.22/9.68,
//   Exeter 8.12/8.21.  (Bedford/L021, Paulton/L026, Edmonton/L028, Abingdon/L029 aren't in legacy's
//   25-site list at all -- skipped here.)
//
// Run:  node --env-file=.env scripts/probe-realrate-all-sites-june.js
import { callReport, callCustomReport, extractNamedTable } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const str = (v) => String(v ?? '').trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const isSS = (t) => /self.?storage/i.test(String(t || ''));

function allTables(raw) {
  if (!raw) return {};
  let diff = null;
  (function find(node) {
    if (!node || typeof node !== 'object' || diff) return;
    for (const [k, v] of Object.entries(node)) {
      if (diff) return;
      if (/diffgram/i.test(k) && v && typeof v === 'object') { diff = v; return; }
      if (v && typeof v === 'object') find(v);
    }
  })(raw);
  const scope = diff || raw;
  const tables = {};
  const seen = new Set();
  (function walk(node, path) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') tables[`${path}${path ? '.' : ''}${k}`] = v;
      else if (v && typeof v === 'object') walk(v, `${path}${path ? '.' : ''}${k}`);
    }
  })(scope, '');
  return tables;
}
function flattenRow(r) {
  if (r && typeof r === 'object' && r.attributes && typeof r.attributes === 'object') {
    const { attributes, ...rest } = r; return { ...attributes, ...rest };
  }
  return r;
}
function findTable(raw, nameSuffix) {
  const tables = allTables(raw);
  const key = Object.keys(tables).find((k) => k.toLowerCase().endsWith(nameSuffix.toLowerCase()));
  return key ? tables[key].map(flattenRow) : [];
}

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

async function netSince(site, start, end, unitTypeLookup) {
  const { rows } = await callReport('MoveInsAndMoveOuts', site, start, end);
  let netAreaTotal = 0, netAreaSS = 0;
  for (const r of rows) {
    const inFlag = yes(r.MoveIn), outFlag = yes(r.MoveOut);
    if (!inFlag && !outFlag) continue;
    const a = inFlag ? num(r.MovedInArea) : num(r.MovedOutArea);
    const sign = (inFlag ? 1 : 0) - (outFlag ? 1 : 0);
    netAreaTotal += sign * a;
    let typeStr = str(r.sUnitType);
    if (!typeStr) typeStr = unitTypeLookup.get(str(r.sUnitName)) || '';
    if (isSS(typeStr)) netAreaSS += sign * a;
  }
  return { netAreaTotal: R2(netAreaTotal), netAreaSS: R2(netAreaSS) };
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

async function rentCreditFromFinancialSummary(site, start, end) {
  const { raw } = await callReport('FinancialSummary', site, start, end);
  const chargeRows = findTable(raw, '.Charge');
  const rentRow = chargeRows.find((r) => str(r.sChgDesc).toLowerCase() === 'rent' || str(r.sChgCategory).toLowerCase() === 'rent');
  return rentRow ? num(rentRow.Credit) : 0;
}

// code -> [name, targetSS, targetTotal] -- read directly off portal.cinchstorage.co.uk/financials
// Dashboard "REAL RATE PER FT²" widget, 22 Jul 2026, date range Jun 2026.
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
const windowStart = new Date(2026, 5, 30 + 1); // 1 Jul
const juneStart = new Date(2026, 5, 1);

const results = [];
for (const [code, [name, ssTarget, totalTarget]] of Object.entries(SITES)) {
  try {
    const today = await liveOccupiedToday(code);
    const net = await netSince(code, windowStart, now, today.totalStore.unitType);
    const areaTotal = R2(today.totalStore.occArea - net.netAreaTotal);
    const areaSS = R2(today.ss.occArea - net.netAreaSS);
    const rent = await trueRevenueRent(code, juneStart, juneEnd);
    const credit = await rentCreditFromFinancialSummary(code, juneStart, juneEnd);
    const areaWeightSS = areaTotal ? areaSS / areaTotal : 0;
    const effTotal = rent.total - credit, effSS = rent.ss - R2(credit * areaWeightSS);
    const rTotal = areaTotal ? R2(effTotal / areaTotal * 12) : 0;
    const rSS = areaSS ? R2(effSS / areaSS * 12) : 0;
    const gapTotal = R2(rTotal - totalTarget), gapSS = R2(rSS - ssTarget);
    results.push({ code, name, rTotal, totalTarget, gapTotal, rSS, ssTarget, gapSS });
    console.log(`${code} ${name.padEnd(18)} Total: ours=£${rTotal.toFixed(2).padStart(6)} target=£${totalTarget.toFixed(2)} gap=£${gapTotal.toFixed(2).padStart(6)}   SS: ours=£${rSS.toFixed(2).padStart(6)} target=£${ssTarget.toFixed(2)} gap=£${gapSS.toFixed(2).padStart(6)}`);
  } catch (e) {
    console.log(`${code} ${name.padEnd(18)} FAILED: ${e.message}`);
    results.push({ code, name, error: e.message });
  }
}

const ok = results.filter((r) => !r.error);
const within5 = ok.filter((r) => Math.abs(r.gapTotal) < 0.05).length;
const within25 = ok.filter((r) => Math.abs(r.gapTotal) < 0.25).length;
const within50 = ok.filter((r) => Math.abs(r.gapTotal) < 0.50).length;
const avgAbsGap = ok.length ? R2(ok.reduce((s, r) => s + Math.abs(r.gapTotal), 0) / ok.length) : 0;
const avgSignedGap = ok.length ? R2(ok.reduce((s, r) => s + r.gapTotal, 0) / ok.length) : 0;

console.log(`\n${'='.repeat(100)}`);
console.log(`Sites tested: ${ok.length}/${Object.keys(SITES).length} (${results.length - ok.length} failed)`);
console.log(`Total-scope: within 5p: ${within5}/${ok.length}   within 25p: ${within25}/${ok.length}   within 50p: ${within50}/${ok.length}`);
console.log(`Average |gap|: £${avgAbsGap}   Average signed gap: £${avgSignedGap} (${avgSignedGap < 0 ? 'we tend to undershoot' : 'we tend to overshoot'})`);
console.log('='.repeat(100));
process.exit(0);
