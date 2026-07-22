// PROBE (22 Jul 2026), task #308/#403/#404/#405 — the bad-debt-exclusion hypothesis is dead:
// BadDebtWrittenOff and BadDebts both returned 0 rows for Bicester/June, and FinancialSummary's own
// Charge table (63 rows) has no bad-debt/write-off line at all. That doesn't explain a systematic,
// always-negative, every-single-site undershoot.
//
// Simpler hypothesis, not yet cleanly isolated: what if FinancialSummary's "Credit" column just
// shouldn't be subtracted from True Revenue Rent AT ALL? Subtracting ANY positive number can only ever
// push our figure DOWN -- which is exactly the one-directional bias seen across all 25 sites. This
// re-runs all 25 sites and prints Rent, Credit, and Area alongside BOTH variants side by side:
//   (A) Rent - Credit  (current formula, avg gap -£0.89 on Total)
//   (B) Rent alone, no Credit subtraction at all
// If (B)'s gaps are consistently smaller AND/OR the ratio (target/ours) is flatter across sites than
// (A)'s, that's strong evidence Credit was never supposed to be subtracted here -- True Revenue's
// TruePeriod may already net out concessions/credits internally (as flagged as a possibility very
// early in this task), and subtracting FinancialSummary's Credit on top double-counts the reduction.
//
// Run:  node --env-file=.env scripts/probe-realrate-nocredit-all-sites.js
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
  return { totalStore: summarize(rows, () => true) };
}

async function netSince(site, start, end) {
  const { rows } = await callReport('MoveInsAndMoveOuts', site, start, end);
  let netAreaTotal = 0;
  for (const r of rows) {
    const inFlag = yes(r.MoveIn), outFlag = yes(r.MoveOut);
    if (!inFlag && !outFlag) continue;
    const a = inFlag ? num(r.MovedInArea) : num(r.MovedOutArea);
    const sign = (inFlag ? 1 : 0) - (outFlag ? 1 : 0);
    netAreaTotal += sign * a;
  }
  return R2(netAreaTotal);
}

async function trueRevenueRent(site, start, end) {
  const { raw } = await callCustomReport(781861, site, start, end);
  const rows = extractNamedTable(raw, 'Table1');
  let total = 0;
  for (const r of rows) {
    if (str(r.ChargeDesc).toLowerCase() !== 'rent') continue;
    total += num(r.TruePeriod);
  }
  return R2(total);
}

async function rentCreditFromFinancialSummary(site, start, end) {
  const { raw } = await callReport('FinancialSummary', site, start, end);
  const chargeRows = findTable(raw, '.Charge');
  const rentRow = chargeRows.find((r) => str(r.sChgDesc).toLowerCase() === 'rent' || str(r.sChgCategory).toLowerCase() === 'rent');
  return rentRow ? num(rentRow.Credit) : 0;
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

const now = new Date();
const juneEnd = new Date(2026, 5, 30);
const windowStart = new Date(2026, 5, 30 + 1);
const juneStart = new Date(2026, 5, 1);

const results = [];
for (const [code, [name, totalTarget]] of Object.entries(SITES)) {
  try {
    const today = await liveOccupiedToday(code);
    const netAreaTotal = await netSince(code, windowStart, now);
    const areaTotal = R2(today.totalStore.occArea - netAreaTotal);
    const rent = await trueRevenueRent(code, juneStart, juneEnd);
    const credit = await rentCreditFromFinancialSummary(code, juneStart, juneEnd);

    const rA = areaTotal ? R2((rent - credit) / areaTotal * 12) : 0;   // (A) Rent - Credit
    const rB = areaTotal ? R2(rent / areaTotal * 12) : 0;              // (B) Rent alone
    const gapA = R2(rA - totalTarget), gapB = R2(rB - totalTarget);
    const ratioA = rA ? R2(totalTarget / rA) : 0, ratioB = rB ? R2(totalTarget / rB) : 0;

    results.push({ code, name, rent, credit, areaTotal, totalTarget, rA, gapA, ratioA, rB, gapB, ratioB });
    console.log(`${code} ${name.padEnd(18)} Rent=£${rent.toFixed(2).padStart(9)} Credit=£${credit.toFixed(2).padStart(8)} Area=${areaTotal.toFixed(0).padStart(6)}   (A)Rent-Credit=£${rA.toFixed(2).padStart(6)} gap=£${gapA.toFixed(2).padStart(6)} ratio=${ratioA.toFixed(3)}   (B)RentAlone=£${rB.toFixed(2).padStart(6)} gap=£${gapB.toFixed(2).padStart(6)} ratio=${ratioB.toFixed(3)}`);
  } catch (e) {
    console.log(`${code} ${name.padEnd(18)} FAILED: ${e.message}`);
  }
}

function stats(key, ratioKey) {
  const gaps = results.map((r) => r[key]);
  const ratios = results.map((r) => r[ratioKey]);
  const avgAbs = R2(gaps.reduce((s, g) => s + Math.abs(g), 0) / gaps.length);
  const avgSigned = R2(gaps.reduce((s, g) => s + g, 0) / gaps.length);
  const within5 = gaps.filter((g) => Math.abs(g) < 0.05).length;
  const within25 = gaps.filter((g) => Math.abs(g) < 0.25).length;
  const avgRatio = R2(ratios.reduce((s, r) => s + r, 0) / ratios.length);
  const ratioSpread = R2(Math.max(...ratios) - Math.min(...ratios));
  return { avgAbs, avgSigned, within5, within25, avgRatio, ratioSpread };
}

const statsA = stats('gapA', 'ratioA'), statsB = stats('gapB', 'ratioB');
console.log(`\n${'='.repeat(100)}`);
console.log(`(A) Rent-Credit:  avg|gap|=£${statsA.avgAbs}  avg signed=£${statsA.avgSigned}  within5p=${statsA.within5}/25  within25p=${statsA.within25}/25  avg target/ours ratio=${statsA.avgRatio}  ratio spread=${statsA.ratioSpread}`);
console.log(`(B) Rent alone:   avg|gap|=£${statsB.avgAbs}  avg signed=£${statsB.avgSigned}  within5p=${statsB.within5}/25  within25p=${statsB.within25}/25  avg target/ours ratio=${statsB.avgRatio}  ratio spread=${statsB.ratioSpread}`);
console.log(`\nLower avg|gap|, more within5p/25p, and a TIGHTER ratio spread (closer to a\nflat constant) both point at which variant is closer to the real formula.`);
console.log('='.repeat(100));
process.exit(0);
