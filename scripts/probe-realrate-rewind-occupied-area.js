// PROBE (22 Jul 2026), task #308/#403/#404 — probe-check-frozen-history-coverage.js confirmed EVERY
// historical rent_roll/occupancy snapshot (2016 through June 2026) was captured via bulk backfill in
// June/July 2026, not at each month's true close — there is no properly-timed point-in-time snapshot
// for ANY past closed month, so Real Rate's near-exact July result (4p Total/1p SS,
// probe-realrate-financialsummary-credit-exact.js) has had zero possible second-month cross-check.
//
// Michael's question: "what do you need to cross check" — this is the concrete answer. RentRoll is
// point-in-time (can only ever answer "as of right now"), but MoveInsAndMoveOuts is NOT — it's a real
// period/transaction report (dated:true in reportMap.js, queried fresh with actual date bounds, one
// row per move-in/move-out EVENT), so it can be queried for any past window right now and returns the
// true historical events, unlike RentRoll/OccupancyStatistics.
//
// This means TODAY's live occupied area/unit-count (trustworthy — today is the current, non-stale
// month) can be "rewound" to any past month-end without needing a snapshot at all:
//   occupied(monthEnd) = occupied(today) - netMovedInArea/Units accumulated in (monthEnd, today]
// where the net figure comes straight from MoveInsAndMoveOuts queried over that exact window.
//
// Acid test: rewind to 30 Jun 2026 and compare against Michael's OWN screenshot (314/348 Total,
// 276/304 Indoor Self Storage, 4/4 Offices) — ground truth independently confirmed correct earlier
// (Rate/ssRate on that screenshot already matched confirmed targets). The stale June rent_roll
// snapshot read 317/348 (3 units wrong). If the rewind instead lands on 314/348 exactly, that proves
// this method is MORE trustworthy than any frozen snapshot, and unlocks genuine cross-checks for May
// and April too (Michael's supplied targets: May SS£27.53/Total£26.48, April SS£28.34/Total£27.07).
//
// Run:  node --env-file=.env scripts/probe-realrate-rewind-occupied-area.js [siteCode]
import { callReport, callCustomReport, extractNamedTable, extractRows } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-realrate-rewind-occupied-area.js <siteCode>'); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const str = (v) => String(v ?? '').trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const isSS = (t) => /self.?storage/i.test(String(t || ''));
const isOffice = (t) => /^office$/i.test(String(t || '').trim());

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

// ---- Step 1: dump MoveInsAndMoveOuts' raw columns so we KNOW what fields exist (unit id? type?) ----
async function dumpMioColumns(start, end) {
  const { raw, rows } = await callReport('MoveInsAndMoveOuts', site, start, end);
  const tables = allTables(raw);
  console.log(`MoveInsAndMoveOuts raw tables found: ${Object.keys(tables).join(', ') || '(none)'}`);
  const allKeys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
  console.log(`MoveInsAndMoveOuts row columns (${rows.length} rows in this window): ${[...allKeys].join(', ')}`);
  const candidates = ['sUnitName', 'UnitName', 'sSpace', 'Space', 'SpaceNumber', 'sTypeName', 'UnitType', 'sUnitType'];
  const present = candidates.filter((c) => allKeys.has(c));
  console.log(`Candidate unit-id/type columns present: ${present.length ? present.join(', ') : '(none of the expected names found)'}`);
  return { rows, unitKey: present.find((c) => /unit|space/i.test(c)) || null, typeKey: present.find((c) => /type/i.test(c)) || null };
}

// ---- Step 2: TODAY's live occupied state (trustworthy — current month, not stale) ----
function summarize(rows, filterFn) {
  let total = 0, occupied = 0, area = 0, occArea = 0;
  const unitType = new Map(); // sUnitName -> sTypeName, for joining against MoveInsAndMoveOuts rows later
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
  const totalStore = summarize(rows, () => true);
  const ss = summarize(rows, (r) => isSS(r.sTypeName));
  const offices = summarize(rows, (r) => isOffice(r.sTypeName));
  return { rows, totalStore, ss, offices };
}

