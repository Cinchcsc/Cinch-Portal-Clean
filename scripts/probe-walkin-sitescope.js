// Next untried angle on the Walk-ins gap (task #94): probe-walkin-label-dump.js only spot-checked
// L001/L012 for a label collision — clean on both. probe-enquiries-july-live.js's per-site breakdown
// only ever showed the TOP 10 sites by walk-in count, so Bedford (L021) and Paulton (L026) — the two
// sites we track that legacy DOESN'T (confirmed via check:july-site-count-vs-legacy) — were never
// actually isolated. Phone (51 live vs legacy 52) and Web (869 vs 862) matched closely; only Walk-in
// (76 vs 60) didn't. If Bedford/Paulton get disproportionate walk-in foot traffic relative to their
// phone/web volume, that alone — not a formula bug — could explain a walk-in-only gap that doesn't
// show up on the other two channels.
// This does three things in ONE pass (one ManagementSummary call per site, no day-by-day looping):
//   1. Portfolio walk-in total: all 27 sites vs the 25 sites SHARED with legacy (excl. L021/L026).
//   2. Full per-site walk-in breakdown (not just top 10) — an easy visual check for one outlier site.
//   3. Full raw sDesc label dump across ALL sites (not just 2) — widens the label-collision check.
// PII-SAFE: aggregated counts and source labels only.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-walkin-sitescope.js
import { callReport } from '../lib/sitelink.js';

const num = (row, ...keys) => {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== '') {
      const n = Number(String(row[k]).replace(/[£,%\s]/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
};
const str = (v) => (v == null ? '' : String(v)).trim();

const EXCLUDE = new Set(['L021', 'L026']);   // Bedford, Paulton — not in legacy's 25-site scope
const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);

const perSite = {};
const labelCollisions = [];

for (const loc of locations) {
  process.stderr.write(`[walkin-scope] ${loc}...\n`);
  try {
    const { rows } = await callReport('ManagementSummary', loc, start, end);
    const walkRows = rows.filter((r) => /walk.?in lead/i.test(str(r.sDesc)));
    perSite[loc] = walkRows.reduce((a, r) => a + num(r, 'iMCount'), 0);
    if (walkRows.length > 1) labelCollisions.push({ loc, rows: walkRows.map((r) => ({ desc: str(r.sDesc), mo: num(r, 'iMCount') })) });
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); perSite[loc] = null; }
}

const all27 = Object.values(perSite).reduce((a, v) => a + (v || 0), 0);
const shared25 = Object.entries(perSite).filter(([loc]) => !EXCLUDE.has(loc)).reduce((a, [, v]) => a + (v || 0), 0);
const bedfordPaulton = Object.entries(perSite).filter(([loc]) => EXCLUDE.has(loc)).reduce((a, [, v]) => a + (v || 0), 0);

console.log('\n=== 1. Portfolio Walk-In Leads total: all 27 sites vs 25 shared with legacy ===');
console.log(`All 27 sites:      ${all27}`);
console.log(`Bedford+Paulton:   ${bedfordPaulton}`);
console.log(`25 shared sites:   ${shared25}   (legacy shows 60)`);

console.log('\n=== 2. Per-site Walk-In Leads, full breakdown, sorted descending ===');
const sorted = Object.entries(perSite).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]);
for (const [loc, v] of sorted) console.log(`  ${loc}: ${v}${EXCLUDE.has(loc) ? '  <-- not in legacy scope' : ''}`);

console.log('\n=== 3. Label collisions (sites with >1 row matching /walk.?in lead/i) ===');
if (!labelCollisions.length) console.log('  none — every site has exactly one clean "Walk-In Leads" row.');
else for (const c of labelCollisions) console.log(`  ${c.loc}: ${JSON.stringify(c.rows)}`);
process.exit(0);
