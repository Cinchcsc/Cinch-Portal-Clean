// Task #88 — generalized version of dump-managementsummary-tables.js (which found ManagementSummary's
// buried "Delinquency Aging" table, task #77/#162 area). lib/sitelink.js's extractRows() only ever
// returns the SINGLE LARGEST row-array table in a SOAP response (`if (v.length > found.length) found =
// v`) — confirmed for ManagementSummary (13-row UnitActivity kept, 8-row Delinquency Aging silently
// discarded on every pull, ever, until a dedicated raw-response path was added for it). None of
// FinancialSummary / MarketingSummary / MerchandiseSummary's parsers in lib/reportMap.js consume the
// raw 4th parse() arg, so if any of THEIR SOAP responses also have more than one table, the same
// silent data loss is happening there right now, undetected.
// This script dumps every row-array table in ANY report's raw SOAP response, flags which one
// extractRows() would keep (the largest) vs silently discard (everything else), and prints sample
// rows from the discarded ones so we can tell at a glance whether anything meaningful is being lost.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/dump-report-tables.js <Method> [siteCode] [YYYY-MM]
// Examples:
//   node --env-file=.env scripts/dump-report-tables.js FinancialSummary
//   node --env-file=.env scripts/dump-report-tables.js MarketingSummary L012 2026-06
//   node --env-file=.env scripts/dump-report-tables.js MerchandiseSummary
// NOTE: makes ONE live SiteLink call (read-only, no writes) — do not run while a backfill
// (backfill-rentroll-gaps.js / backfill-delinquent30.js) is in progress; SiteLink rejects concurrent
// logons on the same account. Check with the pull-lock status (refresh_log's latest row) first if unsure.
import { callReport } from '../lib/sitelink.js';

const method = process.argv[2];
if (!method) {
  console.error('Usage: node scripts/dump-report-tables.js <Method> [siteCode] [YYYY-MM]');
  console.error('Example: node scripts/dump-report-tables.js FinancialSummary L012 2026-06');
  process.exit(1);
}
const siteCode = process.argv[3] || 'L012'; // Gillingham — same default as dump-managementsummary-tables.js, a mid-size site with clean data
const monthArg = process.argv[4];
let start, end;
if (monthArg) {
  const [y, m] = monthArg.split('-').map(Number);
  start = new Date(y, m - 1, 1);
  const now = new Date();
  const fullMonthEnd = new Date(y, m, 0);
  end = (y === now.getFullYear() && m === now.getMonth() + 1 && fullMonthEnd > now) ? now : fullMonthEnd;
} else {
  const now = new Date();
  start = new Date(now.getFullYear(), now.getMonth(), 1);
  end = now;
}
console.log(`${method} — site ${siteCode}, ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}\n`);
const { raw: result } = await callReport(method, siteCode, start, end);

// Same diffgram-scoping extractRows() itself uses, so we're walking the exact same scope it walks.
let diff = null;
(function find(node) {
  if (!node || typeof node !== 'object' || diff) return;
  for (const [k, v] of Object.entries(node)) {
    if (diff) return;
    if (/diffgram/i.test(k) && v && typeof v === 'object') { diff = v; return; }
    if (v && typeof v === 'object') find(v);
  }
})(result);

const tables = [];
(function walk(node, path) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      tables.push({ path: `${path}.${k}`, name: k, count: v.length, rows: v });
    } else if (v && typeof v === 'object') walk(v, `${path}.${k}`);
  }
})(diff || result, 'root');

if (!tables.length) {
  console.log('No row-array tables found in this response (empty result for this site/month, or an unexpected response shape).');
  process.exit(0);
}

// Mirrors extractRows()'s exact selection rule: strict `>`, so on a tie the FIRST table encountered in
// traversal order wins (matches lib/sitelink.js behavior — not re-derived, just mirrored here for
// diagnostic display; if extractRows()'s rule ever changes this comment/logic should move with it).
let kept = tables[0];
for (const t of tables) if (t.count > kept.count) kept = t;

console.log(`Found ${tables.length} row-array table(s):\n`);
for (const t of tables) {
  const keys = Object.keys(t.rows[0]).filter((k) => k !== 'attributes');
  const flag = t === kept ? 'KEPT by extractRows() (largest)' : 'DISCARDED — silently dropped today';
  console.log(`  ${t.name} (${t.count} rows) [${flag}]`);
  console.log(`    keys: ${keys.join(', ')}`);
}

const discarded = tables.filter((t) => t !== kept);
if (discarded.length) {
  console.log('\n--- Sample rows from DISCARDED tables (these are invisible to the app right now) ---');
  for (const t of discarded) {
    console.log(`\n${t.name}:`);
    for (const r of t.rows.slice(0, 3)) {
      const clean = { ...r }; delete clean.attributes;
      console.log('  ' + JSON.stringify(clean));
    }
  }
} else {
  console.log('\nOnly one table in this response — nothing for extractRows() to discard for this report.');
}
process.exit(0);
