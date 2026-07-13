// Follow-up to probe-truerevenue-coverage.js's Check #1: True Revenue (custom report 781861) has
// THREE tables, not one -- an account-level summary (~17 rows), a UnitType x ChargeDesc summary
// (~34 rows), and a full per-transaction detail table (~1700+ rows, the one extractRows() keeps
// since it's biggest). Keeping the biggest/most-granular table is probably correct -- but only if
// its rows sum to the SAME TruePeriod total SiteLink's own summary tables already computed. If the
// per-transaction table's sum is LOWER than the summary tables' own total, that's direct proof
// something is missing from the detail rows we actually consume (a coverage gap SiteLink itself
// already knows about, in its own pre-aggregated figure) -- which would explain an "always low,
// never high" Real Rate gap perfectly.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-truerevenue-table-totals.js <SITE>
// Example: node --env-file=.env scripts/check-truerevenue-table-totals.js L012
import { callCustomReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const site = process.argv[2] || 'L012';
const lock = await checkPullLock();
if (lock.locked) { console.error('[check-truerevenue-table-totals] ' + lock.message); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

function findAllTables(result) {
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
  return tables;
}

const num = (r, field) => {
  const n = Number(String(r[field] ?? 0).replace(/[£,%\s]/g, ''));
  return Number.isNaN(n) ? 0 : n;
};

const { raw } = await callCustomReport(781861, site, start, now);
const tables = findAllTables(raw);
console.log(`${site}: ${tables.length} table(s) found.\n`);

for (const t of tables) {
  const sum = t.rows.reduce((a, r) => a + num(r, 'TruePeriod'), 0);
  console.log(`  ${t.name} (${t.count} rows): TruePeriod sum = ${sum.toFixed(2)}`);
}

if (tables.length > 1) {
  const sums = tables.map((t) => t.rows.reduce((a, r) => a + num(r, 'TruePeriod'), 0));
  const max = Math.max(...sums.map(Math.abs));
  const min = Math.min(...sums.map(Math.abs));
  const spread = max ? (((max - min) / max) * 100).toFixed(1) : 0;
  console.log(`\nSpread between smallest and largest |TruePeriod sum| across tables: ${spread}%`);
  if (spread > 5) {
    console.log('MISMATCH -- the tables do NOT agree on total TruePeriod. Whichever table extractRows() keeps matters a lot; if the kept (biggest-row-count) table has the LOWEST sum, that directly explains an always-low Real Rate.');
  } else {
    console.log('Tables agree closely -- picking the biggest-row-count table for granularity looks safe; this hypothesis is likely dead, move to per-unit coverage (Check #2) or the legacy-pinning question.');
  }
}
process.exit(0);
