// PROBE (17 Jul 2026, task #227 — full-portal review follow-up), READ-ONLY, zero SiteLink calls.
//
// WHY: this exact bug class has now hit TWICE for real money/data — ManagementSummary (task #77/#162,
// its Delinquency/Unpaid tables were silently discarded, wrong Debtor Levels number) and True Revenue
// (task #181/#225, custom report 781861's `Table1` pre-aggregate was discarded in favour of the much
// larger but WRONG `Table2` per-transaction rows, understating Real Rate 10-75% on every site). Both
// times the mechanism was the same: lib/sitelink.js's extractRows() walks a multi-table SOAP response
// and keeps ONLY the single largest row-array table — `if (v.length > found.length)` — silently
// discarding every other table in the response, however meaningful. Both times it was found by a
// one-off probe AFTER a live symptom (wrong Debtor Levels number; wrong Real Rate) forced a closer
// look, not by checking every report up front. This script does that check up front, for every report
// this codebase knows about, using ALREADY-STORED raw_response data (same reparse-report.js pattern —
// no fresh SiteLink calls, seconds not hours).
//
// It does NOT prove a discarded table's data would change any figure we show (a table might be
// duplicate, empty, or genuinely irrelevant, exactly as several of ManagementSummary's own 9 tables
// turned out to be) — it just surfaces every report with more than one table, and how big each
// discarded one is, so each can be judged on its own merits instead of staying invisible by default.
//
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-multitable-discards.js
import { admin } from '../lib/supabaseAdmin.js';
import { REPORTS } from '../lib/reportMap.js';

// Already explicitly handled via extractNamedTable() elsewhere in reportMap.js as of 17 Jul 2026 —
// keep this in sync if that changes. Anything flagged below NOT in this list has never been looked at.
const ALREADY_HANDLED = {
  management: ['Unpaid', 'VarFromStdRate'],   // UnitActivity is the one extractRows() already keeps
  true_revenue: ['Table1'],                    // Table (site-summary) and Table2 (per-txn) go unread
};

// Same walk as the now-deleted probe-truerevenue-coverage.js (task #181) and lib/sitelink.js's own
// extractRows()/extractNamedTable() — duplicated here rather than imported since neither of those
// exposes "give me every table", only "the biggest" or "one named table".
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
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') tables.push({ name: k, count: v.length, sampleKeys: Object.keys(v[0]).filter((c) => c !== 'attributes') });
      else if (v && typeof v === 'object') walk(v);
    }
  })(diff || raw);
  return tables;
}

const reportKeys = Object.keys(REPORTS);
console.log(`Checking ${reportKeys.length} report types for multi-table SOAP responses: ${reportKeys.join(', ')}\n`);

let flaggedCount = 0;
for (const key of reportKeys) {
  const { data, error } = await admin.from('raw_report').select('id,site_code,month,raw_response')
    .eq('report', key).not('raw_response', 'is', null).order('id', { ascending: false }).limit(1);
  if (error) { console.log(`${key}: query failed — ${error.message}`); continue; }
  if (!data || !data.length) { console.log(`${key}: no stored raw_response yet — skip (run npm run pull with this report first).`); continue; }

  const row = data[0];
  const tables = findAllTables(row.raw_response);
  if (tables.length <= 1) {
    console.log(`${key} (sample ${row.site_code}/${String(row.month).slice(0, 7)}): 1 table (${tables[0]?.name ?? 'none'}, ${tables[0]?.count ?? 0} rows) — nothing for extractRows() to discard.`);
    continue;
  }

  let kept = tables[0];
  for (const t of tables) if (t.count > kept.count) kept = t;
  const known = ALREADY_HANDLED[key] || [];
  const unhandled = tables.filter((t) => t !== kept && !known.some((n) => n.toLowerCase() === t.name.toLowerCase()));

  console.log(`\n${key} (sample ${row.site_code}/${String(row.month).slice(0, 7)}): ${tables.length} tables found —`);
  for (const t of tables) {
    const tag = t === kept ? 'KEPT by extractRows()' : known.some((n) => n.toLowerCase() === t.name.toLowerCase()) ? 'discarded, but already read via extractNamedTable()' : '*** DISCARDED, NEVER READ ***';
    console.log(`  ${t.name.padEnd(20)} ${String(t.count).padStart(6)} rows   [${tag}]`);
    console.log(`    keys: ${t.sampleKeys.join(', ')}`);
  }
  if (unhandled.length) { flaggedCount++; console.log(`  >>> FLAGGED: ${unhandled.map((t) => t.name).join(', ')} — never referenced anywhere in reportMap.js, worth a look.`); }
}

console.log(`\nDone. ${flaggedCount} report(s) have at least one never-read discarded table.`);
console.log('A flagged table is a LEAD, not a confirmed bug — check its columns against what the relevant');
console.log('widget currently shows before changing any parser (some of ManagementSummary\'s own 9 tables');
console.log('turned out to be redundant/irrelevant once actually inspected).');
process.exit(0);
