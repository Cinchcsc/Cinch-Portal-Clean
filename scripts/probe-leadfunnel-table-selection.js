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

// BUG FIX (17 Jul 2026, same day this probe was first written): this originally returned each
// table's rows RAW, un-flattened — but node-soap puts every row's real column values under a
// nested `.attributes` object (see lib/sitelink.js's extractRows()/extractNamedTable(), which both
// flatten `{ attributes, ...rest } → { ...attributes, ...rest }` before a caller ever sees a row).
// Because unionKeys() below explicitly SKIPS the 'attributes' key, the first run of this probe was
// checking each row's top-level keys only — which for an unflattened SOAP row is typically just
// `{ attributes: {...} }` plus a couple of SOAP-internal keys — so it could almost never find
// `dPlaced` anywhere, even on months already confirmed correct on the live portal. That produced a
// misleading "1023 mismatches" headline conflating two very different things (see below). Fixed by
// flattening each row the exact same way lib/sitelink.js does, so this probe checks what the real
// parser actually sees.
function flattenRow(r) {
  if (r && typeof r === 'object' && r.attributes && typeof r.attributes === 'object') {
    const { attributes, ...rest } = r; return { ...attributes, ...rest };
  }
  return r;
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
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') tables.push({ name: k, count: v.length, rows: v.map(flattenRow) });
      else if (v && typeof v === 'object') walk(v);
    }
  })(diff || raw);
  return tables;
}

// Union of keys across ALL rows in the table, not just a small sample — a sparse/absent field on
// row 0 can still be present later, and these tables are small enough (tens of rows, at most a few
// hundred) that scanning every row costs nothing and removes sample-size as a variable entirely.
function unionKeys(rows) {
  const keys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (k !== 'attributes') keys.add(k);
  return keys;
}

// CASE-INSENSITIVE check, ADDED 20 Jul 2026 — the previous run reported 995 site/months with "NO
// table has dPlaced at all", including some recent 2026 months, which doesn't match reality (those
// months are confirmed correct on the live portal). Same lesson as the .attributes bug above: before
// believing "the field doesn't exist", rule out the probe itself being too strict. `Set.has('dPlaced')`
// is an exact, case-SENSITIVE match — if SiteLink ever returns this column as `dplaced`/`DPlaced`/
// `Dplaced` (a real possibility across years of API/schema drift), this would wrongly report it
// missing. This checks case-insensitively and returns which exact casing was found, if any.
function findDPlacedKey(keys) {
  for (const k of keys) if (k.toLowerCase() === 'dplaced') return k;
  return null;
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

// Two DIFFERENT phenomena, counted separately (the first run of this probe conflated them into one
// "mismatches" number, which overstated the problem — see flattenRow() comment above):
//   genuineMismatches: a table WITH dPlaced exists, but extractRows()'s size-based pick kept a
//     DIFFERENT table instead — a real, confirmed table-selection bug (same class as
//     insurance_activity's fix).
//   noDPlacedAnywhere: dPlaced isn't present on ANY discovered table for that site/month — a
//     different, separate question (could be a genuinely old/blank month, a schema difference, or
//     something else) that does NOT by itself prove extractRows() picked wrong.
let genuineMismatches = 0;
let noDPlacedAnywhere = 0;
const tableWinCounts = {};
const noDPlacedExamples = [];
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

  const tableKeys = tables.map((t) => ({ t, keys: unionKeys(t.rows) }));
  const hasDPlaced = tableKeys.filter(({ keys }) => findDPlacedKey(keys));
  const monthStr = String(row.month).slice(0, 7);

  if (hasDPlaced.length === 0) {
    noDPlacedAnywhere++;
    // Full column list per table now (not just name+count) — so if the real field is a near-miss
    // spelling (DatePlaced, dtPlaced, etc.) rather than a casing difference, it's visible directly
    // here instead of needing yet another probe revision.
    if (noDPlacedExamples.length < 15) {
      const detail = tableKeys.map(({ t, keys }) => `${t.name}(${t.count}): [${[...keys].sort().join(', ')}]`).join(' | ');
      noDPlacedExamples.push(`${row.site_code}/${monthStr}: kept="${kept.name}" — ${detail}`);
    }
    continue;
  }
  const { t: rightTable, keys: rightKeys } = hasDPlaced[0]; // if multiple have it, first is fine for this check
  const foundKey = findDPlacedKey(rightKeys);
  if (kept.name !== rightTable.name) {
    console.log(`${row.site_code}/${monthStr}: *** MISMATCH *** extractRows() kept "${kept.name}" (${kept.count} rows) but ${foundKey} lives on "${rightTable.name}" (${rightTable.count} rows) — this site/month's lead_funnel numbers are reading the WRONG table.`);
    genuineMismatches++;
  } else if (foundKey !== 'dPlaced') {
    console.log(`${row.site_code}/${monthStr}: table selection is correct, but the field is cased "${foundKey}" not "dPlaced" — confirm lib/reportMap.js's lead_funnel parser reads it correctly regardless of casing.`);
  }
}

console.log('\nTable win counts (which table extractRows() actually kept, across all stored site/months):');
for (const [name, n] of Object.entries(tableWinCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${name.padEnd(20)} ${n}`);

console.log(`\n${genuineMismatches} genuine mismatch(es) (a table HAS dPlaced, but a different table was kept) out of ${idRows.length} stored (site, month) pairs.`);
console.log(`${noDPlacedAnywhere} site/month(s) where dPlaced was not found on ANY discovered table — separate, unresolved question, NOT counted as a mismatch. First ${noDPlacedExamples.length} example(s):`);
for (const line of noDPlacedExamples) console.log(`  ${line}`);
console.log(genuineMismatches ? '\nFix: use extractNamedTable() keyed to whichever table name reliably has dPlaced, same pattern as the insurance_activity/management/true_revenue fixes.' : '\nNo genuine mismatches — when a table has dPlaced, extractRows() has been consistently grabbing it.');
process.exit(0);
