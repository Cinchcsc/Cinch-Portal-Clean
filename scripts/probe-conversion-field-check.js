// PROBE (20 Jul 2026), READ-ONLY — follow-up to probe-enquiry-reservation-gap.js. Site-scope
// (Bedford/Paulton) didn't explain the gap between our corrected June figure (14.5%) and legacy's
// (19.9%), and the enquiry-count side of the ratio runs BELOW legacy's own count (a known, accepted
// gap per reportMap.js) — which would push OUR ratio UP relative to legacy's if anything, not down.
// So the discrepancy almost certainly isn't the denominator (enquiries); it's the numerator
// (whatever legacy actually counts as "Converted").
//
// lib/reportMap.js's lead_funnel parser actually returns TWO different candidate numerators from the
// same InquiryTracking rows, already used for two DIFFERENT existing widgets:
//   - reservation_stage_count: rows where sRentalType === 'Reservation' (current numerator for THIS
//     widget, Enquiry -> Reservation)
//   - conversions (conv): rows where iInquiryConvertedToLease is true (used for the separate
//     "Enquiry -> Move-In" widget on the Dashboard)
// Legacy's own Marketing page shows a SEPARATE "Converted" column AND a separate "Move-Ins" column per
// channel card — two distinct metrics, exactly mirroring our two candidate fields. It's worth directly
// checking which of our two numerators actually lands closer to legacy's 19.9% June figure, in case
// "Enquiry -> Reservation" has simply been reading the wrong field of the two the whole time.
//
// This also dumps the distinct sRentalType values actually present in one site's raw June rows, in
// case 'Reservation' (exact match) is too narrow a filter and misses other stage values that should
// count too.
//
// Run: cd cinch-portal-clean && node --env-file=.env scripts/probe-conversion-field-check.js
import { admin } from '../lib/supabaseAdmin.js';
import { extractNamedTable } from '../lib/sitelink.js';
import { writeFileSync } from 'fs';

const JUNE_KEY = '2026-06-01';

const { data: rows, error } = await admin
  .from('raw_report').select('site_code,data,raw_response')
  .eq('month', JUNE_KEY).eq('report', 'lead_funnel');
if (error) { console.error('lead_funnel fetch failed:', error.message); process.exit(1); }

const perSite = (rows || []).map((r) => {
  let d = r.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
  return {
    site_code: r.site_code,
    total_enquiries: d?.total_enquiries ?? 0,
    reservation_stage_count: d?.reservation_stage_count ?? 0,
    conversions: d?.conversions ?? 0,
    channels: d?.channels ?? null,
  };
}).sort((a, b) => a.site_code.localeCompare(b.site_code));

function ratio(numKey) {
  const enqSum = perSite.reduce((a, s) => a + s.total_enquiries, 0);
  const numSum = perSite.reduce((a, s) => a + (s[numKey] || 0), 0);
  return { pct: enqSum ? +(numSum / enqSum * 100).toFixed(1) : null, num_sum: numSum, enq_sum: enqSum };
}

const byReservationStage = ratio('reservation_stage_count');
const byConversions = ratio('conversions');

// Per-channel breakdown using the `conversions`-style field (channels[x].converted is also
// iInquiryConvertedToLease-based) so it can be checked against legacy's own per-channel Converted %
// (Phone ~51%, Web ~15%, Walk-in ~68% today per the live browser read).
const channelTotals = {};
for (const s of perSite) {
  if (!s.channels) continue;
  for (const [label, v] of Object.entries(s.channels)) {
    const c = (channelTotals[label] ??= { enquiries: 0, converted: 0 });
    c.enquiries += v.enquiries || 0;
    c.converted += v.converted || 0;
  }
}
const channelPct = Object.fromEntries(Object.entries(channelTotals).map(([k, v]) => [k, v.enquiries ? +(v.converted / v.enquiries * 100).toFixed(1) : null]));

// Raw sRentalType distinct values, one site's raw June response, to check whether 'Reservation' alone
// (exact match) is too narrow a filter for what should count as reservation-stage.
let distinctRentalTypes = null;
const sample = (rows || []).find((r) => r.raw_response);
if (sample) {
  let raw = sample.raw_response; if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
  const activity = extractNamedTable(raw, 'Activity');
  if (activity.length) {
    const counts = {};
    for (const r of activity) { const t = r.sRentalType ?? '(none)'; counts[t] = (counts[t] || 0) + 1; }
    distinctRentalTypes = { sample_site: sample.site_code, row_count: activity.length, counts };
  }
}

const out = {
  probed_at: new Date().toISOString(),
  checked_month: JUNE_KEY,
  legacy_reference_today: { portfolio_converted_pct: 19.9, phone_converted_pct_approx: 51.1, web_converted_pct_approx: 14.6, walkin_converted_pct_approx: 67.8 },
  numerator_comparison: {
    reservation_stage_count_current_widget: byReservationStage,
    conversions_iInquiryConvertedToLease: byConversions,
  },
  channel_breakdown_using_conversions_field: channelPct,
  distinct_sRentalType_values_one_site: distinctRentalTypes,
  per_site: perSite,
};

const outPath = new URL('../../conversion-field-check-probe.json', import.meta.url);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath.pathname}`);
console.log(`\nJune portfolio ratio using reservation_stage_count (current widget): ${byReservationStage.pct}%  (${byReservationStage.num_sum}/${byReservationStage.enq_sum})`);
console.log(`June portfolio ratio using conversions/iInquiryConvertedToLease:        ${byConversions.pct}%  (${byConversions.num_sum}/${byConversions.enq_sum})`);
console.log(`Legacy today: 19.9% portfolio | Phone ~51.1% | Web ~14.6% | Walk-in ~67.8%`);
console.log(`\nPer-channel using the conversions field:`, JSON.stringify(channelPct));
if (distinctRentalTypes) console.log(`\nDistinct sRentalType values (${distinctRentalTypes.sample_site}):`, JSON.stringify(distinctRentalTypes.counts));
else console.log(`\n(raw_response not available/stored for these rows — skip sRentalType breakdown)`);
process.exit(0);
