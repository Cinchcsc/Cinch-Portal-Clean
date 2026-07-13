// Task #181, finally run. Real Rate's annualize factor (blind x12) is CONFIRMED correct (Michael,
// 10 Jul -- legacy does the exact same "no day-proration" math; the 365/period_days attempt made
// the gap WORSE, not better, and was reverted -- see lib/buildPayload.js's recordFor() comment). So
// the still-open large gap vs legacy (10-75% low on every site in Michael's Jul 2026 screenshot,
// always LOW, never high) is NOT the annualize factor.
// Two remaining hypotheses, checked here in priority order:
//   1. NEW, not in task #181's original notes: callCustomReport() (lib/sitelink.js) returns
//      `{ rows: extractRows(result), raw: result }` -- the SAME "keep only the single largest
//      row-array table, silently discard the rest" function that caused ManagementSummary's
//      Delinquency-table bug (task #77/#162) and that dump-report-tables.js (task #88) just
//      re-confirmed is still live. True Revenue (custom report 781861) has NEVER been checked for
//      this -- reportMap.js's true_revenue parser only ever consumes `rows`, never `raw`. If its SOAP
//      response has more than one table, some of the portfolio's real revenue could be sitting in a
//      silently-discarded table right now, on every pull, exactly like Delinquency was. This would
//      explain a uniform "always low, never high" pattern perfectly.
//   2. Task #181's original hypothesis: some occupied units' charges missing entirely even from
//      whatever table IS kept (a coverage gap within the surviving table, not a whole extra table).
// Checks #1 first (cheap, one site) since it's the more likely and more mechanically simple story
// given this exact codebase's own history; then #2 across every site with a known legacy target.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-truerevenue-coverage.js
import { callReport, callCustomReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-truerevenue-coverage] ' + lock.message); process.exit(1); }

const num = (row, ...keys) => {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== '') {
      const n = Number(String(row[k]).replace(/[£,%\s]/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
};
const yes = (v) => v === true || v === 'true' || v === 1 || v === '1';

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

// --- Check #1: multi-table dump for True Revenue (custom report 781861), one representative site ---
console.log('=== Check #1: does True Revenue (781861) have discarded tables, like ManagementSummary did? ===\n');
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const probeLoc = 'L012'; // Gillingham -- same default other dump scripts use, known to have real data
const { raw: trRaw1 } = await callCustomReport(781861, probeLoc, start, now);
const tables = findAllTables(trRaw1);
if (!tables.length) {
  console.log(`${probeLoc}: no row-array tables found at all (unexpected empty response).`);
} else if (tables.length === 1) {
  console.log(`${probeLoc}: only ONE table (${tables[0].name}, ${tables[0].count} rows) -- nothing for extractRows() to discard. Hypothesis #1 is dead, move to #2 below.`);
} else {
  let kept = tables[0];
  for (const t of tables) if (t.count > kept.count) kept = t;
  console.log(`${probeLoc}: found ${tables.length} tables -- THIS IS LIKELY IT:\n`);
  for (const t of tables) {
    const keys = Object.keys(t.rows[0]).filter((k) => k !== 'attributes');
    console.log(`  ${t.name} (${t.count} rows) [${t === kept ? 'KEPT' : 'DISCARDED -- silently dropped today'}]`);
    console.log(`    keys: ${keys.join(', ')}`);
  }
  const discarded = tables.filter((t) => t !== kept);
  console.log('\n--- Sample rows from DISCARDED table(s) ---');
  for (const t of discarded) {
    for (const r of t.rows.slice(0, 3)) { const clean = { ...r }; delete clean.attributes; console.log(`  [${t.name}] ` + JSON.stringify(clean)); }
  }
}

// --- Check #2: coverage within the kept table -- RentRoll occupied units vs True Revenue rows ---
console.log('\n\n=== Check #2: coverage within the table that IS kept, all sites with a known target ===\n');
const SITES = {
  L001: { name: 'Bicester', totalReal: 6.88 }, L002: { name: 'Leighton Buzzard', totalReal: 8.07 }, L003: { name: 'Letchworth', totalReal: 7.28 },
  L004: { name: 'Chippenham', totalReal: 7.86 }, L005: { name: 'Brighton', totalReal: 6.59 }, L006: { name: 'Huntingdon', totalReal: 4.34 },
  L007: { name: 'Newmarket', totalReal: 5.49 }, L008: { name: 'Enfield', totalReal: 4.48 }, L009: { name: 'Newbury', totalReal: 5.44 },
  L010: { name: 'Mitcham', totalReal: 8.17 }, L011: { name: 'Sittingbourne', totalReal: 7.19 }, L012: { name: 'Gillingham', totalReal: 7.81 },
  L013: { name: 'Brentwood', totalReal: 5.47 }, L014: { name: 'Earlsfield', totalReal: 7.23 }, L015: { name: 'Watford', totalReal: 5.10 },
  L016: { name: 'Seaford', totalReal: 4.66 }, L017: { name: 'Southend', totalReal: 5.15 }, L018: { name: 'Woking', totalReal: 5.78 },
  L019: { name: 'Sidcup', totalReal: 6.43 }, L020: { name: 'Dunstable', totalReal: 4.45 }, L022: { name: 'Swindon', totalReal: 3.99 },
  L023: { name: 'Wisbech', totalReal: 3.03 }, L024: { name: 'Newcastle', totalReal: 3.27 }, L025: { name: 'Shoreham-By-Sea', totalReal: 3.02 },
  L027: { name: 'Exeter', totalReal: 2.98 }, L029: { name: 'Abingdon', totalReal: 6.27 },
};

for (const [loc, { name, totalReal }] of Object.entries(SITES)) {
  const { rows: rrRows } = await callReport('RentRoll', loc, start, now);
  const occUnits = new Set(rrRows.filter((r) => yes(r.bRented)).map((r) => String(r.UnitID ?? r.sUnit)));
  const totalArea = rrRows.reduce((a, r) => a + num(r, 'Area', 'Area1'), 0);

  const { rows: trRows } = await callCustomReport(781861, loc, start, now);
  const truePeriodSum = trRows.reduce((a, r) => a + num(r, 'TruePeriod'), 0);
  const realRate = totalArea ? +((truePeriodSum / totalArea) * 12).toFixed(2) : 0;
  const diffPct = totalReal ? (((realRate - totalReal) / totalReal) * 100).toFixed(1) : 'n/a';

  const idField = ['UnitID', 'sUnit', 'LedgerID', 'sUnitName', 'UnitName'].find((f) => trRows[0] && trRows[0][f] != null);
  const distinctTrUnits = idField ? new Set(trRows.map((r) => String(r[idField]))).size : null;

  console.log(`${loc} ${name} — RentRoll occupied: ${occUnits.size} units, ${totalArea} ft² total. True Revenue: ${trRows.length} rows${idField ? `, ${distinctTrUnits} distinct ${idField}` : ' (no per-unit ID field on these rows)'}`);
  console.log(`  Recomputed Total Real Rate: £${realRate} (target £${totalReal}, ${diffPct >= 0 ? '+' : ''}${diffPct}%)`);
}
process.exit(0);
