// Direct follow-up to probe-truerevenue-coverage.js's two surprises: (1) True Revenue (781861) has
// 3 tables (17/34/1695 rows) and only the 1695-row detail table is kept -- but the small tables'
// field shapes (AccountCode-only; AccountCode+UnitType+ChargeDesc) look like SiteLink handing back
// the SAME transactions pre-rolled-up at 2 coarser grains alongside the full detail, not genuinely
// separate data. (2) A live recompute from the kept table gave a totally different pattern (mixed
// +/-20-35%) than Michael's screenshot (uniformly -10 to -75%) -- suggesting TruePeriod is a moving,
// intraday month-to-date figure and any two snapshots taken minutes/hours apart will disagree
// regardless of any bug.
// Check A: sum ALL rows (not samples) of all 3 tables' TruePeriod for one site -- if Table/Table1's
//   totals land close to Table2's, they're redundant rollups (hypothesis #1 dead). If Table/Table1
//   sum HIGHER than Table2, Table2 (kept) is missing real revenue -- genuine bug.
// Check B: call True Revenue for the same 2 sites twice, ~20s apart -- if TruePeriod moves between
//   calls, that's direct proof this is a continuously-updating figure, not a fixed monthly bucket.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-truerevenue-tables-timing.js
import { callCustomReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-truerevenue-tables-timing] ' + lock.message); process.exit(1); }

const num = (row, ...keys) => {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== '') {
      const n = Number(String(row[k]).replace(/[£,%\s]/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
};

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
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') tables.push({ name: k, count: v.length, rows: v });
      else if (v && typeof v === 'object') walk(v, `${path}.${k}`);
    }
  })(diff || result, 'root');
  return tables;
}

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const loc = 'L012'; // Gillingham -- same site Check #1 used

console.log('=== Check A: do the 3 tables agree on total TruePeriod, or is the kept table missing revenue? ===\n');
const { raw } = await callCustomReport(781861, loc, start, now);
const tables = findAllTables(raw);
for (const t of tables) {
  const sum = t.rows.reduce((a, r) => a + num(r, 'TruePeriod'), 0);
  console.log(`  ${t.name} (${t.count} rows): Σ TruePeriod = £${sum.toFixed(2)}`);
}
console.log('  (if these are all close, the 3 tables are redundant rollups of the same data -- not data loss.');
console.log('   if the kept/largest table is notably LOWER than the others, that IS real data loss.)\n');

console.log('=== Check B: does TruePeriod move within ~20 seconds, for 2 sites? ===\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const testLoc of ['L012', 'L008']) { // Gillingham + Enfield (Enfield has the known cross-report history)
  const { rows: r1 } = await callCustomReport(781861, testLoc, start, now);
  const sum1 = r1.reduce((a, r) => a + num(r, 'TruePeriod'), 0);
  console.log(`  ${testLoc} call 1: Σ TruePeriod = £${sum1.toFixed(2)}  (${new Date().toISOString()})`);
  await sleep(20000);
  const { rows: r2 } = await callCustomReport(781861, testLoc, start, now);
  const sum2 = r2.reduce((a, r) => a + num(r, 'TruePeriod'), 0);
  console.log(`  ${testLoc} call 2: Σ TruePeriod = £${sum2.toFixed(2)}  (${new Date().toISOString()})  diff: £${(sum2 - sum1).toFixed(2)}\n`);
}
process.exit(0);
