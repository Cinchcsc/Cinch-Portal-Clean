// PROBE (22 Jul 2026), task #308/#403 — direct follow-up to probe-realrate-truerevenue-rent-exact.js's
// finding: True Revenue's "Rent" category alone ÷ OCCUPIED area × 12 (no Credits/Discounts subtraction)
// lands within £0.35-0.90 of all 4 legacy targets — an order of magnitude closer than anything tried
// under TOTAL area (best combined gap £3.88, from probe-realrate-category-search.js). That earlier
// exhaustive search never tried occupied area because total-incl-vacant area was what production had
// wired at the time — it wasn't a considered choice, just what was already there.
//
// This re-runs the SAME exhaustive per-ChargeDesc-category subset search (every combination of the 27
// distinct categories seen in True Revenue's Table1, scored against all 4 targets simultaneously — June
// SS/Total + July SS/Total, both months, not a one-month fit) but against OCCUPIED area instead of
// total area. Given "Rent alone" is already this close under occupied area, and the category search has
// full freedom to add/drop any of the other 26 categories, this has a real shot at landing exactly.
//
// Run:  node --env-file=.env scripts/probe-realrate-category-search-occarea.js [siteCode]
import { callReport, callCustomReport, extractNamedTable, extractRows } from '../lib/sitelink.js';
import { admin } from '../lib/supabaseAdmin.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-realrate-category-search-occarea.js <siteCode>'); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const str = (v) => String(v ?? '').trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const isSS = (t) => /self.?storage/i.test(String(t || ''));

// Occupied-only area, straight from raw RentRoll rows (bRented gate) — the piece the earlier
// category search never computed, since it only ever needed total-incl-vacant area.
function occupiedArea(rows) {
  let total = 0, ss = 0;
  for (const r of rows) {
    if (!yes(r.bRented)) continue;
    const a = num(r.Area ?? r.Area1), t = str(r.sTypeName) || 'Other';
    total += a; if (isSS(t)) ss += a;
  }
  return { total: R2(total), ss: R2(ss) };
}
function totalArea(rows) {
  let total = 0, ss = 0;
  for (const r of rows) {
    const a = num(r.Area ?? r.Area1), t = str(r.sTypeName) || 'Other';
    total += a; if (isSS(t)) ss += a;
  }
  return { total: R2(total), ss: R2(ss) };
}

async function fullTable1(start, end) {
  const { raw } = await callCustomReport(781861, site, start, end);
  return extractNamedTable(raw, 'Table1');
}

function sumsByDesc(rows) {
  const total = {}, ss = {};
  for (const r of rows) {
    const d = str(r.ChargeDesc) || 'Other';
    const v = num(r.TruePeriod);
    total[d] = (total[d] || 0) + v;
    if (isSS(r.UnitType)) ss[d] = (ss[d] || 0) + v;
  }
  return { total, ss };
}

console.log('Loading June (frozen area from Supabase, live True Revenue) and July (live) data...\n');

const { data: juneRRRaw, error: juneErr } = await admin.from('raw_report').select('raw_response').eq('site_code', site).eq('month', '2026-06-01').eq('report', 'rent_roll').limit(1);
if (juneErr) { console.error('Supabase error:', juneErr.message); process.exit(1); }
if (!juneRRRaw || !juneRRRaw.length || !juneRRRaw[0].raw_response) { console.error('No frozen June rent_roll found — cannot proceed.'); process.exit(1); }
const juneRRRows = extractRows(juneRRRaw[0].raw_response);
const juneOcc = occupiedArea(juneRRRows), juneTot = totalArea(juneRRRows);
const juneRows = await fullTable1(new Date(2026, 5, 1), new Date(2026, 6, 0));

const now = new Date();
const julStart = new Date(now.getFullYear(), now.getMonth(), 1);
const { rows: julyRRRows } = await callReport('RentRoll', site, julStart, now);
const julyOcc = occupiedArea(julyRRRows), julyTot = totalArea(julyRRRows);
const julyRows = await fullTable1(julStart, now);

