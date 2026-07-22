// PROBE (22 Jul 2026), task #308/#403/#404/#405 — probe-realrate-all-sites-june.js's result is the
// single most important finding of this whole investigation: ALL 25 sites undershoot the real June
// target, never overshoot (average -£0.89, ranging -£0.33 to -£1.46 on Total). That's not scatter --
// it's a systematic, one-directional bias, which points at ONE thing being consistently over-
// subtracted or under-counted everywhere, not 25 unrelated site-level data problems.
//
// R6's ORIGINAL formula (the one that kicked off task #308) explicitly said:
//   Credits[Fin_CreditsIssued, excl. "Rent: Write Off Bad Debt"]
// That exclusion has never actually been implemented -- every probe so far (including
// probe-realrate-all-sites-june.js) has subtracted FinancialSummary's Charge/Rent row's WHOLE
// "Credit" figure as-is, which may be a BLENDED total covering both genuine concession credits (which
// SHOULD reduce Real Rate) and bad-debt write-offs (which R6 says should NOT be subtracted here). If
// FinancialSummary's Credit silently includes bad-debt write-offs, we're over-subtracting by exactly
// each site's own write-off amount -- and since delinquency/write-off levels vary site to site, this
// would produce exactly the kind of "always negative, but different magnitude per site" pattern just
// observed, instead of a flat constant miss.
//
// Two candidate reports were discovered (dumped structurally, never followed up) back in
// probe-new-reports-credits-discounts-rate.js: BadDebtWrittenOff and BadDebts. This first dumps both
// for Bicester/June to confirm field names and a plausible £ figure, then -- if a bad-debt figure is
// found -- re-runs the full 25-site comparison using (FinancialSummary Credit MINUS bad-debt
// write-off) instead of Credit alone, to see if that closes the systematic undershoot.
//
// Run:  node --env-file=.env scripts/probe-realrate-baddebt-exclusion.js
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

const juneStart = new Date(2026, 5, 1), juneEnd = new Date(2026, 5, 30);

console.log(`${'='.repeat(100)}\nSTEP 1: dump BadDebtWrittenOff + BadDebts for Bicester/June (field discovery)\n${'='.repeat(100)}`);
let badDebtField = null; // { method, sumFn } once we find something plausible
for (const method of ['BadDebtWrittenOff', 'BadDebts']) {
  console.log(`\n--- ${method} ---`);
  try {
    const { raw, rows } = await callReport(method, 'L001', juneStart, juneEnd);
    console.log(`Top-level rows: ${rows.length}`);
    const tables = allTables(raw);
    for (const [name, trows] of Object.entries(tables)) {
      const flat = trows.map(flattenRow);
      const allKeys = new Set();
      for (const r of flat) for (const k of Object.keys(r)) allKeys.add(k);
      console.log(`  Table "${name}": ${flat.length} row(s), columns: ${[...allKeys].join(', ')}`);
      if (flat.length) console.log(`    First row: ${JSON.stringify(flat[0])}`);
      // look for a plausible £-amount column relating to write-offs
      const amountCol = [...allKeys].find((k) => /amt|amount|balance|total|writeoff|write.?off/i.test(k));
      if (amountCol && !badDebtField) {
        const sum = flat.reduce((s, r) => s + num(r[amountCol]), 0);
        console.log(`    Candidate amount column "${amountCol}", summed across rows: £${R2(sum)}`);
      }
    }
  } catch (e) {
    console.log(`  FAILED: ${e.message}`);
  }
}

// Also check whether FinancialSummary's Charge table has a separate row/category specifically for
// bad debt / write-offs (rather than it being baked silently into the Rent row's Credit figure).
console.log(`\n${'='.repeat(100)}\nSTEP 2: does FinancialSummary's Charge table have its own bad-debt/write-off row?\n${'='.repeat(100)}`);
{
  const { raw } = await callReport('FinancialSummary', 'L001', juneStart, juneEnd);
  const chargeRows = findTable(raw, '.Charge');
  console.log(`FinancialSummary Charge rows (Bicester/June): ${chargeRows.length}`);
  for (const r of chargeRows) {
    const desc = str(r.sChgDesc || r.sChgCategory);
    if (/bad.?debt|write.?off|writeoff/i.test(desc)) {
      console.log(`  *** MATCH *** ${JSON.stringify(r)}`);
    }
  }
  const rentRow = chargeRows.find((r) => str(r.sChgDesc).toLowerCase() === 'rent' || str(r.sChgCategory).toLowerCase() === 'rent');
  console.log(`Rent row Credit (what we've been subtracting so far): £${rentRow ? num(rentRow.Credit) : 'N/A'}`);
}

console.log(`\n${'='.repeat(100)}\nLook for "*** MATCH ***" or a plausible bad-debt amount column above.\nIf found, re-run with that figure subtracted OUT of the Credit we currently\nuse (i.e. TrueCredit = FinancialSummary Credit - bad debt write-off), across\nall 25 sites, to see if it closes the systematic -£0.89 average undershoot.\n${'='.repeat(100)}`);
process.exit(0);
