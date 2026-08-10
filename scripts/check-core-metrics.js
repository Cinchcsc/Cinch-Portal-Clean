// Read-path audit helper: recomputes the core current-month flow metrics directly from raw_report
// and compares them against the live payload the portal would currently serve.
//
// Focus metrics:
//   - enquiries (visible Phone + Walk-in + Web only)
//   - reservationsMade (visible enquiries entering reservation stage in-window by dConverted_ToRsv)
//   - moveIns
//   - moveOuts
//
// Usage:
//   node --env-file=.env scripts/check-core-metrics.js
import { admin } from '../lib/supabaseAdmin.js';
import { readPortalPayloadFreshCurrentMonth } from '../lib/portalPayload.js';
import { extractNamedTable } from '../lib/sitelink.js';
import { formatLocalYmd, lastCompleteDay } from '../lib/reportingPeriod.js';
import { retryOnStatementTimeout } from '../lib/supabaseRetry.js';

const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const dayKey = (value) => {
  const raw = String(value ?? '').trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? null
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const channelKey = (label) => String(label ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
const isVisibleMarketingChannel = (label) => ['phone', 'walkin', 'web'].includes(channelKey(label));

const result = await readPortalPayloadFreshCurrentMonth();
const payload = result?.payload;
if (!payload?.sites?.length) {
  console.error('Fetch failed: no usable live payload');
  process.exit(1);
}

const monthShort = String(payload.current_month || '');
const monthKey = `${monthShort}-01`;
const windowStart = `${monthShort}-01`;
// Audit against the portal's CURRENT represented business day, not the payload row's write
// timestamp. A stored/generated_at value from Monday, July 27, 2026 can still be the newest row on
// Tuesday, July 28, 2026, while the live read path correctly represents Monday, July 27, 2026 as the
// latest complete day. Anchoring to generated_at would rewind the audit window by an extra day and
// falsely accuse the live payload of overcounting.
const windowEnd = formatLocalYmd(lastCompleteDay(new Date()));

const { data, error } = await retryOnStatementTimeout(async () => admin
  .from('raw_report')
  .select('site_code,report,raw_response,pulled_at')
  .eq('month', monthKey)
  .in('report', ['lead_funnel', 'move_ins_outs'])
  .order('pulled_at', { ascending: false }));
if (error) throw new Error(error.message);

const rawBySiteReport = new Map();
for (const row of data || []) {
  const key = `${row.site_code}|${row.report}`;
  if (!row?.raw_response || rawBySiteReport.has(key)) continue;
  rawBySiteReport.set(key, row.raw_response);
}

const mismatches = [];
for (const site of payload.sites) {
  const lfRaw = rawBySiteReport.get(`${site.code}|lead_funnel`);
  const mioRaw = rawBySiteReport.get(`${site.code}|move_ins_outs`);
  let enquiries = 0;
  let reservationsMade = 0;
  let moveIns = 0;
  let moveOuts = 0;

  if (lfRaw) {
    for (const row of extractNamedTable(lfRaw, 'Activity')) {
      const placedDay = dayKey(row?.dPlaced);
      if (placedDay && placedDay >= windowStart && placedDay <= windowEnd && isVisibleMarketingChannel(row?.sInquiryType)) {
        enquiries++;
      }
      const convertedDay = dayKey(row?.dConverted_ToRsv);
      if (
        String(row?.sRentalType ?? '').trim().toLowerCase() === 'reservation' &&
        isVisibleMarketingChannel(row?.sInquiryType) &&
        convertedDay &&
        convertedDay >= windowStart &&
        convertedDay <= windowEnd
      ) {
        reservationsMade++;
      }
    }
  }

  if (mioRaw) {
    for (const row of extractNamedTable(mioRaw, 'UnitMoveInsAndMoveOuts')) {
      const moveDay = dayKey(row?.MoveDate);
      if (!moveDay || moveDay < windowStart || moveDay > windowEnd) continue;
      if (yes(row?.MoveIn)) moveIns++;
      if (yes(row?.MoveOut)) moveOuts++;
    }
  }

  const live = {
    enquiries: Number(site.enquiries?.total) || 0,
    reservationsMade: Number(site.reservationsMade) || 0,
    moveIns: Number(site.moveIns) || 0,
    moveOuts: Number(site.moveOuts) || 0,
  };
  const raw = { enquiries, reservationsMade, moveIns, moveOuts };
  const diffs = Object.fromEntries(
    Object.keys(raw)
      .filter((key) => raw[key] !== live[key])
      .map((key) => [key, { raw: raw[key], live: live[key], delta: live[key] - raw[key] }]),
  );
  if (Object.keys(diffs).length) mismatches.push({ code: site.code, name: site.name, diffs });
}

console.log(JSON.stringify({
  current_month: monthShort,
  generated_at: result?.generatedAt || payload.generated_at || null,
  window: { start: windowStart, end: windowEnd },
  mismatchesCount: mismatches.length,
  mismatches,
}, null, 2));
