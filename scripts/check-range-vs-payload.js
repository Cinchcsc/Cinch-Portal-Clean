// Diagnostic for the "portal shows 29 sites/correct Enquiries for a few seconds then reverts to 27
// sites with Enquiries overshooting" symptom (8 Jul 2026).
//
// The frontend (app/portal-v2/page.js) does TWO fetches on every load:
//   1. GET /api/portfolio            -> readPortalPayload() -> the PERSISTED portal_payload row
//                                       (last written by `npm run pull` / `npm run rebuild`, via
//                                       lib/buildPayload.js's buildPayload()). Fast (one row read).
//   2. GET /api/portfolio?from=X&to=X -> buildPayloadRange(X, X), computed LIVE from raw_report
//                                       every request, no caching. Slower (full fetchAllRaw() scan).
// #2 always runs right after #1 and OVERWRITES whatever #1 set (liveSitesRaw/liveTotals) once it
// resolves. Since #2 is slower, the UI briefly shows #1's (correct) numbers, then flips to #2's.
// For a single-month range (X to X) these two should be mathematically equivalent — same
// buildIndex()/fetchAllRaw()/aggregateTotals() — but the reported symptom says they're not. This
// script calls both functions back-to-back in one process (no network/timing ambiguity) and diffs
// site lists + Enquiries sums to show exactly where they disagree. Read-only, no writes, no PII
// (site codes/names + aggregate counts only).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-range-vs-payload.js
import { admin } from '../lib/supabaseAdmin.js';
import { buildPayload, buildPayloadRange } from '../lib/buildPayload.js';

const now = new Date();
const cur = new Date(now.getFullYear(), now.getMonth(), 1);
const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);

console.log('Running buildPayload(cur, prev) — same function npm run pull/rebuild persist...');
let t0 = Date.now();
const viaPull = await buildPayload(cur, prev);
console.log(`  done in ${Date.now() - t0}ms — current_month=${viaPull.current_month}, sites=${viaPull.sites.length}, totals.n=${viaPull.totals.n}`);

console.log('\nRunning buildPayloadRange(cur, cur) — same call the frontend makes on every page load...');
t0 = Date.now();
const viaRange = await buildPayloadRange(cur, cur);
console.log(`  done in ${Date.now() - t0}ms — current_month=${viaRange.current_month}, sites=${viaRange.sites.length}, totals.n=${viaRange.totals.n}`);

const codesA = new Set(viaPull.sites.map((s) => s.code));
const codesB = new Set(viaRange.sites.map((s) => s.code));
const onlyInPull = [...codesA].filter((c) => !codesB.has(c));
const onlyInRange = [...codesB].filter((c) => !codesA.has(c));
console.log(`\nSites in buildPayload but NOT buildPayloadRange (${onlyInPull.length}): ${onlyInPull.join(', ') || '(none)'}`);
console.log(`Sites in buildPayloadRange but NOT buildPayload (${onlyInRange.length}): ${onlyInRange.join(', ') || '(none)'}`);

const enqSum = (sites) => sites.reduce((acc, s) => {
  const e = s.enquiries || {};
  acc.total += e.total || 0; acc.phone += e.phone || 0; acc.walkin += e.walkin || 0; acc.web += e.web || 0;
  return acc;
}, { total: 0, phone: 0, walkin: 0, web: 0 });
const eA = enqSum(viaPull.sites), eB = enqSum(viaRange.sites);
console.log(`\nEnquiries via buildPayload:      phone=${eA.phone} walkin=${eA.walkin} web=${eA.web} total=${eA.total}`);
console.log(`Enquiries via buildPayloadRange: phone=${eB.phone} walkin=${eB.walkin} web=${eB.web} total=${eB.total}`);

console.log(`\ntotals.rate      — buildPayload: ${viaPull.totals.rate}    buildPayloadRange: ${viaRange.totals.rate}`);
console.log(`totals.realRate  — buildPayload: ${viaPull.totals.realRate}    buildPayloadRange: ${viaRange.totals.realRate}`);

const byCodeA = Object.fromEntries(viaPull.sites.map((s) => [s.code, s]));
const byCodeB = Object.fromEntries(viaRange.sites.map((s) => [s.code, s]));
console.log('\nPer-site enquiries.total mismatches (shared sites only, buildPayload vs buildPayloadRange):');
let mismatches = 0;
for (const code of [...codesA].filter((c) => codesB.has(c))) {
  const a = (byCodeA[code].enquiries || {}).total || 0;
  const b = (byCodeB[code].enquiries || {}).total || 0;
  if (a !== b) { console.log(`  ${code} (${byCodeA[code].name}): buildPayload=${a}  buildPayloadRange=${b}`); mismatches++; }
}
if (!mismatches) console.log('  (none — every shared site matches exactly)');

// Raw-row sanity check: more than one raw_report row for the same site+report in the current month
// would mean something didn't clean up after itself on a repull (buildIndex()'s de-dupe should mask
// this by pulled_at, but let's confirm there's nothing duplicated that could indicate a deeper issue).
const curKey = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-01`;
console.log(`\nChecking raw_report row counts for ${curKey} (lead_funnel + occupancy)...`);
for (const report of ['lead_funnel', 'occupancy']) {
  const { data, error } = await admin.from('raw_report').select('site_code,pulled_at').eq('month', curKey).eq('report', report);
  if (error) { console.log(`  ${report}: read error: ${error.message}`); continue; }
  const counts = {};
  for (const r of data || []) counts[r.site_code] = (counts[r.site_code] || 0) + 1;
  const dupes = Object.entries(counts).filter(([, n]) => n > 1);
  console.log(`  ${report}: ${data.length} total rows, ${Object.keys(counts).length} distinct sites. Duplicated site rows: ${dupes.length ? dupes.map(([c, n]) => `${c}x${n}`).join(', ') : '(none)'}`);
}

process.exit(0);