// ---- Step 3: net moved-in-minus-moved-out area/units in a window, split Total/SS if possible ----
async function netSince(start, end, unitTypeLookup, typeKeyOnRow) {
  const { rows } = await callReport('MoveInsAndMoveOuts', site, start, end);
  let netUnitsTotal = 0, netAreaTotal = 0, netUnitsSS = 0, netAreaSS = 0;
  let unresolvedType = 0;
  for (const r of rows) {
    const inFlag = yes(r.MoveIn), outFlag = yes(r.MoveOut);
    if (!inFlag && !outFlag) continue;
    const areaIn = num(r, 'MovedInArea') || num(r.MovedInArea);
    const areaOut = num(r, 'MovedOutArea') || num(r.MovedOutArea);
    const sign = (inFlag ? 1 : 0) - (outFlag ? 1 : 0);
    const a = inFlag ? areaIn : areaOut;
    netUnitsTotal += sign;
    netAreaTotal += sign * a;
    // resolve SS vs non-SS: prefer a type column directly on the row, else join by unit name against
    // today's RentRoll type lookup (works for units that still exist/are identifiable today)
    let typeStr = typeKeyOnRow ? str(r[typeKeyOnRow]) : '';
    if (!typeStr) {
      const un = str(r.sUnitName) || str(r.Space) || str(r.sSpace);
      if (un && unitTypeLookup.has(un)) typeStr = unitTypeLookup.get(un);
      else unresolvedType++;
    }
    if (isSS(typeStr)) { netUnitsSS += sign; netAreaSS += sign * a; }
  }
  return { netUnitsTotal, netAreaTotal: R2(netAreaTotal), netUnitsSS, netAreaSS: R2(netAreaSS), unresolvedType, rowCount: rows.length };
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
  const tables = allTables(raw);
  const key = Object.keys(tables).find((k) => k.toLowerCase().endsWith('.charge'));
  if (!key) return 0;
  const chargeRows = tables[key].map((r) => (r && r.attributes ? { ...r.attributes, ...r } : r));
  const rentRow = chargeRows.find((r) => str(r.sChgDesc).toLowerCase() === 'rent' || str(r.sChgCategory).toLowerCase() === 'rent');
  return rentRow ? num(rentRow.Credit) : 0;
}

const now = new Date();

console.log(`${'='.repeat(74)}\nSTEP 1: MoveInsAndMoveOuts raw column dump (last 90 days, for field discovery)\n${'='.repeat(74)}`);
const probe90 = new Date(now); probe90.setDate(probe90.getDate() - 90);
const { unitKey, typeKey } = await dumpMioColumns(probe90, now);
console.log(`\nUsing unit-join key: ${unitKey || '(none found — will attempt sUnitName anyway)'}  |  direct type key: ${typeKey || '(none — will join against today\'s RentRoll instead)'}`);

console.log(`\n${'='.repeat(74)}\nSTEP 2: TODAY's live occupied state (trustworthy baseline)\n${'='.repeat(74)}`);
const today = await liveOccupiedToday();
console.log(`Today (${now.toISOString().slice(0, 10)}) Total Store: ${today.totalStore.occupied}/${today.totalStore.total} occupied/total, occArea=${today.totalStore.occArea}`);
console.log(`Today Indoor Self Storage: ${today.ss.occupied}/${today.ss.total} occupied/total, occArea=${today.ss.occArea}`);
console.log(`Today Offices: ${today.offices.occupied}/${today.offices.total} occupied/total, occArea=${today.offices.occArea}`);

