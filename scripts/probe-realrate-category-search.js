// PROBE (22 Jul 2026), task #308/#403 — Michael: "cross check it for previous months... to be
// certain" caught a real problem: probe-realrate-june-july-exact.js's "Rent-only ChargeDesc" numerator
// landed within 2-4p of July's targets but missed June's by £0.17-2.19 -- the July closeness was
// coincidence, not a real formula (June disproved it before it got anywhere near being wired).
//
// The earlier searches (this one and the one before it) were also conceptually wrong in a different
// way: they searched over which UNIT TYPES to blend for "Total" (e.g. "Self Storage + Enterprise"),
// but Total must always mean all 5 unit types -- there's no reason it would legitimately exclude
// Office or Drive Up. The real open question is which CHARGE CATEGORIES (ChargeDesc values -- Rent,
// Late Fee, StoreProtect/Insurance, merchandise items, Electric Charge, Service Fee, etc.) belong in
// the Real Rate numerator, applied uniformly across ALL unit types for Total, and restricted to just
// Indoor Self Storage rows (same category rule) for the SS figure.
//
// This searches EVERY subset of ChargeDesc categories seen in True Revenue's Table1 (union across both
// months, ~15-20 categories -> 2^N subsets, still trivial to brute-force) against BOTH June and July's
// real legacy targets AT THE SAME TIME -- a candidate only counts if the SAME category rule reproduces
// BOTH months' Total AND both months' Self Storage figures. Anything that survives that is actually a
// formula, not a one-month coincidence.
//
// Uses the SAME already-established, safe mechanisms as prior probes: frozen June rent_roll read
// straight from Supabase (RentRoll is a point-in-time snapshot that can't be re-queried historically,
// per lib/pull.js's own comment), live True Revenue queries correctly scoped to each month's real date
// bounds (confirmed a genuine period report, not a snapshot), live RentRoll for July (still the current
// month, so its snapshot behavior is exactly what's wanted).
//
// Run:  node --env-file=.env scripts/probe-realrate-category-search.js [siteCode]
import { callReport, callCustomReport, extractNamedTable, extractRows } from '../lib/sitelink.js';
import { admin } from '../lib/supabaseAdmin.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-realrate-category-search.js <siteCode>'); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const isSS = (t) => /self.?storage/i.test(String(t || ''));

async function areaByTypeFromRaw(rawRentRoll) {
  const rows = extractRows(rawRentRoll);
  const areaByType = {};
  for (const r of rows) { const t = String(r.sTypeName || 'Other').trim(); areaByType[t] = (areaByType[t] || 0) + num(r.Area ?? r.Area1); }
  return areaByType;
}

async function fullTable1(start, end) {
  const { raw } = await callCustomReport(781861, site, start, end);
  return extractNamedTable(raw, 'Table1');
}

// Load both months' data.
console.log('Loading June (frozen area + live True Revenue) and July (live) data...\n');

const { data: juneRRRows, error: juneErr } = await admin.from('raw_report').select('raw_response').eq('site_code', site).eq('month', '2026-06-01').eq('report', 'rent_roll').limit(1);
if (juneErr) { console.error('Supabase error:', juneErr.message); process.exit(1); }
if (!juneRRRows || !juneRRRows.length || !juneRRRows[0].raw_response) { console.error('No frozen June rent_roll found — cannot proceed.'); process.exit(1); }
const juneArea = await areaByTypeFromRaw(juneRRRows[0].raw_response);
const juneRows = await fullTable1(new Date(2026, 5, 1), new Date(2026, 6, 0));

const now = new Date();
const julStart = new Date(now.getFullYear(), now.getMonth(), 1);
const { rows: julyRRRows } = await callReport('RentRoll', site, julStart, now);
const julyArea = {};
for (const r of julyRRRows) { const t = String(r.sTypeName || 'Other').trim(); julyArea[t] = (julyArea[t] || 0) + num(r.Area ?? r.Area1); }
const julyRows = await fullTable1(julStart, now);

console.log(`June: ${juneRows.length} Table1 row(s). Area by type:`, JSON.stringify(juneArea));
console.log(`July: ${julyRows.length} Table1 row(s). Area by type:`, JSON.stringify(julyArea));

