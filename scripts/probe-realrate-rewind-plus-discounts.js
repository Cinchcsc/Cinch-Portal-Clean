// PROBE (22 Jul 2026), task #308/#403/#404 — follow-up to probe-realrate-rewind-occupied-area.js's
// result: rewinding today's live occupied units via MoveInsAndMoveOuts reproduced June's screenshot
// EXACTLY on Total Store (314/348, was 317/348 on the stale snapshot) -- the rewind method itself is
// validated. But even with this corrected area, June/May/April Real Rate (True Revenue Rent minus
// FinancialSummary Credit only, no Discounts) still missed by 48-103p -- meaningfully worse than
// July's 4p/1p. Two loose ends from that run, both addressed here:
//
//   1. SS occupied units were off by 1 for June (277 vs true 276) despite Total matching exactly --
//      diagnosed by printing every distinct sUnitType value seen on MoveInsAndMoveOuts rows in the
//      rewind window, to check whether its type strings/categories actually line up with RentRoll's
//      sTypeName convention that isSS() was written against.
//   2. Discounts (ManagementSummary's own table, Expiring bucket only via its native bNeverExpires
//      flag -- confirmed earlier this task: Expiring MAmt=£2,353.04 for July, matching an independent
//      ad-hoc figure) has NEVER been tested in combination with the Credit subtraction -- only Credit
//      alone was tested. This runs BOTH variants side by side (Credit-only vs Credit+Discounts) for
//      July/June/May/April, using the validated rewound area, to see which is actually closer.
//
// Run:  node --env-file=.env scripts/probe-realrate-rewind-plus-discounts.js [siteCode]
import { callReport, callCustomReport, extractNamedTable } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-realrate-rewind-plus-discounts.js <siteCode>'); process.exit(1); }

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
  let total = 0, occupied = 0, area = 0, occArea = 0;
  const unitType = new Map();
  for (const r of rows) {
    if (!filterFn(r)) continue;
    total++;
    const a = num(r.Area ?? r.Area1);
    area += a;
    if (yes(r.bRented)) { occupied++; occArea += a; }
    const un = str(r.sUnitName);
    if (un) unitType.set(un, str(r.sTypeName));
  }
  return { total, occupied, area: R2(area), occArea: R2(occArea), unitType };
}

async function liveOccupiedToday() {
  const now = new Date();
  const { rows } = await callReport('RentRoll', site, new Date(now.getFullYear(), now.getMonth(), 1), now);
  return { totalStore: summarize(rows, () => true), ss: summarize(rows, (r) => isSS(r.sTypeName)) };
}

// Diagnostic: every distinct sUnitType value seen on MoveInsAndMoveOuts rows in a window, and whether
// isSS() (written against RentRoll's sTypeName convention) actually classifies each one as expected.
async function dumpDistinctUnitTypes(start, end, label) {
  const { rows } = await callReport('MoveInsAndMoveOuts', site, start, end);
  const seen = new Map(); // sUnitType -> count
  for (const r of rows) {
    if (!yes(r.MoveIn) && !yes(r.MoveOut)) continue;
    const t = str(r.sUnitType) || '(blank)';
    seen.set(t, (seen.get(t) || 0) + 1);
  }
  console.log(`  [${label}] distinct sUnitType values on move events: ` +
    [...seen.entries()].map(([t, c]) => `"${t}"(${c}, isSS=${isSS(t)})`).join(', '));
}

async function netSince(start, end, unitTypeLookup) {
  const { rows } = await callReport('MoveInsAndMoveOuts', site, start, end);
  let netUnitsTotal = 0, netAreaTotal = 0, netUnitsSS = 0, netAreaSS = 0;
  for (const r of rows) {
    const inFlag = yes(r.MoveIn), outFlag = yes(r.MoveOut);
    if (!inFlag && !outFlag) continue;
    const a = inFlag ? num(r.MovedInArea) : num(r.MovedOutArea);
    const sign = (inFlag ? 1 : 0) - (outFlag ? 1 : 0);
    netUnitsTotal += sign; netAreaTotal += sign * a;
    let typeStr = str(r.sUnitType);
    if (!typeStr) {
      const un = str(r.sUnitName);
      typeStr = unitTypeLookup.get(un) || '';
    }
    if (isSS(typeStr)) { netUnitsSS += sign; netAreaSS += sign * a; }
  }
  return { netUnitsTotal, netAreaTotal: R2(netAreaTotal), netUnitsSS, netAreaSS: R2(netAreaSS) };
}

