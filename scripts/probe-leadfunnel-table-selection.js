// PROBE (17 Jul 2026), READ-ONLY, zero SiteLink calls — following up on probe-multitable-discards'
// lead_funnel sample (L029/May 2026), which showed extractRows() keeping a table named "Marketing"
// (15 rows: SiteID/iTotal/Column1/iConverted/sMarketingDesc) rather than "Activity" (10 rows, the one
// whose columns look like individual inquiry events). That's concerning because lead_funnel is THE
// authoritative source for the headline Enquiries/Reservation numbers (see reportMap.js's big comment
// above the lead_funnel parser) and its whole logic depends on a per-row `dPlaced` date field to
// filter to the requested window — if extractRows() ever silently grabs the WRONG table (same failure
// mode just fixed for insurance_activity: size-based selection flips per site/month), that
// site/month's enquiry counts would silently read as zero (dPlaced undefined on every row of the
// wrong table). This checks EVERY stored lead_funnel raw_response, not just one sample, and scans
// MULTIPLE rows per table (not just row 0) for `dPlaced` — SOAP/XML rows can omit a null field
// per-row, so checking only the first row risks a false negative on which table actually has it.
//
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-leadfunnel-table-selection.js
//
// FIXED 17 Jul 2026 (first run hit "canceling statement due to statement timeout"): same bug class
// already fixed in reparse-report.js — fetching every row's raw_response (the full untouched SOAP
// blob) in ONE query gets heavy enough to hit Postgres's statement_timeout. Fix: fetch only
// id/site_code/month up front (tiny, paginated query), then stream each row's raw_response one at a
// time inside the loop below, with a short retry — many small queries instead of one big one.
import { admin } from '../lib/supabaseAdmin.js';

async function withRetry(fn, attempts = 3, delayMs = 2000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  throw lastErr;
}

function findAllTables(raw) {
  let diff = null;
  (function find(node) {
    if (!node || typeof node !== 'object' || diff) return;
    for (const [k, v] of Object.entries(node)) {
      if (diff) return;
      if (/diffgram/i.test(k) && v && typeof v === 'object') { diff = v; return; }
      if (v && typeof v === 'object') find(v);
    }
  })(raw);
  const tables = [];
  const seen = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') tables.push({ name: k, count: v.length, rows: v });
      else if (v && typeof v === 'object') walk(v);
    }
  })(diff || raw);
  return tables;
}

// Union of keys across up to `sample` rows, not just row 0 — a sparse/absent field on row 0 can still
// be present on row 5.
function unionKeys(rows, sample = 10) {
  const keys = new Set();
  for (const r of rows.slice(0, sample)) for (const k of Object.keys(r)) if (k !== 'attributes') keys.add(k);
  return keys;
}

const PAGE = 500;
let idRows = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await withRetry(async () => {
    const res = await admin.from('raw_report').select('id,site_code,month')
      .eq('report', 'lead_funnel').not('raw_response', 'is', null).order('site_code').order('month').range(from, from + PAGE - 1);
    if (res.error) throw new Error(res.error.message);
    return res;
  });
  idRows = idRows.concat(data);
  if (!data || data.length < PAGE) break;
}
console.log(`Checking ${idRows.length} stored lead_funnel raw_response row(s)...\n`);

let mismatches = 0;
const tableWinCounts = {};
for (const idRow of idRows) {
  let raw_response;
  try {
    raw_response = await withRetry(async () => {
      const { data, error } = await admin.from('raw_report').select('raw_response').eq('id', idRow.id).single();
      if (error) throw new Error(error.message);
      return data.raw_response;
    });
  } catch (e) {
    console.log(`${idRow.site_code}/${String(idRow.month).slice(0, 7)}: FAILED to fetch raw_response — ${e.message}`);
    continue;
  }
  const row = { site_code: idRow.site_code, month: idRow.month };
  const tables = findAllTables(raw_response);
  if (!tables.length) continue;

  let kept = tables[0];
  for (const t of tables) if (t.count > kept.count) kept = t;
  tableWinCounts[kept.name] = (tableWinCounts[kept.name] || 0) + 1;

  const hasDPlaced = tables.filter((t) => unionKeys(t.rows).has('dPlaced'));
  const monthStr = String(row.month).slice(0, 7);

  if (hasDPlaced.length === 0) {
    console.log(`${row.site_code}/${monthStr}: NO table has dPlaced at all (checked ${tables.length} tables: ${tables.map((t) => t.name + '(' + t.count + ')').join(', ')}) — kept="${kept.name}"`);
    mismatches++;
    continue;
  }
  const rightTable = hasDPlaced[0]; // if multiple have it, first is fine for this check
  if (kept.name !== rightTable.name) {
    console.log(`${row.site_code}/${monthStr}: *** MISMATCH *** extractRows() kept "${kept.name}" (${kept.count} rows) but dPlaced lives on "${rightTable.name}" (${rightTable.count} rows) — this site/month's lead_funnel numbers are reading the WRONG table.`);
    mismatches++;
  }
}

console.log('\nTable win counts (which table extractRows() actually kept, across all stored site/months):');
for (const [name, n] of Object.entries(tableWinCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${name.padEnd(20)} ${n}`);

console.log(`\n${mismatches} mismatch(es) found out of ${idRows.length} stored (site, month) pairs.`);
console.log(mismatches ? 'Fix: use extractNamedTable() keyed to whichever table name reliably has dPlaced, same pattern as the insurance_activity/management/true_revenue fixes.' : 'No mismatches — extractRows() has been consistently grabbing the right table so far.');
process.exit(0);
