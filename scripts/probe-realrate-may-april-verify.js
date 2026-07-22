// PROBE (22 Jul 2026), task #308/#403 — probe-june-frozen-unitcount-check.js confirmed June's frozen
// rent_roll was pulled 2026-07-08 -- 8 days after June actually closed -- and shows 3 extra occupied
// units vs legacy's own June KPIs screenshot (317 vs 314 Total Store, 279 vs 276 Indoor Self Storage,
// Offices unaffected at 4/4). That snapshot is stale, not wrong-formula -- June was never a valid
// second closed-month test.
//
// Michael separately supplied May 2026 (Real Rate SS£27.53/Total£26.48) and April 2026 (Real Rate
// SS£28.34/Total£27.07) legacy screenshots earlier this task, never yet tested against any formula.
// This checks whether THOSE months' frozen rent_roll snapshots were captured on time (pulled_at close
// to the real month-end, not stale like June's), then runs the same formula that landed within
// 4p/1p for July -- True Revenue "Rent" TruePeriod minus FinancialSummary's Rent Credit, divided by
// OCCUPIED area x 12 -- against whichever of May/April look trustworthy, using their real targets.
//
// Run:  node --env-file=.env scripts/probe-realrate-may-april-verify.js [siteCode]
import { callCustomReport, extractNamedTable, extractRows, callReport } from '../lib/sitelink.js';
import { admin } from '../lib/supabaseAdmin.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-realrate-may-april-verify.js <siteCode>'); process.exit(1); }

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

function occupiedArea(rows) {
  let total = 0, ss = 0, occCount = 0, totalCount = 0;
  for (const r of rows) {
    const a = num(r.Area ?? r.Area1), t = str(r.sTypeName) || 'Other';
    totalCount++;
    if (!yes(r.bRented)) continue;
    occCount++;
    total += a; if (isSS(t)) ss += a;
  }
  return { total: R2(total), ss: R2(ss), occCount, totalCount };
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

const MONTHS = [
  { label: '2026-06-01', name: 'June', monthIdx: 5, ssTarget: 28.02, totalTarget: 26.39 },
  { label: '2026-05-01', name: 'May', monthIdx: 4, ssTarget: 27.53, totalTarget: 26.48 },
  { label: '2026-04-01', name: 'April', monthIdx: 3, ssTarget: 28.34, totalTarget: 27.07 },
];

for (const { label, name, monthIdx, ssTarget, totalTarget } of MONTHS) {
  console.log(`\n${'='.repeat(74)}\n${name} 2026  (target SS £${ssTarget}, Total £${totalTarget})\n${'='.repeat(74)}`);
  const { data: rows, error } = await admin.from('raw_report').select('raw_response, pulled_at').eq('site_code', site).eq('month', label).eq('report', 'rent_roll').limit(1);
  if (error) { console.error('Supabase error:', error.message); continue; }
  if (!rows || !rows.length || !rows[0].raw_response) { console.log(`No frozen ${name} rent_roll found for this site — skipping.`); continue; }

  const monthEnd = new Date(2026, monthIdx + 1, 0);
  const pulledAt = new Date(rows[0].pulled_at);
  const daysLate = Math.round((pulledAt - monthEnd) / 86400000);
  console.log(`Frozen ${name} rent_roll pulled at: ${rows[0].pulled_at}  (month-end was ${monthEnd.toISOString().slice(0, 10)}, snapshot is ${daysLate} day(s) after month-end)`);
  const trustworthy = daysLate <= 2;
  console.log(trustworthy ? 'Snapshot timing looks trustworthy (captured at or near month-end).' : 'Snapshot timing looks STALE — results below may not reflect the true closing state, same issue confirmed for June.');

  const rrRows = extractRows(rows[0].raw_response);
  const area = occupiedArea(rrRows);
  console.log(`Occupied units: ${area.occCount}/${area.totalCount}. Occupied area: Total=${area.total} SS=${area.ss}`);

  const mStart = new Date(2026, monthIdx, 1), mEnd = new Date(2026, monthIdx + 1, 0);
  const rent = await trueRevenueRent(mStart, mEnd);
  const credit = await rentCreditFromFinancialSummary(mStart, mEnd);
  console.log(`True Revenue "Rent" TruePeriod: Total=£${rent.total} SS=£${rent.ss}`);
  console.log(`FinancialSummary Rent Credit: £${R2(credit)}`);

  const areaWeightSS = area.total ? area.ss / area.total : 0;
  const creditSS = R2(credit * areaWeightSS);
  const effTotal = rent.total - credit, effSS = rent.ss - creditSS;
  const rTotal = area.total ? R2(effTotal / area.total * 12) : 0;
  const rSS = area.ss ? R2(effSS / area.ss * 12) : 0;
  const gapTotal = R2(rTotal - totalTarget), gapSS = R2(rSS - ssTarget);
  console.log(`\nReal Rate = (True Revenue Rent - Rent Credit) / occupied area x 12:`);
  console.log(`  Total: £${rTotal}  (target £${totalTarget}, gap £${gapTotal})`);
  console.log(`  SS:    £${rSS}  (target £${ssTarget}, gap £${gapSS}, area-weighted credit-split approximation)`);
  console.log(Math.abs(gapTotal) < 0.05 ? '  *** TOTAL WITHIN 5p ***' : '  Not within 5p on Total.');
}

console.log(`\n${'='.repeat(74)}\nFor any month flagged STALE above, treat its result as inconclusive --\nsame issue as June. Only trust a match/mismatch on a month whose snapshot\ntiming looks trustworthy.\n${'='.repeat(74)}`);
process.exit(0);