const MONTHS = [
  { name: 'June', end: new Date(2026, 5, 30), ssTarget: 28.02, totalTarget: 26.39, screenshotTotal: [314, 348], screenshotSS: [276, 304] },
  { name: 'May', end: new Date(2026, 4, 31), ssTarget: 27.53, totalTarget: 26.48, screenshotTotal: null, screenshotSS: null },
  { name: 'April', end: new Date(2026, 3, 30), ssTarget: 28.34, totalTarget: 27.07, screenshotTotal: null, screenshotSS: null },
];

console.log(`\n${'='.repeat(74)}\nSTEP 3: rewind each month-end from today, cross-check, compute Real Rate\n${'='.repeat(74)}`);
for (const m of MONTHS) {
  console.log(`\n--- ${m.name} 2026 (month-end ${m.end.toISOString().slice(0, 10)}) ---`);
  const windowStart = new Date(m.end.getFullYear(), m.end.getMonth(), m.end.getDate() + 1); // day after month-end
  const net = await netSince(windowStart, now, today.totalStore.unitType, typeKey);
  console.log(`Net moves (${windowStart.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}): ${net.rowCount} event rows, netUnits(Total)=${net.netUnitsTotal}, netArea(Total)=${net.netAreaTotal}, netUnits(SS)=${net.netUnitsSS}, netArea(SS)=${net.netAreaSS}, unresolvedType=${net.unresolvedType}`);

  const rewoundTotalOcc = today.totalStore.occupied - net.netUnitsTotal;
  const rewoundTotalArea = R2(today.totalStore.occArea - net.netAreaTotal);
  const rewoundSSOcc = today.ss.occupied - net.netUnitsSS;
  const rewoundSSArea = R2(today.ss.occArea - net.netAreaSS);
  console.log(`Rewound ${m.name} Total Store: ${rewoundTotalOcc} occupied units, occArea=${rewoundTotalArea}`);
  console.log(`Rewound ${m.name} Indoor Self Storage: ${rewoundSSOcc} occupied units, occArea=${rewoundSSArea}`);

  if (m.screenshotTotal) {
    const [tOcc, tTotal] = m.screenshotTotal, [sOcc] = m.screenshotSS;
    console.log(`ACID TEST vs screenshot: Total occupied ${rewoundTotalOcc} vs true ${tOcc}/${tTotal} -> ${rewoundTotalOcc === tOcc ? 'MATCH' : 'MISMATCH'}  |  SS occupied ${rewoundSSOcc} vs true ${sOcc} -> ${rewoundSSOcc === sOcc ? 'MATCH' : 'MISMATCH'}`);
  }

  const mStart = new Date(m.end.getFullYear(), m.end.getMonth(), 1);
  const rent = await trueRevenueRent(mStart, m.end);
  const credit = await rentCreditFromFinancialSummary(mStart, m.end);
  const areaWeightSS = rewoundTotalArea ? rewoundSSArea / rewoundTotalArea : 0;
  const creditSS = R2(credit * areaWeightSS);
  const effTotal = rent.total - credit, effSS = rent.ss - creditSS;
  const rTotal = rewoundTotalArea ? R2(effTotal / rewoundTotalArea * 12) : 0;
  const rSS = rewoundSSArea ? R2(effSS / rewoundSSArea * 12) : 0;
  const gapTotal = R2(rTotal - m.totalTarget), gapSS = R2(rSS - m.ssTarget);
  console.log(`Real Rate using rewound area: Total=£${rTotal} (target £${m.totalTarget}, gap £${gapTotal})  SS=£${rSS} (target £${m.ssTarget}, gap £${gapSS})`);
  console.log(Math.abs(gapTotal) < 0.05 ? '*** TOTAL WITHIN 5p ***' : 'Not within 5p on Total.');
}

console.log(`\n${'='.repeat(74)}\nIf June's acid test MATCHES and its Real Rate gap is now small, this rewind\nmethod is validated (more trustworthy than the stale frozen snapshot) and\nMay/April above are genuine second/third closed-month cross-checks.\n${'='.repeat(74)}`);
process.exit(0);
