import { admin } from '../lib/supabaseAdmin.js';
import { PORTAL_SITE_CODES, aggregateTotals } from '../lib/buildPayload.js';
import { readCockpitData } from '../lib/cockpitData.js';
import { getFloorOccupancy } from '../lib/floorOccupancy.js';
import { readPortalPayloadFreshCurrentMonth, buildHistoryPoint, summarizeHistoricalMonthlyCoverage } from '../lib/portalPayload.js';
import { REPORTS } from '../lib/reportMap.js';
import { readSnapshotPayloadFresh } from '../lib/snapshotPayload.js';
import { extractNamedTable } from '../lib/sitelink.js';
import { formatLocalYmd, lastCompleteDay, reportingCurrentMonthStart } from '../lib/reportingPeriod.js';
import { retryOnStatementTimeout } from '../lib/supabaseRetry.js';

const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const channelKey = (label) => String(label ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
const isVisibleMarketingChannel = (label) => ['phone', 'walkin', 'web'].includes(channelKey(label));
const dayKey = (value) => {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? null
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthShort = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

const issues = [];
const checks = [];

function record(section, check, pass, details = null) {
  checks.push({ section, check, pass, details });
  if (!pass) issues.push({ section, check, details });
}

function compareNumber(section, check, actual, expected, decimals = null) {
  const a = Number(actual) || 0;
  const e = Number(expected) || 0;
  const pass = decimals == null ? a === e : round2(a - e) === 0;
  record(section, check, pass, pass ? null : { actual: a, expected: e, delta: decimals == null ? a - e : round2(a - e) });
}

function sumRows(rows, field) {
  return rows.reduce((sum, row) => sum + (Number(row?.[field]) || 0), 0);
}

function sameCodeSet(rows) {
  return [...new Set((rows || []).map((row) => row?.code).filter(Boolean))].sort();
}

async function latestRawReportMap(monthKey, reports) {
  const { data, error } = await retryOnStatementTimeout(async () => admin
    .from('raw_report')
    .select('site_code,report,data,raw_response,pulled_at')
    .eq('month', monthKey)
    .in('report', reports)
    .order('pulled_at', { ascending: false }));
  if (error) throw new Error(error.message);
  const out = new Map();
  for (const row of data || []) {
    const key = `${row.site_code}|${row.report}`;
    if (out.has(key)) continue;
    out.set(key, row);
  }
  return out;
}

const now = new Date();
const currentMonthStart = reportingCurrentMonthStart(now);
const currentMonth = monthShort(currentMonthStart);
const currentMonthKey = `${currentMonth}-01`;
const lastCompleteDayKey = formatLocalYmd(lastCompleteDay(now));

const portal = await readPortalPayloadFreshCurrentMonth(now);
const payload = portal?.payload;
if (!payload?.sites?.length) {
  console.error(JSON.stringify({ ok: false, error: 'No usable live portal payload returned' }, null, 2));
  process.exit(1);
}

record('portal', 'current_month matches reporting window', payload.current_month === currentMonth, {
  payloadCurrentMonth: payload.current_month,
  expectedCurrentMonth: currentMonth,
});

const payloadCodes = sameCodeSet(payload.sites);
record('portal', 'site count matches configured store list', payload.sites.length === PORTAL_SITE_CODES.length, {
  actual: payload.sites.length,
  expected: PORTAL_SITE_CODES.length,
});
record('portal', 'current site code set matches configured store list', JSON.stringify(payloadCodes) === JSON.stringify(PORTAL_SITE_CODES), {
  actual: payloadCodes,
  expected: PORTAL_SITE_CODES,
});
record('portal', 'no duplicate current site codes', payloadCodes.length === payload.sites.length, {
  distinctCodes: payloadCodes.length,
  siteRows: payload.sites.length,
});
record('portal', 'no padded placeholder sites in current slice', !payload.sites.some((site) => site?.__padded_missing_site), {
  paddedCodes: payload.sites.filter((site) => site?.__padded_missing_site).map((site) => site.code),
});

const coverage = summarizeHistoricalMonthlyCoverage(payload, { excludeMonth: payload.current_month || null });
record('history', 'no incomplete stored historical months', coverage.incompleteMonths.length === 0, {
  incompleteMonths: [...coverage.incompleteMonths].sort(),
});

const recomputedTotals = aggregateTotals(payload.sites);
for (const field of [
  'n', 'occ', 'tot', 'occA', 'claA', 'totA', 'rent', 'gpot', 'grossOcc', 'occPC', 'areaPC', 'areaPCmla',
  'economicOccPct', 'claPC', 'rate', 'realRate', 'ssRate', 'ssReal', 'ssOcc', 'ssTot', 'ssOccPC',
  'officesOcc', 'officesTot', 'officesOccPC', 'debtorTenantPct', 'debtorRentRollPct', 'debtorTotal',
  'autobillNewCount', 'autobillNewCountExact', 'autobillNewTotal', 'autobillPC', 'stayDaysSum', 'stayCount',
  'avgStayDays', 'reservations', 'reservationsActive', 'scheduledOuts', 'reservationsNet',
  'reservationsMade', 'reservationsMadeNet', 'moveInAreaSum', 'moveOutAreaSum', 'moveInRateSum',
  'insurancePremium', 'insurancePctRoll', 'insurancePctInsured',
]) {
  compareNumber('totals', `aggregateTotals parity: ${field}`, payload.totals?.[field], recomputedTotals?.[field], 2);
}
for (const field of ['total', 'conversions', 'reservationConversions', 'reservationConversionBase', 'phone', 'walkin', 'web', 'webOnly', 'email']) {
  compareNumber('totals', `aggregateTotals parity: enquiries.${field}`, payload.totals?.enquiries?.[field], recomputedTotals?.enquiries?.[field], 2);
}

const badEnquirySites = [];
const badDebtorSites = [];
const impossibleSites = [];
for (const site of payload.sites) {
  const enquiries = site.enquiries || {};
  const visibleChannelTotal = (Number(enquiries.phone) || 0) + (Number(enquiries.walkin) || 0) + (Number(enquiries.web) || 0);
  if ((Number(enquiries.total) || 0) !== visibleChannelTotal || (Number(enquiries.reservationConversionBase) || 0) !== (Number(enquiries.total) || 0)) {
    badEnquirySites.push({
      code: site.code,
      total: Number(enquiries.total) || 0,
      phone: Number(enquiries.phone) || 0,
      walkin: Number(enquiries.walkin) || 0,
      web: Number(enquiries.web) || 0,
      reservationConversionBase: Number(enquiries.reservationConversionBase) || 0,
    });
  }
  const ageing = site.debtors?.ageing;
  if (ageing && typeof ageing === 'object') {
    const ageingSum = Object.values(ageing).reduce((sum, value) => sum + (Number(value) || 0), 0);
    const allOverdue = Number(site.debtors?.allOverdue) || 0;
    if (round2(ageingSum) !== round2(allOverdue)) {
      badDebtorSites.push({ code: site.code, ageingSum: round2(ageingSum), allOverdue: round2(allOverdue) });
    }
  }
  const impossible = [];
  if ((Number(site.occ) || 0) > (Number(site.tot) || 0)) impossible.push('occ>tot');
  if ((Number(site.occA) || 0) > (Number(site.totA) || 0)) impossible.push('occA>totA');
  for (const field of ['occ', 'tot', 'occA', 'claA', 'totA', 'rent', 'moveIns', 'moveOuts', 'scheduledOuts', 'reservationsMade', 'activeReservations', 'reservedSqftEstimate']) {
    if ((Number(site[field]) || 0) < 0) impossible.push(`${field}<0`);
  }
  if (impossible.length) impossibleSites.push({ code: site.code, impossible });
}
record('sites', 'visible enquiry channels sum to total for every site', badEnquirySites.length === 0, badEnquirySites);
record('sites', 'debtor ageing sums match allOverdue for every site', badDebtorSites.length === 0, badDebtorSites);
record('sites', 'no impossible negative or overflow occupancy values', impossibleSites.length === 0, impossibleSites);

const historyRows = Array.isArray(payload.history) ? payload.history : [];
const historyMismatches = [];
for (const row of historyRows) {
  const month = row?.month;
  const sites = Array.isArray(payload.monthly?.[month]) ? payload.monthly[month] : [];
  const expected = buildHistoryPoint(month, sites);
  for (const field of ['occ', 'tot', 'occPC', 'occA', 'rent', 'revenue', 'moveIns', 'moveOuts', 'insured', 'insurancePremium', 'enqTotal', 'enqReservationConversions', 'enqReservationConversionBase', 'enqPhone', 'enqWeb', 'enqWalkin']) {
    const actual = Number(row?.[field]) || 0;
    const wanted = Number(expected?.[field]) || 0;
    if (round2(actual) !== round2(wanted)) {
      historyMismatches.push({ month, field, actual: round2(actual), expected: round2(wanted) });
    }
  }
  const actualConv = row?.enqConvPct == null ? null : Number(row.enqConvPct);
  const expectedConv = expected?.enqConvPct == null ? null : Number(expected.enqConvPct);
  if (!(actualConv == null && expectedConv == null) && round2(actualConv) !== round2(expectedConv)) {
    historyMismatches.push({ month, field: 'enqConvPct', actual: actualConv, expected: expectedConv });
  }
}
record('history', 'stored history rows match stored monthly aggregates for non-rate fields', historyMismatches.length === 0, historyMismatches.slice(0, 50));

const rawMap = await latestRawReportMap(currentMonthKey, ['lead_funnel', 'move_ins_outs', 'scheduled_outs']);
const rawMismatches = [];
for (const site of payload.sites) {
  const lfRaw = rawMap.get(`${site.code}|lead_funnel`)?.raw_response || null;
  const mioRaw = rawMap.get(`${site.code}|move_ins_outs`)?.raw_response || null;
  const soData = rawMap.get(`${site.code}|scheduled_outs`)?.data || null;
  let enquiries = 0;
  let reservationsMade = 0;
  let moveIns = 0;
  let moveOuts = 0;
  if (lfRaw) {
    for (const row of extractNamedTable(lfRaw, 'Activity')) {
      const placedDay = dayKey(row?.dPlaced);
      if (placedDay && placedDay >= currentMonthKey && placedDay <= lastCompleteDayKey && isVisibleMarketingChannel(row?.sInquiryType)) {
        enquiries++;
      }
      const convertedDay = dayKey(row?.dConverted_ToRsv);
      if (
        String(row?.sRentalType ?? '').trim().toLowerCase() === 'reservation' &&
        isVisibleMarketingChannel(row?.sInquiryType) &&
        convertedDay &&
        convertedDay >= currentMonthKey &&
        convertedDay <= lastCompleteDayKey
      ) {
        reservationsMade++;
      }
    }
  }
  if (mioRaw) {
    for (const row of extractNamedTable(mioRaw, 'UnitMoveInsAndMoveOuts')) {
      const moveDay = dayKey(row?.MoveDate);
      if (!moveDay || moveDay < currentMonthKey || moveDay > lastCompleteDayKey) continue;
      if (yes(row?.MoveIn)) moveIns++;
      if (yes(row?.MoveOut)) moveOuts++;
    }
  }
  const scheduledOuts = Number(soData?.scheduled_move_outs) || 0;
  const actual = {
    enquiries: Number(site.enquiries?.total) || 0,
    reservationsMade: Number(site.reservationsMade) || 0,
    moveIns: Number(site.moveIns) || 0,
    moveOuts: Number(site.moveOuts) || 0,
    scheduledOuts: Number(site.scheduledOuts) || 0,
  };
  const expected = { enquiries, reservationsMade, moveIns, moveOuts, scheduledOuts };
  const diffs = Object.fromEntries(
    Object.keys(expected)
      .filter((field) => round2(actual[field]) !== round2(expected[field]))
      .map((field) => [field, { actual: actual[field], expected: expected[field], delta: round2(actual[field] - expected[field]) }]),
  );
  if (Object.keys(diffs).length) rawMismatches.push({ code: site.code, name: site.name, diffs });
}
record('raw parity', 'current-month core store metrics match raw_report through last complete day', rawMismatches.length === 0, {
  window: { start: currentMonthKey, end: lastCompleteDayKey },
  mismatches: rawMismatches,
});

const snapshot = await readSnapshotPayloadFresh(now);
const expectedDaily = formatLocalYmd(lastCompleteDay(now));
for (const period of ['daily', 'weekly', 'quarterly']) {
  const block = snapshot?.payload?.[period];
  record('snapshot', `${period} period exists`, !!block, block ? null : 'missing');
  if (!block) continue;
  const totals = block.totals || {};
  const sites = Array.isArray(block.sites) ? block.sites : [];
  compareNumber('snapshot', `${period} enquiries total equals sum of site rows`, totals.enquiries, sumRows(sites, 'enquiries'));
  compareNumber('snapshot', `${period} reservations total equals sum of site rows`, totals.reservations, sumRows(sites, 'reservations'));
  compareNumber('snapshot', `${period} moveIns total equals sum of site rows`, totals.moveIns, sumRows(sites, 'moveIns'));
  compareNumber('snapshot', `${period} moveOuts total equals sum of site rows`, totals.moveOuts, sumRows(sites, 'moveOuts'));
  compareNumber('snapshot', `${period} sqftIn total equals sum of site rows`, totals.sqftIn, sumRows(sites, 'sqftIn'), 2);
  compareNumber('snapshot', `${period} sqftOut total equals sum of site rows`, totals.sqftOut, sumRows(sites, 'sqftOut'), 2);
}
record('snapshot', 'daily snapshot ends on last complete day', snapshot?.payload?.daily?.range?.end === expectedDaily, {
  actual: snapshot?.payload?.daily?.range?.end,
  expected: expectedDaily,
});
record('snapshot', 'daily snapshot is a single-day range', snapshot?.payload?.daily?.range?.start === snapshot?.payload?.daily?.range?.end, snapshot?.payload?.daily?.range);

const cockpit = await readCockpitData(currentMonth);
record('cockpit', 'current-month cockpit payload is configured', Array.isArray(cockpit?.curve) && cockpit.curve.length > 0, {
  configuredDerivedFromCurve: Array.isArray(cockpit?.curve) && cockpit.curve.length > 0,
  complete: cockpit?.complete,
});
record('cockpit', 'current-month cockpit payload is complete', cockpit?.complete === true, {
  configured: cockpit?.configured,
  complete: cockpit?.complete,
});
const cockpitCurve = Array.isArray(cockpit?.curve) ? cockpit.curve : [];
record('cockpit', 'cockpit curve has at least one point', cockpitCurve.length > 0, {
  pointCount: cockpitCurve.length,
});
if (cockpitCurve.length) {
  const lastPoint = cockpitCurve[cockpitCurve.length - 1];
  record('cockpit', 'cockpit last point reaches last complete day', lastPoint?.date === lastCompleteDayKey, {
    actual: lastPoint?.date,
    expected: lastCompleteDayKey,
  });
  const badDates = cockpitCurve.filter((point, index) => {
    if (!point?.date) return true;
    if (!point.date.startsWith(`${currentMonth}-`)) return true;
    if (point.date > lastCompleteDayKey) return true;
    return index > 0 && cockpitCurve[index - 1]?.date >= point.date;
  });
  record('cockpit', 'cockpit curve dates are strictly increasing within the target month', badDates.length === 0, badDates);
}

const floor = await getFloorOccupancy();
record('floor occupancy', 'floor dataset is complete for all configured sites', floor?.complete === true, {
  complete: floor?.complete,
  missingSites: floor?.missing_sites,
});
const floorPortfolioTotals = {
  occupiedUnits: sumRows(floor?.floors || [], 'occupiedUnits'),
  totalUnits: sumRows(floor?.floors || [], 'totalUnits'),
};
compareNumber('floor occupancy', 'portfolio occupied units match portal totals', floorPortfolioTotals.occupiedUnits, payload.totals?.occ);
compareNumber('floor occupancy', 'portfolio total units match portal totals', floorPortfolioTotals.totalUnits, payload.totals?.tot);
const floorSiteMismatches = [];
for (const site of payload.sites) {
  const siteRows = floor?.site_floors?.[site.code] || [];
  const occUnits = sumRows(siteRows, 'occupiedUnits');
  const totalUnits = sumRows(siteRows, 'totalUnits');
  if (occUnits !== (Number(site.occ) || 0) || totalUnits !== (Number(site.tot) || 0)) {
    floorSiteMismatches.push({
      code: site.code,
      portalOcc: Number(site.occ) || 0,
      floorOcc: occUnits,
      portalTot: Number(site.tot) || 0,
      floorTot: totalUnits,
    });
  }
}
record('floor occupancy', 'per-site floor rollups match portal occupied and total units', floorSiteMismatches.length === 0, floorSiteMismatches);

console.log(JSON.stringify({
  ok: issues.length === 0,
  currentMonth,
  lastCompleteDay: lastCompleteDayKey,
  checksRun: checks.length,
  issuesCount: issues.length,
  issues,
}, null, 2));
