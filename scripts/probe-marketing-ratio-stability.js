// PROBE (24 Jul 2026, task #424) — follow-up to task #422's Daily Snapshot fix and the audit that
// found the Marketing page's monthly Enquiry->Reservation ratio depends on the EXACT SAME volatile
// flag (iInquiryConvertedToLease) that made the Snapshot page's reservations figure swing 33 -> 5
// within a single afternoon for the same already-closed day.
//
// This ratio (lib/buildPayload.js's visibleMarketingLeadConverted / visibleMarketingLeadBase, sourced
// from lib/reportMap.js's lead_funnel parser's channels[label].converted) was calibrated against
// legacy's June 2026 target of 19.8% and is a SIGNED-OFF metric — this script does NOT change
// production code, it only measures whether the underlying number actually drifts on requery the same
// way the Snapshot figure did. Deliberately NOT fixing anything here — that needs Michael's explicit
// decision given the metric's signed-off status (see task #424).
//
// Mirrors buildPayload.js's visibleMarketingLeadBase/visibleMarketingLeadConverted logic exactly:
// per visible channel (Phone/Walk-in/Web only, Email excluded), sum enquiries (dPlaced-gated) and
// converted (dPlaced-gated + iInquiryConvertedToLease=true), then ratio = converted/base.
//
// UPDATED 24 Jul 2026: while this probe's first two runs were in flight, Codex independently widened
// channels[label].converted in lib/reportMap.js's lead_funnel parser (uncommitted as of this update) —
// counts a visible enquiry as converted when EITHER iInquiryConvertedToLease OR
// iReservationConvertedToLease is true, not just the former. Their own comment cites a live July 2026
// portfolio check: legacy at 14.8%, old single-flag logic at 10.6%, new OR-based logic at 14.7% — a
// real accuracy improvement against legacy. That's a SEPARATE question from this probe's (is the number
// stable under requery, whichever flag(s) it's built from) — iReservationConvertedToLease has its own
// "kept for back-compat only — confirmed unreliable" note elsewhere in reportMap.js, so ORing it in
// could still carry its own volatility, better or worse than the original. Added a second column
// (convertedOR) alongside the original (convertedFlag1Only) so both the ORIGINAL question and Codex's
// NEWER formula can be tracked side by side going forward — do not treat convertedFlag1Only's stability
// as automatically describing convertedOR's too; they're built from different (if overlapping) rows.
//
// Run:  node --env-file=.env scripts/probe-marketing-ratio-stability.js [YYYY-MM]
// Default target month: last full calendar month (June 2026 as of writing). Re-run again later today,
// tomorrow, or next week with the SAME argument and compare the ratio for the SAME target month:
//   - Ratio holds steady => the monthly aggregate is stable enough in practice, signed-off number is safe.
//   - Ratio moves (esp. upward, as more leads have time to convert, unlike the Snapshot bug's downward
//     drift) => confirms the same volatility affects this metric too, at a scale that matters even after
//     a full month's volume — worth bringing back to Michael with hard numbers either way.
import { callReport, extractNamedTable } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY', 'SITELINK_LOCATIONS'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const str = (v) => String(v ?? '').trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const inWindow = (dateVal, start, end) => {
  if (!dateVal) return false;
  const d = new Date(dateVal);
  if (Number.isNaN(d.getTime())) return false;
  const day = dayOnly(d);
  return day >= dayOnly(start) && day <= dayOnly(end);
};
const isVisibleMarketingChannel = (label) => {
  const k = str(label).toLowerCase();
  return k === 'phone' || k === 'walkin' || k === 'web';
};

const locations = process.env.SITELINK_LOCATIONS.split(',').map((s) => s.trim()).filter(Boolean);

function targetMonth(argMonth) {
  if (argMonth) {
    const [y, m] = argMonth.split('-').map(Number);
    return { start: new Date(y, m - 1, 1), end: new Date(y, m, 0) };
  }
  const now = new Date();
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
  return { start: lastMonthStart, end: lastMonthEnd };
}

