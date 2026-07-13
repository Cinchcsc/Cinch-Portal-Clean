// Task #109 follow-up, per Michael (10 Jul 2026): two alternate theories for why plain Rate runs
// 8-29% high on ~12 sites, raised after probe-rate-unit-outliers.js found no per-unit area/rate
// outliers and no duplicate rows:
//   1. Supabase re-pull duplication — checked by reading the code, not by running this script:
//      lib/pull.js upserts raw_report on a real conflict key (site_code, month, report), so a
//      re-pull overwrites rather than duplicates. Also, every number reported to Michael so far
//      (this script and probe-rate-discrepancy-sites.js / probe-rate-unit-outliers.js) comes from a
//      single FRESH LIVE SiteLink call, never from stored raw_report rows — so even if Supabase
//      storage were duplicating, it couldn't be the cause of the gap already seen in a one-shot live
//      pull. Ruled out for what's been reported so far; not re-tested here.
//   2. Test/demo tenant accounts (e.g. named "cinch" or "r6") sitting in live RentRoll data,
//      inflating the occupied-unit rate average if their dcStdRate isn't a real market rate. THIS
//      is what this script checks — probe-rate-unit-outliers.js's per-unit outlier check should have
//      caught anything wildly mispriced, but came back clean everywhere, so this checks by TENANT
//      IDENTITY instead of by rate magnitude (a test unit could carry an ordinary-looking rate and
//      still not belong in a real average). Doesn't assume which field holds the tenant name — scans
//      every string-valued field on each occupied row for "cinch"/"r6"/"test"/"demo" (case-
//      insensitive) so the actual matching field name comes out of the data, not a guess.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-rate-testdata.js
import { callReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const lock = await checkPullLock();
if (lock.locked) { console.error('[probe-rate-testdata] ' + lock.message); process.exit(1); }

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
const str = (v) => (v == null ? '' : String(v)).trim();

const NEEDLES = ['cinch', 'r6', 'test', 'demo'];

const SITES = {
  L005: { name: 'Brighton', target: 28.28, flagged: true }, L006: { name: 'Huntingdon', target: 17.50, flagged: true },
  L009: { name: 'Newbury', target: 23.22, flagged: true }, L011: { name: 'Sittingbourne', target: 30.90, flagged: true },
  L012: { name: 'Gillingham', target: 32.78, flagged: true }, L013: { name: 'Brentwood', target: 23.97, flagged: true },
  L014: { name: 'Earlsfield', target: 30.68, flagged: true }, L016: { name: 'Seaford', target: 20.36, flagged: true },
  L020: { name: 'Dunstable', target: 20.80, flagged: true }, L023: { name: 'Wisbech', target: 13.67, flagged: true },
  L024: { name: 'Newcastle', target: 17.58, flagged: true }, L027: { name: 'Exeter', target: 22.88, flagged: true },
  L001: { name: 'Bicester', target: 28.50, flagged: false }, L002: { name: 'Leighton Buzzard', target: 33.96, flagged: false },
  L004: { name: 'Chippenham', target: 34.95, flagged: false },
};

function findMatch(row) {
  for (const [field, val] of Object.entries(row)) {
    if (typeof val !== 'string') continue;
    const low = val.toLowerCase();
    for (const needle of NEEDLES) {
      if (low.includes(needle)) return { field, val, needle };
    }
  }
  return null;
}

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const end = now;
console.log(`Scanning live RentRoll for test/demo tenant rows (needles: ${NEEDLES.join(', ')}), ${Object.keys(SITES).length} sites\n`);

for (const [loc, { name, target, flagged }] of Object.entries(SITES)) {
  const { rows } = await callReport('RentRoll', loc, start, end);
  const occ = rows.filter((r) => yes(r.bRented));

  const flaggedRows = [];
  for (const r of occ) {
    const m = findMatch(r);
    if (m) flaggedRows.push({ r, m });
  }

  const areaOf = (r) => num(r, 'Area', 'Area1');
  const stdOf = (r) => num(r, 'dcStdRate');
  const totalArea = occ.reduce((a, r) => a + areaOf(r), 0);
  const totalStd = occ.reduce((a, r) => a + stdOf(r), 0);
  const rate = totalArea ? +((totalStd / totalArea) * 12).toFixed(2) : 0;

  const cleanRows = occ.filter((r) => !flaggedRows.some((f) => f.r === r));
  const cleanArea = cleanRows.reduce((a, r) => a + areaOf(r), 0);
  const cleanStd = cleanRows.reduce((a, r) => a + stdOf(r), 0);
  const cleanRate = cleanArea ? +((cleanStd / cleanArea) * 12).toFixed(2) : 0;

  const diffPct = target ? (((rate - target) / target) * 100).toFixed(1) : 'n/a';
  const cleanDiffPct = target ? (((cleanRate - target) / target) * 100).toFixed(1) : 'n/a';

  console.log(`${loc} ${name} ${flagged ? '[FLAGGED]' : '[control]'} — ${occ.length} occupied rows, ${flaggedRows.length} match test/demo needles`);
  console.log(`  Full Rate: £${rate} (target £${target}, ${diffPct}%)   With matches excluded: £${cleanRate} (target £${target}, ${cleanDiffPct}%)`);
  if (flaggedRows.length) {
    for (const { r, m } of flaggedRows.slice(0, 10)) {
      console.log(`    match: field=${m.field} value="${m.val}" (needle "${m.needle}") — unit=${str(r.sUnit) || str(r.UnitID)}, type=${str(r.sTypeName)}, area=${areaOf(r)}, dcStdRate=${stdOf(r)}`);
    }
    if (flaggedRows.length > 10) console.log(`    ...and ${flaggedRows.length - 10} more`);
  }
  console.log('');
}
process.exit(0);
