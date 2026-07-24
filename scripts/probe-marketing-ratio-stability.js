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
  let base = 0, converted = 0;
  for (const r of activityRows) {
    if (!inWindow(r.dPlaced, start, end)) continue;
    if (!isVisibleMarketingChannel(r.sInquiryType)) continue;
    base++;
    if (yes(r.iInquiryConvertedToLease)) converted++;
  }
  return { base, converted, rowCount: activityRows.length };
}

async function main() {
  const { start, end } = targetMonth(process.argv[2]);
  const monthLabel = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
  console.log(`${'='.repeat(90)}`);
  console.log(`Marketing Enquiry->Reservation ratio stability check — target month ${monthLabel}`);
  console.log(`Run timestamp: ${new Date().toISOString()}`);
  console.log(`${'='.repeat(90)}`);
  console.log('site'.padEnd(6), 'base(enquiries)'.padEnd(16), 'converted'.padEnd(11), 'ratio%');

  let tBase = 0, tConv = 0;
  for (const site of locations) {
    const c = await countsForSite(site, start, end);
    tBase += c.base; tConv += c.converted;
    const ratio = c.base ? (100 * c.converted / c.base).toFixed(1) : 'n/a';
    console.log(site.padEnd(6), String(c.base).padEnd(16), String(c.converted).padEnd(11), `${ratio}%`);
  }

  const portfolioRatio = tBase ? (100 * tConv / tBase).toFixed(1) : 'n/a';
  console.log(`\n${'='.repeat(90)}\nPORTFOLIO TOTAL for ${monthLabel}\n${'='.repeat(90)}`);
  console.log(`base(enquiries)=${tBase}  converted=${tConv}  ratio=${portfolioRatio}%`);
  console.log(`\nSave this output. Re-run with the SAME argument (${process.argv[2] || 'pass an explicit YYYY-MM to be safe on later runs'}) later today, tomorrow, or next week, and compare the ratio for ${monthLabel} across runs:`);
  console.log(`  - Same ratio both times => the monthly aggregate is stable in practice; the signed-off number can be trusted as-is.`);
  console.log(`  - Ratio moves => confirms the volatility found in task #422 also affects this signed-off metric; bring the before/after numbers back for a decision on whether/how to fix it.`);
  process.exit(0);
}

main().catch((e) => { console.error('Probe failed:', e.message); process.exit(1); });