console.log(`June: ${juneRows.length} Table1 row(s). Occupied area: Total=${juneOcc.total} SS=${juneOcc.ss}. Total-incl-vacant area: Total=${juneTot.total} SS=${juneTot.ss}`);
console.log(`July: ${julyRows.length} Table1 row(s). Occupied area: Total=${julyOcc.total} SS=${julyOcc.ss}. Total-incl-vacant area: Total=${julyTot.total} SS=${julyTot.ss}`);

const targets = { juneSS: 28.02, juneTotal: 26.39, julySS: 19.50, julyTotal: 18.66 };
const allDescs = [...new Set([...juneRows, ...julyRows].map((r) => str(r.ChargeDesc) || 'Other'))];
console.log(`\n${allDescs.length} distinct ChargeDesc categor(y/ies) across both months: ${allDescs.join(', ')}\n`);

const june = sumsByDesc(juneRows);
const july = sumsByDesc(julyRows);

function search(areaLabel, juneArea, julyArea) {
  let best = null;
  const N = allDescs.length, cap = 1 << N;
  for (let mask = 1; mask < cap; mask++) {
    const cats = allDescs.filter((_, i) => mask & (1 << i));
    const sumFor = (byDesc) => cats.reduce((a, d) => a + (byDesc[d] || 0), 0);
    const juneTotalR = juneArea.total ? R2(sumFor(june.total) / juneArea.total * 12) : 0;
    const juneSSR = juneArea.ss ? R2(sumFor(june.ss) / juneArea.ss * 12) : 0;
    const julyTotalR = julyArea.total ? R2(sumFor(july.total) / julyArea.total * 12) : 0;
    const julySSR = julyArea.ss ? R2(sumFor(july.ss) / julyArea.ss * 12) : 0;
    const gaps = {
      juneTotal: R2(juneTotalR - targets.juneTotal), juneSS: R2(juneSSR - targets.juneSS),
      julyTotal: R2(julyTotalR - targets.julyTotal), julySS: R2(julySSR - targets.julySS),
    };
    const score = Math.abs(gaps.juneTotal) + Math.abs(gaps.juneSS) + Math.abs(gaps.julyTotal) + Math.abs(gaps.julySS);
    if (!best || score < best.score) best = { cats, gaps, score, juneTotalR, juneSSR, julyTotalR, julySSR };
  }
  console.log(`${'='.repeat(74)}\nBest category subset using ${areaLabel} area (${(1 << allDescs.length) - 1} combinations tried)\n${'='.repeat(74)}`);
  console.log(`Categories: ${best.cats.join(', ')}`);
  console.log(`  June Total: £${best.juneTotalR}  (target £${targets.juneTotal}, gap £${best.gaps.juneTotal})`);
  console.log(`  June SS:    £${best.juneSSR}  (target £${targets.juneSS}, gap £${best.gaps.juneSS})`);
  console.log(`  July Total: £${best.julyTotalR}  (target £${targets.julyTotal}, gap £${best.gaps.julyTotal})`);
  console.log(`  July SS:    £${best.julySSR}  (target £${targets.julySS}, gap £${best.gaps.julySS})`);
  console.log(`  Combined absolute gap: £${R2(best.score)}`);
  const allExact = Object.values(best.gaps).every((g) => Math.abs(g) < 0.005);
  console.log(`${allExact ? '\n*** ALL FOUR EXACT — this is a real, cross-validated formula ***' : '\nNot exact on all four.'}\n`);
  return best;
}

search('OCCUPIED', juneOcc, julyOcc);
search('TOTAL-incl-vacant', juneTot, julyTot);

console.log(`${'='.repeat(74)}\nIf the OCCUPIED-area search above shows all four gaps under a penny, that\nsubset of ChargeDesc categories ÷ occupied area × 12 is the real formula —\nsafe to wire. Compare against the TOTAL-area run (same search, old\ndenominator) to see how much occupied area alone improved things.\n${'='.repeat(74)}`);
process.exit(0);
