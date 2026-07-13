// Decisive test for #181: probe-truerevenue-coverage.js's Check #2 compared TODAY's live 10-day
// July MTD (blindly annualized x12) against legacy targets -- and got a roughly 50/50 mix of
// over/under errors (-66% to +36%), NOT the "always low" pattern task #117/#181 originally
// documented. A coverage gap (units silently missing from True Revenue) should be one-directional
// and roughly stable regardless of what period you sample; a bidirectional, wildly-swinging error
// looks much more like comparing a partial 10-day window (blind x12) against legacy targets that
// almost certainly reflect a FULLY CLOSED month (probably June, given the June-vs-June comparison
// work in task #76) -- a period mismatch, not a data bug.
// This re-runs the exact same formula (buildPayload.js's recordFor(): trueRevenueNumerator =
// Σ true_revenue.by_type[].truePeriod, totalArea = rent_roll.total_area_all_units, realRate =
// numerator/totalArea*12) against a FULLY CLOSED month's ALREADY-STORED raw_report rows -- no live
// SiteLink calls, no partial-month annualization risk. If the error shrinks dramatically and/or
// becomes consistently one-directional for a closed month, that confirms period mismatch as the
// dominant explanation. If it's still a wild bidirectional swing even for a closed month, the
// coverage-completeness hypothesis is back in play.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-realrate-closed-month.js [YYYY-MM]
// Example: node --env-file=.env scripts/check-realrate-closed-month.js 2026-06
import { admin } from '../lib/supabaseAdmin.js';

const monthArg = process.argv[2];
let targetMonth;
if (monthArg) {
  targetMonth = monthArg + '-01';
} else {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  targetMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-01`;
}
console.log(`Testing closed month: ${targetMonth}\n`);

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

async function fetchStored(report, siteCode) {
  const { data, error } = await admin
    .from('raw_report').select('data').eq('report', report).eq('site_code', siteCode).eq('month', targetMonth).maybeSingle();
  if (error) throw new Error(error.message);
  let d = data?.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
  return d || null;
}

let sumAbsErr = 0, sumSignedErr = 0, n = 0, overCount = 0, underCount = 0;
for (const [loc, { name, totalReal }] of Object.entries(SITES)) {
  const rr = await fetchStored('rent_roll', loc);
  const tr = await fetchStored('true_revenue', loc);
  if (!rr || !tr) {
    console.log(`${loc} ${name}: MISSING stored data for ${targetMonth} (rent_roll=${!!rr}, true_revenue=${!!tr}) -- skipped.`);
    continue;
  }
  const totalArea = rr.total_area_all_units || 0;
  const byType = tr.by_type || [];
  const trueRevenueNumerator = byType.reduce((a, r) => a + (r.truePeriod || 0), 0);
  const realRate = totalArea ? Math.round((trueRevenueNumerator / totalArea * 12 + Number.EPSILON) * 100) / 100 : 0;
  const diffPct = totalReal ? (((realRate - totalReal) / totalReal) * 100) : null;
  console.log(`${loc} ${name} — stored ${targetMonth}: totalArea=${totalArea}, trueRevenueNumerator=${trueRevenueNumerator.toFixed(2)}`);
  console.log(`  Recomputed Total Real Rate: £${realRate} (target £${totalReal}, ${diffPct == null ? 'n/a' : (diffPct >= 0 ? '+' : '') + diffPct.toFixed(1) + '%'})`);
  if (diffPct != null) {
    sumAbsErr += Math.abs(diffPct); sumSignedErr += diffPct; n++;
    if (diffPct > 2) overCount++; else if (diffPct < -2) underCount++;
  }
}

if (n) {
  console.log(`\n--- Summary across ${n} sites (${targetMonth}) ---`);
  console.log(`Average |error|: ${(sumAbsErr / n).toFixed(1)}%`);
  console.log(`Average signed error: ${(sumSignedErr / n).toFixed(1)}% (negative = we run low, positive = we run high)`);
  console.log(`Sites over target: ${overCount}, sites under target: ${underCount}, roughly flat: ${n - overCount - underCount}`);
  console.log('\nCompare this to the earlier live-July-MTD run: if avg |error| here is much smaller, or the over/under split is now lopsided one direction instead of ~50/50, that confirms the earlier noise was a period-mismatch artifact, not a real coverage bug.');
}
process.exit(0);
