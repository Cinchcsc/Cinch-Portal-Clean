// PROBE (23 Jul 2026), task #406 — Michael: Abingdon (L029) shows 0 reservations on the Weekly/
// Daily/Quarterly Snapshot page.
//
// Context: pullSnapshot.js (the Daily Snapshot's own pull, separate from the main monthly pull.js)
// calls InquiryTracking LIVE for each site every morning and computes reservation_stage_count via
// reportMap.js's lead_funnel parser, then writes ONE aggregated row to snapshot_payload — it does NOT
// persist raw_response anywhere, so there's nothing to inspect after the fact for the snapshot path
// specifically. reportMap.js's own lead_funnel comment (line ~609) documents L029/2026-06 as a
// CONFIRMED past instance of the "biggest table wins" bug (extractRows() grabbing the 15-row
// "Marketing" aggregate table instead of the real per-event "Activity" table) -- already fixed via
// extractNamedTable(raw,'Activity'), and pullSnapshot.js was separately fixed 21 Jul to actually pass
// `raw` through at all. Both fixes should already cover this, in theory -- this checks whether they
// really do for L029 specifically, live, right now, rather than assuming.
//
// Checks, in order:
//   1. Is L029 even in SITELINK_LOCATIONS (if it's missing entirely, it would never be pulled at all).
//   2. What does snapshot_payload currently hold for L029 (daily/weekly/quarterly reservations)?
//   3. Fresh live InquiryTracking call for L029, yesterday's window -- does an "Activity" table exist,
//      how many rows, and do any have sRentalType="reservation" with a dPlaced inside yesterday? If
//      real reservation-stage activity exists but isn't being counted, that's still a bug. If there
//      genuinely isn't any, 0 is just the correct answer for a quiet day at a smaller site.
//
// Run:  node --env-file=.env scripts/probe-abingdon-snapshot-reservations.js
import { callReport, extractNamedTable } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';
import { admin } from '../lib/supabaseAdmin.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const SITE = 'L029';
const str = (v) => String(v ?? '').trim();

console.log(`${'='.repeat(90)}\nSTEP 1: is ${SITE} in SITELINK_LOCATIONS?\n${'='.repeat(90)}`);
const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
console.log(`SITELINK_LOCATIONS has ${locations.length} sites. ${SITE} present: ${locations.includes(SITE)}`);
if (!locations.includes(SITE)) {
  console.log(`*** ${SITE} is NOT in SITELINK_LOCATIONS -- it would never be pulled by anything, snapshot or main. This alone explains 0 everywhere for this site. ***`);
}

console.log(`\n${'='.repeat(90)}\nSTEP 2: current snapshot_payload for ${SITE}\n${'='.repeat(90)}`);
{
  const { data, error } = await admin.from('snapshot_payload').select('generated_at,payload').eq('id', 1).single();
  if (error) console.log(`Supabase error: ${error.message}`);
  else if (!data) console.log('No snapshot_payload row found at all.');
  else {
    console.log(`generated_at: ${data.generated_at}`);
    for (const period of ['daily', 'weekly', 'quarterly']) {
      const p = data.payload?.[period];
      if (!p) { console.log(`  ${period}: missing entirely from payload`); continue; }
      const site = (p.sites || []).find((s) => s.code === SITE);
      console.log(`  ${period} (${p.range?.start}..${p.range?.end}): ${site ? JSON.stringify(site) : `*** ${SITE} not found in sites[] at all (${p.sites?.length} sites present) ***`}`);
    }
  }
}

console.log(`\n${'='.repeat(90)}\nSTEP 3: fresh live InquiryTracking call for ${SITE}, yesterday's window\n${'='.repeat(90)}`);
{
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  console.log(`Window: ${yesterday.toISOString().slice(0, 10)} (yesterday only, matching the Daily period)`);
  const { rows, raw } = await callReport('InquiryTracking', SITE, yesterday, yesterday);
  console.log(`callReport's own extractRows() (biggest-table pick) returned: ${rows.length} row(s)`);
  const activityRows = extractNamedTable(raw, 'Activity');
  console.log(`extractNamedTable(raw, 'Activity') returned: ${activityRows.length} row(s)`);
  if (activityRows.length) {
    console.log(`Sample rows (dPlaced, sRentalType, sInquiryType):`);
    activityRows.slice(0, 10).forEach((r) => console.log(`  dPlaced=${r.dPlaced}  sRentalType=${r.sRentalType}  sInquiryType=${r.sInquiryType}`));
  }
  const parsed = REPORTS.lead_funnel.parse(rows, yesterday, yesterday, raw);
  console.log(`\nlead_funnel.parse() result for ${SITE}, yesterday: total_enquiries=${parsed.total_enquiries}, reservation_stage_count=${parsed.reservation_stage_count}`);

  // Also check a wider window (last 7 days) in case yesterday specifically was just quiet --
  // distinguishes "this site rarely gets reservations" from "something's broken every day".
  const weekAgo = new Date(yesterday); weekAgo.setDate(weekAgo.getDate() - 6);
  const { rows: wRows, raw: wRaw } = await callReport('InquiryTracking', SITE, weekAgo, yesterday);
  const wActivity = extractNamedTable(wRaw, 'Activity');
  const wParsed = REPORTS.lead_funnel.parse(wRows, weekAgo, yesterday, wRaw);
  console.log(`\nSame check over the last 7 days (${weekAgo.toISOString().slice(0, 10)}..${yesterday.toISOString().slice(0, 10)}): Activity table has ${wActivity.length} row(s), total_enquiries=${wParsed.total_enquiries}, reservation_stage_count=${wParsed.reservation_stage_count}`);
  if (wActivity.length) {
    const reservationRows = wActivity.filter((r) => str(r.sRentalType).toLowerCase() === 'reservation');
    console.log(`Reservation-stage rows (sRentalType="reservation") anywhere in that 7-day pull: ${reservationRows.length}`);
    reservationRows.slice(0, 10).forEach((r) => console.log(`  dPlaced=${r.dPlaced}  sRentalType=${r.sRentalType}`));
  }
}

console.log(`\n${'='.repeat(90)}\nIf STEP 3's Activity table is empty or has no reservation-stage rows even over 7\ndays, 0 is likely the genuinely correct answer for a quiet/small site -- not a bug.\nIf it shows real reservation-stage rows that parse() isn't counting, or if STEP 1/2\nturned up a missing-site issue, that pinpoints the actual fix needed.\n${'='.repeat(90)}`);
process.exit(0);