async function trueRevenueRent(start, end) {
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

async function rentCreditFromFinancialSummary(start, end) {
  const { raw } = await callReport('FinancialSummary', site, start, end);
  const chargeRows = findTable(raw, '.Charge');
  const rentRow = chargeRows.find((r) => str(r.sChgDesc).toLowerCase() === 'rent' || str(r.sChgCategory).toLowerCase() === 'rent');
  return rentRow ? num(rentRow.Credit) : 0;
}

// ManagementSummary's own "Discounts" table -- confirmed earlier this task: 2 rows per period
// (sCatName "Rent (Expiring)"/"Rent (Non-Expiring)"), DAmt/MAmt/YAmt, native bNeverExpires flag.
// R6's rule: exclude Non-Expiring. Returns the Expiring bucket's MAmt (monthly amount).
async function discountsExpiring(start, end) {
  const { raw } = await callReport('ManagementSummary', site, start, end);
  const discRows = findTable(raw, '.Discounts');
  if (!discRows.length) { console.log('  No Discounts table found in ManagementSummary for this window.'); return 0; }
  let expiringTotal = 0;
  for (const r of discRows) {
    console.log(`  ManagementSummary Discounts row: sCatName="${r.sCatName}" bNeverExpires=${r.bNeverExpires} DAmt=${r.DAmt} MAmt=${r.MAmt} YAmt=${r.YAmt}`);
    if (!yes(r.bNeverExpires)) expiringTotal += num(r.MAmt);
  }
  return expiringTotal;
}

const now = new Date();
const targets = {
  July:  { end: now, ssTarget: 19.50, totalTarget: 18.66 },
  June:  { end: new Date(2026, 5, 30), ssTarget: 28.02, totalTarget: 26.39 },
  May:   { end: new Date(2026, 4, 31), ssTarget: 27.53, totalTarget: 26.48 },
  April: { end: new Date(2026, 3, 30), ssTarget: 28.34, totalTarget: 27.07 },
};

console.log(`${'='.repeat(74)}\nSTEP 1: today's live occupied baseline\n${'='.repeat(74)}`);
const today = await liveOccupiedToday();
console.log(`Today Total Store occupied=${today.totalStore.occupied}/${today.totalStore.total} occArea=${today.totalStore.occArea}`);
console.log(`Today Indoor Self Storage occupied=${today.ss.occupied}/${today.ss.total} occArea=${today.ss.occArea}`);

console.log(`\n${'='.repeat(74)}\nSTEP 2: diagnose SS classification (why June rewind SS was 277 vs true 276)\n${'='.repeat(74)}`);
for (const [name, t] of Object.entries(targets)) {
  if (name === 'July') continue;
  const windowStart = new Date(t.end.getFullYear(), t.end.getMonth(), t.end.getDate() + 1);
  await dumpDistinctUnitTypes(windowStart, now, name);
}

console.log(`\n${'='.repeat(74)}\nSTEP 3: Credit-only vs Credit+Discounts, using validated rewound area\n${'='.repeat(74)}`);
for (const [name, t] of Object.entries(targets)) {
  console.log(`\n--- ${name} 2026 (target Total £${t.totalTarget}, SS £${t.ssTarget}) ---`);
  const windowStart = new Date(t.end.getFullYear(), t.end.getMonth(), t.end.getDate() + 1);
  const net = name === 'July' ? { netUnitsTotal: 0, netAreaTotal: 0, netUnitsSS: 0, netAreaSS: 0 } : await netSince(windowStart, now, today.totalStore.unitType);
  const areaTotal = R2(today.totalStore.occArea - net.netAreaTotal);
  const areaSS = R2(today.ss.occArea - net.netAreaSS);
  console.log(`Occupied area used: Total=${areaTotal} SS=${areaSS}`);

  const mStart = new Date(t.end.getFullYear(), t.end.getMonth(), 1);
  const rent = await trueRevenueRent(mStart, t.end);
  const credit = await rentCreditFromFinancialSummary(mStart, t.end);
  console.log(`True Revenue Rent: Total=£${rent.total} SS=£${rent.ss}   FinancialSummary Credit: £${R2(credit)}`);
  const discount = await discountsExpiring(mStart, t.end);
  console.log(`ManagementSummary Discounts (Expiring only): £${R2(discount)}`);

  const areaWeightSS = areaTotal ? areaSS / areaTotal : 0;

  // Variant A: Credit only (the July-validated formula)
  const effTotalA = rent.total - credit, effSSA = rent.ss - R2(credit * areaWeightSS);
  const rTotalA = areaTotal ? R2(effTotalA / areaTotal * 12) : 0;
  const rSSA = areaSS ? R2(effSSA / areaSS * 12) : 0;
  console.log(`[A] Credit only:        Total=£${rTotalA} (gap £${R2(rTotalA - t.totalTarget)})   SS=£${rSSA} (gap £${R2(rSSA - t.ssTarget)})`);

  // Variant B: Credit + Discounts (both subtracted)
  const effTotalB = rent.total - credit - discount, effSSB = rent.ss - R2((credit + discount) * areaWeightSS);
  const rTotalB = areaTotal ? R2(effTotalB / areaTotal * 12) : 0;
  const rSSB = areaSS ? R2(effSSB / areaSS * 12) : 0;
  console.log(`[B] Credit + Discounts: Total=£${rTotalB} (gap £${R2(rTotalB - t.totalTarget)})   SS=£${rSSB} (gap £${R2(rSSB - t.ssTarget)})`);

  const better = Math.abs(rTotalB - t.totalTarget) < Math.abs(rTotalA - t.totalTarget) ? 'B (Credit+Discounts) is closer' : 'A (Credit only) is closer';
  console.log(`  -> ${better} on Total.`);
}

console.log(`\n${'='.repeat(74)}\nCompare gaps across all 4 months for whichever variant wins consistently --\nthat's the real formula. If neither variant is consistently within 5p across\nall 4 months, there's still something else missing.\n${'='.repeat(74)}`);
process.exit(0);
