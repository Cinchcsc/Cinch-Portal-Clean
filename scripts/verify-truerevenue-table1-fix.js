// Verifies the 15 Jul 2026 true_revenue fix (lib/reportMap.js) BEFORE it's trusted/committed to a
// financial-accuracy-critical code path. Prints "True Revenue — Unit Types" totals computed the OLD
// way (Table2 — per-transaction/day-prorated rows, 1853+ per site, what extractRows() was silently
// keeping) side-by-side with the NEW way (Table1 — SiteLink's own 36-row per-(UnitType,ChargeDesc)
// pre-aggregate, what the fix now uses via extractNamedTable()).
//
// Default mode: PORTFOLIO-WIDE, matching Michael's own side-by-side screenshot scope, which excluded
// Bedford (L021) and Paulton (L026) -- sites legacy doesn't track at all (see lib/buildPayload.js's
// 2 Jul/8 Jul comments) -- and Exeter (L027) for this specific comparison. Sum every other active
// site's Table1/Table2 rows, group by UnitType, and compare totals directly against legacy's own
// portfolio-wide Unit Types screenshot.
//
// Run (portfolio, default exclude list):
//   cd cinch-portal-clean && node --env-file=.env scripts/verify-truerevenue-table1-fix.js
// Run (single site):
//   node --env-file=.env scripts/verify-truerevenue-table1-fix.js L012
// Run (portfolio, custom exclude list):
//   node --env-file=.env scripts/verify-truerevenue-table1-fix.js --exclude=L021,L026,L027
import { callCustomReport, extractRows, extractNamedTable } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[verify-truerevenue-table1-fix] ' + lock.message); process.exit(1); }

// Same NAMES map as lib/buildPayload.js:36 (kept in sync manually -- this is a one-off diagnostic).
const NAMES = { L001: 'Bicester', L002: 'Leighton Buzzard', L003: 'Letchworth', L004: 'Chippenham', L005: 'Brighton', L006: 'Huntingdon', L007: 'Newmarket', L008: 'Enfield', L009: 'Newbury', L010: 'Mitcham', L011: 'Sittingbourne', L012: 'Gillingham', L013: 'Brentwood', L014: 'Earlsfield', L015: 'Watford', L016: 'Seaford', L017: 'Southend', L018: 'Woking', L019: 'Sidcup', L020: 'Dunstable', L021: 'Bedford', L022: 'Swindon', L023: 'Wisbech', L024: 'Newcastle', L025: 'Shoreham-By-Sea', L026: 'Paulton', L027: 'Exeter', L028: 'Edmonton', L029: 'Abingdon' };

const args = process.argv.slice(2);
const excludeArg = args.find((a) => a.startsWith('--exclude='));
const singleSite = args.find((a) => /^L\d{3}$/i.test(a));
const DEFAULT_EXCLUDE = ['L021', 'L026', 'L027']; // Bedford, Paulton, Exeter -- matches Michael's screenshot scope

let sitesToRun;
if (singleSite) {
  sitesToRun = [singleSite.toUpperCase()];
} else {
  const excluded = new Set((excludeArg ? excludeArg.split('=')[1].split(',') : DEFAULT_EXCLUDE).map((s) => s.trim().toUpperCase()));
  sitesToRun = Object.keys(NAMES).filter((code) => !excluded.has(code));
  console.log(`Portfolio mode -- excluding: ${[...excluded].join(', ')}`);
}

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

const num = (row, k) => {
  const v = row && row[k];
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[£,%\s]/g, ''));
  return Number.isNaN(n) ? 0 : n;
};
const str = (v) => (v == null ? '' : String(v).trim());
const R2v = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function byType(rows, g) {
  for (const r of rows) {
    const k = str(r.UnitType) || 'Other';
    g[k] = (g[k] || 0) + num(r, 'TruePeriod');
  }
  return g;
}

console.log(`Date range: ${start.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}`);
console.log(`Sites: ${sitesToRun.join(', ')}\n`);

const oldByType = {}, newByType = {};
let oldRowCount = 0, newRowCount = 0, failed = [];
for (const loc of sitesToRun) {
  try {
    const { raw } = await callCustomReport(781861, loc, start, now);
    const oldRows = extractRows(raw);
    const newRows = extractNamedTable(raw, 'Table1');
    oldRowCount += oldRows.length; newRowCount += newRows.length;
    byType(oldRows, oldByType);
    byType(newRows, newByType);
    process.stderr.write(`  ${loc} (${NAMES[loc] || '?'}): ok (old ${oldRows.length} rows, new ${newRows.length} rows)\n`);
  } catch (e) {
    failed.push(loc);
    console.error(`  ${loc}: FAILED — ${e.message}`);
  }
}

console.log(`\nOLD (extractRows, largest table): ${oldRowCount} total rows`);
console.log(`NEW (extractNamedTable 'Table1'): ${newRowCount} total rows`);
if (failed.length) console.log(`Failed sites (skipped): ${failed.join(', ')}`);

const types = [...new Set([...Object.keys(oldByType), ...Object.keys(newByType)])].sort();
console.log('\n' + 'UnitType'.padEnd(20) + 'OLD (Table2)'.padEnd(16) + 'NEW (Table1)');
let oldTotal = 0, newTotal = 0;
for (const t of types) {
  const o = R2v(oldByType[t] || 0), n = R2v(newByType[t] || 0);
  oldTotal += o; newTotal += n;
  console.log(t.padEnd(20) + `£${o}`.padEnd(16) + `£${n}`);
}
console.log('-'.repeat(50));
console.log('TOTAL'.padEnd(20) + `£${R2v(oldTotal)}`.padEnd(16) + `£${R2v(newTotal)}`);
console.log('\nCompare the NEW column above against the legacy portal\'s own True Revenue — Unit Types');
console.log('screenshot (same excluded sites). If NEW is close to legacy and OLD is not, the fix is confirmed.');
process.exit(0);
