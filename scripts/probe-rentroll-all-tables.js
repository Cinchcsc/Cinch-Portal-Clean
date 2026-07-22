// PROBE (22 Jul 2026), task #308/#403 — Michael: "look for something call billingfredesc" (almost
// certainly sBillingFreqDesc — the exact field name the working "Custom\Billing Frequency" custom
// report, ReportID 999824, already uses). This time checking whether it ALSO exists directly on
// RentRoll's OWN raw SOAP response — specifically inside a SECOND table that extractRows()'s "return
// whichever table is biggest" heuristic would silently discard without a trace.
//
// This exact bug pattern (multi-table SiteLink responses, wrong/only-the-biggest table kept) is
// already confirmed to have bitten this codebase twice before — see lib/sitelink.js's own comments:
//   - ManagementSummary: 9 tables in one response; Delinquency/Unpaid/Discounts/etc. were silently
//     dropped for months because only the single biggest table was ever read.
//   - UnitsInformation: 2 tables; a fixed ~72-row "unit attributes" lookup table beat the real
//     (smaller, for small sites) per-unit table in the size contest and got kept instead, wrongly.
// Every RentRoll probe so far this task — including this task's own
// probe-realrate-effective-rent-exact.js — called `const { rows } = await callReport('RentRoll', ...)`,
// which ONLY ever sees that single largest table. If billing frequency lives in a smaller secondary
// table, nothing has actually looked at it until now.
//
// Dumps EVERY table found anywhere in RentRoll's raw diffgram (not just the biggest), with each
// table's row count and full column list, for both live July and frozen June (from Supabase) — then
// flags any column across ANY table matching a billing-frequency-desc-shaped pattern.
//
// Run:  node --env-file=.env scripts/probe-rentroll-all-tables.js [siteCode]
import { callReport } from '../lib/sitelink.js';
import { admin } from '../lib/supabaseAdmin.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-rentroll-all-tables.js <siteCode>'); process.exit(1); }

// Same diffgram-scoping logic as lib/sitelink.js's extractRows()/extractNamedTable(), but collects
// EVERY array-of-row-objects found, keyed by its full path, instead of picking just one.
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

function dump(raw, label) {
  console.log(`\n${'='.repeat(74)}\n${label}\n${'='.repeat(74)}`);
  const tables = allTables(raw);
  const names = Object.keys(tables);
  console.log(`${names.length} table(s) found in the raw diffgram: ${names.join(', ') || '(none)'}`);
  const hits = [];
  for (const name of names) {
    const rows = tables[name].map(flattenRow);
    const allKeys = new Set();
    for (const r of rows) for (const k of Object.keys(r || {})) allKeys.add(k);
    const cols = [...allKeys];
    console.log(`\n  Table "${name}": ${rows.length} row(s)`);
    console.log(`    Columns: ${cols.join(', ')}`);
    const matches = cols.filter((c) => /bill.{0,4}fre.{0,4}desc|billingfredesc|billingfreqdesc/i.test(c));
    if (matches.length) {
      hits.push({ table: name, cols: matches });
      console.log(`    *** MATCH for billing-frequency-desc-shaped column: ${matches.join(', ')} ***`);
      const dist = {};
      for (const r of rows) { const v = String(r[matches[0]] ?? '(blank)'); dist[v] = (dist[v] || 0) + 1; }
      console.log(`    Value distribution: ${JSON.stringify(dist)}`);
      console.log('    First 5 rows (all columns):');
      rows.slice(0, 5).forEach((r, i) => console.log(`      ${i + 1}.`, JSON.stringify(r)));
    }
  }
  if (!hits.length) console.log(`\n  No column across any of these ${names.length} table(s) matches a billing-frequency-desc pattern.`);
  return hits;
}

const now = new Date();
const julStart = new Date(now.getFullYear(), now.getMonth(), 1);
const { raw: julyRaw } = await callReport('RentRoll', site, julStart, now);
const julyHits = dump(julyRaw, 'JULY 2026 (live RentRoll) — full raw diffgram, ALL tables');

const { data: juneRows, error: juneErr } = await admin.from('raw_report').select('raw_response').eq('site_code', site).eq('month', '2026-06-01').eq('report', 'rent_roll').limit(1);
let juneHits = [];
if (juneErr) { console.error('Supabase error (June rent_roll):', juneErr.message); }
else if (!juneRows || !juneRows.length || !juneRows[0].raw_response) { console.log('\nNo frozen June rent_roll found — skipping June.'); }
else { juneHits = dump(juneRows[0].raw_response, 'JUNE 2026 (frozen RentRoll from Supabase) — full raw diffgram, ALL tables'); }

console.log(`\n${'='.repeat(74)}`);
console.log(julyHits.length || juneHits.length
  ? 'FOUND a billing-frequency-desc-shaped column — see MATCH lines above for which table/month.'
  : 'No match in ANY table, either month. If RentRoll really has no such field anywhere in its raw\nresponse, R6\'s "sBillingFreq ... in the rent roll report" claim does not hold for this SiteLink\naccount/version, and the existing custom-report join (999824) remains the only known source —\nwhich still can\'t answer for June (no history before 22 Jul 2026).');
console.log('='.repeat(74));
process.exit(0);