const juneTotalArea = Object.values(juneArea).reduce((a, v) => a + v, 0);
const juneSSArea = juneArea['Indoor Self Storage'] || 0;
const julyTotalArea = Object.values(julyArea).reduce((a, v) => a + v, 0);
const julySSArea = julyArea['Indoor Self Storage'] || 0;

const targets = { juneSS: 28.02, juneTotal: 26.39, julySS: 19.50, julyTotal: 18.66 };

// Union of every ChargeDesc category seen in either month.
const allDescs = [...new Set([...juneRows, ...julyRows].map((r) => String(r.ChargeDesc || 'Other').trim()))];
console.log(`\n${allDescs.length} distinct ChargeDesc categor(y/ies) across both months: ${allDescs.join(', ')}\n`);

// Per-category sums, split Total (all types) vs SS-only, per month.
function sumsByDesc(rows) {
  const total = {}, ss = {};
  for (const r of rows) {
    const d = String(r.ChargeDesc || 'Other').trim();
    const v = num(r.TruePeriod);
    total[d] = (total[d] || 0) + v;
    if (isSS(r.UnitType)) ss[d] = (ss[d] || 0) + v;
  }
  return { total, ss };
}
const june = sumsByDesc(juneRows);
const july = sumsByDesc(julyRows);

// Exhaustive search over every subset of allDescs, scored by how well it matches ALL FOUR targets
// simultaneously (same category rule, both months, both scopes) — a real formula, not a fit to one
// number. Score = sum of absolute gaps across all 4; exact = every gap under a penny.
let best = null;
const N = allDescs.length;
const cap = 1 << N;
for (let mask = 1; mask < cap; mask++) {
  const cats = allDescs.filter((_, i) => mask & (1 << i));
  const sumFor = (byDesc) => cats.reduce((a, d) => a + (byDesc[d] || 0), 0);
  const juneTotalR = juneTotalArea ? R2(sumFor(june.total) / juneTotalArea * 12) : 0;
  const juneSSR = juneSSArea ? R2(sumFor(june.ss) / juneSSArea * 12) : 0;
  const julyTotalR = julyTotalArea ? R2(sumFor(july.total) / julyTotalArea * 12) : 0;
  const julySSR = julySSArea ? R2(sumFor(july.ss) / julySSArea * 12) : 0;
  const gaps = {
    juneTotal: R2(juneTotalR - targets.juneTotal), juneSS: R2(juneSSR - targets.juneSS),
    julyTotal: R2(julyTotalR - targets.julyTotal), julySS: R2(julySSR - targets.julySS),
  };
  const score = Math.abs(gaps.juneTotal) + Math.abs(gaps.juneSS) + Math.abs(gaps.julyTotal) + Math.abs(gaps.julySS);
  if (!best || score < best.score) best = { cats, gaps, score, juneTotalR, juneSSR, julyTotalR, julySSR };
}

console.log(`${'='.repeat(70)}\nBest category subset across all 262,144 combinations (scored by total\nabsolute gap across June Total/SS + July Total/SS)\n${'='.repeat(70)}`);
console.log(`Categories: ${best.cats.join(', ')}`);
console.log(`  June Total: £${best.juneTotalR}  (target £${targets.juneTotal}, gap £${best.gaps.juneTotal})`);
console.log(`  June SS:    £${best.juneSSR}  (target £${targets.juneSS}, gap £${best.gaps.juneSS})`);
console.log(`  July Total: £${best.julyTotalR}  (target £${targets.julyTotal}, gap £${best.gaps.julyTotal})`);
console.log(`  July SS:    £${best.julySSR}  (target £${targets.julySS}, gap £${best.gaps.julySS})`);
console.log(`  Combined absolute gap: £${R2(best.score)}`);
const allExact = Object.values(best.gaps).every((g) => Math.abs(g) < 0.005);
console.log(`\n${allExact ? '*** ALL FOUR EXACT — this is a real, cross-validated formula ***' : 'NOT exact on all four — do not wire. See per-category breakdown below to reason about what\'s still missing.'}`);

console.log(`\n${'='.repeat(70)}\nPer-category TruePeriod (Total scope), both months, for manual inspection\n${'='.repeat(70)}`);
for (const d of allDescs) console.log(`  ${d}: June £${R2(june.total[d] || 0)}   July £${R2(july.total[d] || 0)}`);
process.exit(0);