async function countsForSite(site, start, end) {
  // query end must extend one day past the true end — same exclusive-end-date behavior documented
  // throughout this codebase (task #406/#407) for InquiryTracking/dReportDateEnd.
  const soapEnd = new Date(end); soapEnd.setDate(soapEnd.getDate() + 1);
  const { raw } = await callReport('InquiryTracking', site, start, soapEnd);
  const activityRows = extractNamedTable(raw, 'Activity');
  let base = 0, convertedFlag1Only = 0, convertedOR = 0;
  for (const r of activityRows) {
    if (!inWindow(r.dPlaced, start, end)) continue;
    if (!isVisibleMarketingChannel(r.sInquiryType)) continue;
    base++;
    const flag1 = yes(r.iInquiryConvertedToLease);
    const flag2 = yes(r.iReservationConvertedToLease);
    if (flag1) convertedFlag1Only++;
    if (flag1 || flag2) convertedOR++;
  }
  return { base, convertedFlag1Only, convertedOR, rowCount: activityRows.length };
}

async function main() {
  const { start, end } = targetMonth(process.argv[2]);
  const monthLabel = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
  console.log(`${'='.repeat(100)}`);
  console.log(`Marketing Enquiry->Reservation ratio stability check — target month ${monthLabel}`);
  console.log(`Run timestamp: ${new Date().toISOString()}`);
  console.log(`${'='.repeat(100)}`);
  console.log('site'.padEnd(6), 'base(enquiries)'.padEnd(16), 'conv(flag1 only)'.padEnd(18), 'ratio(flag1)%'.padEnd(14), 'conv(OR)'.padEnd(9), 'ratio(OR)%');

  let tBase = 0, tConv1 = 0, tConvOR = 0;
  for (const site of locations) {
    const c = await countsForSite(site, start, end);
    tBase += c.base; tConv1 += c.convertedFlag1Only; tConvOR += c.convertedOR;
    const ratio1 = c.base ? (100 * c.convertedFlag1Only / c.base).toFixed(1) : 'n/a';
    const ratioOR = c.base ? (100 * c.convertedOR / c.base).toFixed(1) : 'n/a';
    console.log(site.padEnd(6), String(c.base).padEnd(16), String(c.convertedFlag1Only).padEnd(18), `${ratio1}%`.padEnd(14), String(c.convertedOR).padEnd(9), `${ratioOR}%`);
  }

  const portfolioRatio1 = tBase ? (100 * tConv1 / tBase).toFixed(1) : 'n/a';
  const portfolioRatioOR = tBase ? (100 * tConvOR / tBase).toFixed(1) : 'n/a';
  console.log(`\n${'='.repeat(100)}\nPORTFOLIO TOTAL for ${monthLabel}\n${'='.repeat(100)}`);
  console.log(`base(enquiries)=${tBase}`);
  console.log(`  flag1-only (iInquiryConvertedToLease):              converted=${tConv1}  ratio=${portfolioRatio1}%`);
  console.log(`  OR (iInquiryConvertedToLease || iReservationConvertedToLease): converted=${tConvOR}  ratio=${portfolioRatioOR}%  <- matches Codex's 24 Jul production formula`);
  console.log(`\nSave this output. Re-run with the SAME argument (${process.argv[2] || 'pass an explicit YYYY-MM to be safe on later runs'}) later today, tomorrow, or next week, and compare BOTH ratios for ${monthLabel} across runs:`);
  console.log(`  - Same ratio both times (either column) => that formula is stable in practice, safe to trust.`);
  console.log(`  - Ratio moves => confirms the volatility found in task #422 also affects that formula; bring the before/after numbers back for a decision on whether/how to fix it.`);
  process.exit(0);
}

main().catch((e) => { console.error('Probe failed:', e.message); process.exit(1); });
