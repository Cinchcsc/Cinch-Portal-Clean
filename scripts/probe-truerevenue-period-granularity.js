// NEW HYPOTHESIS (10 Jul 2026), found by reading lib/buildPayload.js directly rather than testing
// more formula variants: buildPayload()'s sites-loop (line ~567) computes EVERY site's realRate/
// ssReal straight from idx[code][cur] — the CURRENT, IN-PROGRESS month's True Revenue pull — with NO
// override to the last complete month. That's a deliberate, explicit choice for Enquiries/Move-ins/
// Move-outs (Michael, 7 Jul: "show real partial numbers even though they'll look low until the month
// closes" — see buildPayload.js line 529-534) but Real Rate was never separately considered: it's a
// COUNT-vs-RATE difference. A partial "12 enquiries so far this month" is self-evidently incomplete.
// A partial "£X true revenue ÷ area × 12" LOOKS like a complete annualised rate but isn't one — if
// SiteLink's TruePeriod scales with elapsed days (not bucketed by calendar month regardless of the
// End date you pass), then every Real Rate figure right now is being computed from ~10 of July's 31
// days and multiplied by 12 as if it were a whole month — a systematic understatement hiding under
// the "which formula" and "coverage" investigations.
//
// This also fits the evidence already gathered today:
//   - Plain Rate (RentRoll dcStdRate, a point-in-time SNAPSHOT — immune to this because it doesn't
//     accumulate over a period) is accurate to within ~0-5% for the SAME sites where Real Rate
//     (True-Revenue-accumulated, then x12) is 50-80% off (Enfield, Chippenham, etc.).
//   - The MIXED +/- error directions across sites (Bicester +28%, Enfield -75%) fit a partial-window
//     issue better than a pure formula bug: sites whose recurring billing happens to land inside the
//     first 10 days of July would look fine or even overstated; sites that bill later in the month
//     would look badly understated. A pure formula error wouldn't flip sign like that.
//
// This script settles whether SiteLink's TruePeriod is actually day-prorated or month-bucketed:
// call the SAME site's True Revenue custom report with two different END dates inside July (day 5 vs
// day 10) and a known COMPLETE month (June). If TruePeriod scales with elapsed days -> CONFIRMED bug.
// If it stays flat regardless of End date -> NOT this; the cause is elsewhere (coverage/other).
//
// READ-ONLY, live SiteLink. Run:
//   cd cinch-portal-clean && node --env-file=.env scripts/probe-truerevenue-period-granularity.js [siteCode]
import { callCustomReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const code = process.argv[2] || 'L008'; // Enfield — one of the worst Real Rate misses today (-75%/-51%)

async function truePeriodFor(label, start, end) {
  const { rows } = await callCustomReport(781861, code, start, end);
  const tr = REPORTS.true_revenue.parse(rows);
  const total = tr.by_type.reduce((a, t) => a + t.truePeriod, 0);
  const days = Math.round((end - start) / 86400000) + 1;
  console.log(`${label.padEnd(28)} ${String(start.toISOString().slice(0, 10))}..${end.toISOString().slice(0, 10)} (${days}d):  TruePeriod = £${total.toFixed(2)}   (${rows.length} rows)`);
  return { total, days, rows: rows.length };
}

console.log(`=== True Revenue day-proration test — ${code} ===\n`);

const a = await truePeriodFor('Jul 1-5', new Date(2026, 6, 1), new Date(2026, 6, 5));
const b = await truePeriodFor('Jul 1-10 (today, "current")', new Date(2026, 6, 1), new Date(2026, 6, 10));
const c = await truePeriodFor('Jun 1-30 (complete month)', new Date(2026, 5, 1), new Date(2026, 5, 30));

console.log('\n--- Verdict ---');
const ratioBA = a.total ? b.total / a.total : null;
const ratioDays = a.days ? b.days / a.days : null;
console.log(`TruePeriod(10d) / TruePeriod(5d) = ${ratioBA ? ratioBA.toFixed(2) : 'n/a'}   vs day-count ratio ${ratioDays ? ratioDays.toFixed(2) : 'n/a'}`);
if (ratioBA && ratioDays && Math.abs(ratioBA - ratioDays) < 0.3) {
  console.log('=> TruePeriod scales ~linearly with elapsed days. CONFIRMED: the current-month Real Rate');
  console.log('   figure is computed from a partial window and then x12-annualised as if it were a full');
  console.log('   month — a real, systematic understatement, worse the earlier in the month you pull.');
} else if (ratioBA && Math.abs(ratioBA - 1) < 0.15) {
  console.log('=> TruePeriod stayed roughly FLAT regardless of End date within July. This is NOT day-level');
  console.log('   proration — SiteLink appears to bucket "this period" by calendar month regardless of the');
  console.log('   exact End date. Rules out this hypothesis; the real cause is elsewhere (coverage/other).');
} else {
  console.log('=> Ambiguous — neither a clean linear-with-days scaling nor a clean flat result. Paste this');
  console.log('   full output back and we\'ll dig into the specific numbers.');
}
const monthFrac = b.total && c.total ? (b.total / c.total * 100) : null;
console.log(`\nFor reference: Jul(10d) is ${monthFrac ? monthFrac.toFixed(1) + '%' : 'n/a'} of Jun's complete-month total (10/30 = 33.3% would mean pure day-proration).`);
process.exit(0);
