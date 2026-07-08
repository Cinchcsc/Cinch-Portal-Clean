// Follow-up to the Debtor Levels investigation: an Excel export of ManagementSummary for L012
// (Gillingham, run 7 Jul 2026 in SiteLink's own UI) has 16 sheets — Sheet9 is a genuine "Delinquency
// Aging" table (buckets 0-10/11-30/31-60/61-90/.../>360, each with a £ total and unit count) that
// EXACTLY explains the Debtor Levels discrepancy we've been chasing (31-60+ bucket totals £973.29,
// much closer to reality than our current PastDueBalances-derived figure). But lib/sitelink.js's
// extractRows() only ever returns the SINGLE LARGEST table in the SOAP response (`if (v.length >
// found.length) found = v`) — for ManagementSummary that's always "UnitActivity" (13 rows), so the
// Delinquency Aging table (8 rows) has been silently discarded on every pull, ever.
// This script dumps the RAW (untouched by extractRows) SOAP response's table structure so we can
// find the Delinquency Aging table's real diffgram node name (Excel's "Sheet9" is just SiteLink's own
// export tool's generic label, not the underlying table name) — needed before writing a targeted
// extractor for it.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/dump-managementsummary-tables.js
import { callReport } from '../lib/sitelink.js';

const start = new Date(2026, 6, 1), end = new Date();
const { raw: result } = await callReport('ManagementSummary', 'L012', start, end);

// Find the diffgram, then list EVERY table found inside it (name + row count + first row's keys),
// instead of extractRows()'s "just the biggest one" behavior.
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
      tables.push({ path: `${path}.${k}`, name: k, count: v.length, sampleKeys: Object.keys(v[0].attributes || v[0]) });
    } else if (v && typeof v === 'object') walk(v, `${path}.${k}`);
  }
})(diff || result, 'root');

console.log(`Found ${tables.length} row-array tables in the raw ManagementSummary response for L012:\n`);
for (const t of tables) {
  console.log(`${t.name} (${t.count} rows) — keys: ${t.sampleKeys.join(', ')}`);
}
process.exit(0);
