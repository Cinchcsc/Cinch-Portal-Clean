// PROBE (22 Jul 2026), task #308/#403 — Michael: "how can the last portal work and get it but we
// can't". Re-scanned the FULL ReportingWs.asmx method list (63 methods — see npm run
// list:wsdl-methods) against every method we've actually ever called this task. Two things stand out
// that were never tried:
//
//   1. SiteRates — never called. Name is a near-exact match for what we need.
//   2. R6 named his sources "Fin_CreditsIssued" and "Mgmt_Discounts". ManagementSummary is ALREADY
//      known (lib/sitelink.js's own extractNamedTable() comment) to return 9 separate tables in one
//      response — Receipts/Concessions/Discounts/Delinquency/Unpaid/RentLastChanged/VarFromStdRate/
//      UnitActivity/Alerts — and one of those is literally named "Discounts", DIFFERENT from the
//      standalone "Discounts" SOAP method we've been using this whole task. FinancialSummary was only
//      ever checked generically for a multi-table bug (task #88), never specifically hunted for a
//      "Credits"-shaped table. The "Fin_"/"Mgmt_" prefixes read exactly like shorthand for
//      FinancialSummary/ManagementSummary, not generic descriptions — and this fits the exact
//      multi-table-discard bug already confirmed twice in this codebase (extractRows() only ever
//      keeps the single biggest table, silently drops the rest without a trace).
//
// This is a DISCOVERY probe, not a formula test yet — dumps every table + column list + first 5 rows
// for SiteRates, ManagementSummary, FinancialSummary, ManagementHistory, IncomeAnalysis,
// ConsolidatedManagementSummary, BadDebtWrittenOff, and BadDebts (July, live, current month only — cheap
// to run, structure-finding pass before deciding which of these deserve the full June+July exact-match
// treatment). Flags any column matching a credit/discount/concession/rate-shaped pattern.
//
// Run:  node --env-file=.env scripts/probe-new-reports-credits-discounts-rate.js [siteCode]
import { callReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-new-reports-credits-discounts-rate.js <siteCode>'); process.exit(1); }

const str = (v) => String(v ?? '').trim();

// Same "collect EVERY table" logic as probe-rentroll-all-tables.js — a multi-table response's smaller
// tables are exactly what extractRows()'s "biggest wins" heuristic would otherwise silently discard.
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
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
        tables[`${path}${path ? '.' : ''}${k}`] = v;
      } else if (v && typeof v === 'object') {
        walk(v, `${path}${path ? '.' : ''}${k}`);
      }
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

const INTERESTING = /credit|discount|concession|rate|effective|writeoff|write.?off|baddebt|bad.?debt/i;

async function dumpMethod(method, start, end) {
  console.log(`\n${'='.repeat(74)}\n${method}\n${'='.repeat(74)}`);
  let raw, rows;
  try {
    const result = await callReport(method, site, start, end);
    raw = result.raw; rows = result.rows;
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
    return;
  }
  console.log(`Top-level extractRows() would return: ${rows.length} row(s) (whichever table is biggest)`);
  const tables = allTables(raw);
  const names = Object.keys(tables);
  console.log(`Full diffgram has ${names.length} table(s): ${names.join(', ') || '(none)'}`);
  for (const name of names) {
    const trows = tables[name].map(flattenRow);
    const allKeys = new Set();
    for (const r of trows) for (const k of Object.keys(r || {})) allKeys.add(k);
    const cols = [...allKeys];
    const hit = cols.some((c) => INTERESTING.test(c)) || INTERESTING.test(name);
    console.log(`\n  Table "${name}": ${trows.length} row(s)${hit ? '   *** NAME/COLUMN MATCH ***' : ''}`);
    console.log(`    Columns: ${cols.join(', ')}`);
    if (hit && trows.length) {
      console.log('    First 5 rows:');
      trows.slice(0, 5).forEach((r, i) => console.log(`      ${i + 1}.`, JSON.stringify(r)));
    }
  }
  if (!names.length) console.log('  (no tables found in diffgram — check raw response shape manually if this method matters)');
}

const now = new Date();
const julStart = new Date(now.getFullYear(), now.getMonth(), 1);

const methods = [
  'SiteRates',
  'ManagementSummary',
  'FinancialSummary',
  'ManagementHistory',
  'IncomeAnalysis',
  'ConsolidatedManagementSummary',
  'BadDebtWrittenOff',
  'BadDebts',
];

for (const m of methods) await dumpMethod(m, julStart, now);

console.log(`\n${'='.repeat(74)}\nLook for "*** NAME/COLUMN MATCH ***" above. Especially check whether\nManagementSummary has its own "Discounts" table (separate from the\nstandalone Discounts SOAP method already in use) and whether\nFinancialSummary has anything Credits-shaped -- those are the two leading\nhypotheses for R6's "Mgmt_Discounts"/"Fin_CreditsIssued".\n${'='.repeat(74)}`);
process.exit(0);
