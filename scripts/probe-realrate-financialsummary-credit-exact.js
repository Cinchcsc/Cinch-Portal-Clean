// PROBE (22 Jul 2026), task #308/#403 — follow-up to probe-new-reports-credits-discounts-rate.js's
// discovery: FinancialSummary's own "Charge" table has a Credit column, and its "Rent" row (£768.42
// for July) exactly matches ManagementSummary's "Concessions" table's Rent row too — two independent
// SiteLink tables agreeing. Hand-calculated: True Revenue's "Rent" TruePeriod (already confirmed the
// closest Effective-Rent base, ÷ occupied area) minus JUST this £768.42 credit — no Discounts
// subtraction at all — lands at July Total £18.62 (target £18.66, 4p off) and SS £19.49 (target
// £19.50, 1p off). An order of magnitude closer than anything found so far. This verifies that
// properly (not hand arithmetic) against BOTH June and July, all 4 targets, before trusting it.
//
// ManagementSummary/FinancialSummary are queried fresh with each month's real date bounds — like
// GeneralJournalEntries/Discounts, neither has ever been flagged a point-in-time snapshot in
// lib/pull.js (only RentRoll/OccupancyStatistics are), and ManagementSummary is already used elsewhere
// in this codebase with real date-range scoping (Debtor Levels, Discount Summary), so treated as a
// genuine period report — a date-range sanity check is printed to verify, not assumed.
//
// SS scope: FinancialSummary's Credit figure is portfolio-wide for the "Rent" charge category, not
// split by unit type — there's no per-type breakdown in that table. SS results below use an
// area-weighted approximation of the credit split, clearly labelled, never counted toward "exact".
// Total is the decisive scope here.
//
// Run:  node --env-file=.env scripts/probe-realrate-financialsummary-credit-exact.js [siteCode]
import { callReport, callCustomReport, extractNamedTable, extractRows } from '../lib/sitelink.js';
import { admin } from '../lib/supabaseAdmin.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-realrate-financialsummary-credit-exact.js <siteCode>'); process.exit(1); }

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

function dateRangeCheck(rows, start, end, label) {
  const dateKeys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (/^d[A-Z]/.test(k) && !Number.isNaN(Date.parse(r[k]))) dateKeys.add(k);
  if (!dateKeys.size) { console.log(`  (${label}: no date-shaped columns to sanity-check against the requested window)`); return; }
  for (const k of dateKeys) {
    const vals = rows.map((r) => Date.parse(r[k])).filter((t) => !Number.isNaN(t));
    if (!vals.length) continue;
    const min = new Date(Math.min(...vals)), max = new Date(Math.max(...vals));
    console.log(`  ${label} date field "${k}": ${min.toISOString().slice(0, 10)} to ${max.toISOString().slice(0, 10)} (requested ${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)})`);
  }
}

async function rentCreditFromFinancialSummary(start, end) {
  const { raw, rows: topRows } = await callReport('FinancialSummary', site, start, end);
  dateRangeCheck(topRows, start, end, 'FinancialSummary');
  const chargeRows = findTable(raw, '.Charge');
  const rentRow = chargeRows.find((r) => str(r.sChgDesc).toLowerCase() === 'rent' || str(r.sChgCategory).toLowerCase() === 'rent');
  if (!rentRow) { console.log('  No "Rent" row found in FinancialSummary Charge table.'); return 0; }
  console.log(`  FinancialSummary Charge/Rent row: Credit=£${rentRow.Credit} CreditTotal(incl tax)=£${R2(num(rentRow.Credit) + num(rentRow.CreditTax1) + num(rentRow.CreditTax2))}`);
  return num(rentRow.Credit);
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

function occupiedArea(rows) {
  let total = 0, ss = 0;
  for (const r of rows) {
    if (!yes(r.bRented)) continue;
    const a = num(r.Area ?? r.Area1), t = str(r.sTypeName) || 'Other';
    total += a; if (isSS(t)) ss += a;
  }
  return { total: R2(total), ss: R2(ss) };
}

const targets = { juneSS: 28.02, juneTotal: 26.39, julySS: 19.50, julyTotal: 18.66 };

async function runMonth(label, rrRows, trStart, trEnd, ssTarget, totalTarget) {
  console.log(`\n${'='.repeat(74)}\n${label}  (target SS £${ssTarget}, Total £${totalTarget})\n${'='.repeat(74)}`);
  const area = occupiedArea(rrRows);
  console.log(`Occupied area: Total=${area.total} SS=${area.ss}`);

  const rent = await trueRevenueRent(trStart, trEnd);
  console.log(`True Revenue "Rent" TruePeriod (exact match): Total=£${rent.total} SS=£${rent.ss}`);

  const credit = await rentCreditFromFinancialSummary(trStart, trEnd);
  const areaWeightSS = area.total ? area.ss / area.total : 0;
  const creditSS = R2(credit * areaWeightSS);
  console.log(`Rent Credit (FinancialSummary): Total=£${R2(credit)}  SS(area-weighted approx)=£${creditSS}`);

  const effTotal = rent.total - credit, effSS = rent.ss - creditSS;
  const rTotal = area.total ? R2(effTotal / area.total * 12) : 0;
  const rSS = area.ss ? R2(effSS / area.ss * 12) : 0;
  const gapTotal = R2(rTotal - totalTarget), gapSS = R2(rSS - ssTarget);
  console.log(`\nReal Rate = (True Revenue Rent - Rent Credit) / occupied area x 12:`);
  console.log(`  Total: £${rTotal}  (target £${totalTarget}, gap £${gapTotal})`);
  console.log(`  SS:    £${rSS}  (target £${ssTarget}, gap £${gapSS}, SS uses an area-weighted approximation of the credit split)`);
  const totalExact = Math.abs(gapTotal) < 0.005;
  console.log(totalExact ? '  *** TOTAL EXACT ***' : '  Not exact on Total.');
  return { rTotal, rSS, gapTotal, gapSS };
}

const now = new Date();
const julStart = new Date(now.getFullYear(), now.getMonth(), 1);
const { rows: julyRRRows } = await callReport('RentRoll', site, julStart, now);
const julyResult = await runMonth('JULY 2026 (live)', julyRRRows, julStart, now, targets.julySS, targets.julyTotal);

const { data: juneRows, error: juneErr } = await admin.from('raw_report').select('raw_response').eq('site_code', site).eq('month', '2026-06-01').eq('report', 'rent_roll').limit(1);
let juneResult = null;
if (juneErr) { console.error('Supabase error (June rent_roll):', juneErr.message); }
else if (!juneRows || !juneRows.length || !juneRows[0].raw_response) { console.log('\nNo frozen June rent_roll found — skipping June.'); }
else {
  const juneRRRows = extractRows(juneRows[0].raw_response);
  const juneStart = new Date(2026, 5, 1), juneEnd = new Date(2026, 6, 0);
  juneResult = await runMonth('JUNE 2026 (closed)', juneRRRows, juneStart, juneEnd, targets.juneSS, targets.juneTotal);
}

console.log(`\n${'='.repeat(74)}`);
if (juneResult && Math.abs(julyResult.gapTotal) < 0.05 && Math.abs(juneResult.gapTotal) < 0.05) {
  console.log('Both months land within 5p on Total using True Revenue Rent minus the\nFinancialSummary Rent Credit, occupied area -- this is very likely the real\nformula (modulo the SS approximation above, which needs a real per-type\nsplit before it can be called exact).');
} else {
  console.log('Compare June vs July gaps above -- if they diverge meaningfully, this\nspecific combination is not yet the full answer either.');
}
console.log('='.repeat(74));
process.exit(0);
