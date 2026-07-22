// PROBE (22 Jul 2026), task #308/#403 — parallel angle while the category-search script runs. This
// tests a COMPLETELY different, already-existing formula: reportMap.js's own occupancy (Occupancy
// Statistics) parser has a longstanding comment claiming "Real Rate per ft² (actual) = Σ ActualOccupied
// ÷ Σ occupied_area × 12" was verified for May 2026 to <1% — but that was checked against the LIVE
// PORTAL's own (possibly still-wrong) numbers at the time, never against legacy's actual authoritative
// figures directly. Worth testing against the NOW-CONFIRMED June/July targets, independent of True
// Revenue entirely (different report, different area denominator — OCCUPIED area, not total-incl-
// vacant).
//
// Occupancy Statistics is ALSO a point-in-time snapshot per lib/pull.js's own comment (named
// specifically alongside RentRoll: "RentRoll/OccupancyStatistics are point-in-time snapshots") — so
// June must be read from its FROZEN raw_response in Supabase, not re-pulled live, same reasoning as
// rent_roll in the other probe. July, still the current month, is pulled live.
//
// Run:  node --env-file=.env scripts/probe-realrate-occstats-formula.js [siteCode]
import { callReport, extractRows } from '../lib/sitelink.js';
import { admin } from '../lib/supabaseAdmin.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-realrate-occstats-formula.js <siteCode>'); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const isSS = (t) => /self.?storage/i.test(String(t || ''));

function summarize(rows) {
  let actOccTotal = 0, occAreaTotal = 0, actOccSS = 0, occAreaSS = 0;
  for (const r of rows) {
    const a = num(r.Area ?? r.Area1), o = num(r.Occupied);
    const occArea = num(r.OccupiedArea ?? r.OccArea) || (a * o);
    const actOcc = num(r.ActualOccupied);
    actOccTotal += actOcc; occAreaTotal += occArea;
    if (isSS(r.UnitType)) { actOccSS += actOcc; occAreaSS += occArea; }
  }
  return {
    total: occAreaTotal ? R2(actOccTotal / occAreaTotal * 12) : 0,
    ss: occAreaSS ? R2(actOccSS / occAreaSS * 12) : 0,
    actOccTotal: R2(actOccTotal), occAreaTotal: R2(occAreaTotal), actOccSS: R2(actOccSS), occAreaSS: R2(occAreaSS),
  };
}

const targets = { juneSS: 28.02, juneTotal: 26.39, julySS: 19.50, julyTotal: 18.66 };

console.log(`${'='.repeat(70)}\nJUNE 2026 — frozen OccupancyStatistics from Supabase\n${'='.repeat(70)}`);
{
  const { data: rows, error } = await admin.from('raw_report').select('raw_response').eq('site_code', site).eq('month', '2026-06-01').eq('report', 'occupancy').limit(1);
  if (error) { console.error('Supabase error:', error.message); }
  else if (!rows || !rows.length || !rows[0].raw_response) { console.log('No frozen June occupancy raw_response found — skipping June.'); }
  else {
    const occRows = extractRows(rows[0].raw_response);
    const s = summarize(occRows);
    console.log(`${occRows.length} row(s). ActualOccupied Σ=£${s.actOccTotal}  occupied_area Σ=${s.occAreaTotal}`);
    console.log(`Real Rate Total: £${s.total}  (target £${targets.juneTotal}, gap £${R2(s.total - targets.juneTotal)})`);
    console.log(`Real Rate SS:    £${s.ss}  (target £${targets.juneSS}, gap £${R2(s.ss - targets.juneSS)})`);
  }
}

console.log(`\n${'='.repeat(70)}\nJULY 2026 — live OccupancyStatistics\n${'='.repeat(70)}`);
{
  const now = new Date();
  const julStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const { rows: occRows } = await callReport('OccupancyStatistics', site, julStart, now);
  const s = summarize(occRows);
  console.log(`${occRows.length} row(s). ActualOccupied Σ=£${s.actOccTotal}  occupied_area Σ=${s.occAreaTotal}`);
  console.log(`Real Rate Total: £${s.total}  (target £${targets.julyTotal}, gap £${R2(s.total - targets.julyTotal)})`);
  console.log(`Real Rate SS:    £${s.ss}  (target £${targets.julySS}, gap £${R2(s.ss - targets.julySS)})`);
}
console.log(`\n${'='.repeat(70)}\nIf all 4 gaps are near £0, this Occupancy-Statistics-based formula (totally\ndifferent report/denominator than True Revenue) may be the real answer.\n${'='.repeat(70)}`);
process.exit(0);
