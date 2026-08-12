import { admin } from '../lib/supabaseAdmin.js';
import { PORTAL_SITE_CODES, aggregateTotals, buildPayloadRange } from '../lib/buildPayload.js';
import { readCockpitData } from '../lib/cockpitData.js';
import { getFloorOccupancy } from '../lib/floorOccupancy.js';
import { buildPortalPayloadWriteRow, decodePortalPayloadStorageValue, readPortalPayload, buildHistoryPoint, summarizeHistoricalMonthlyCoverage } from '../lib/portalPayload.js';
import { REPORTS } from '../lib/reportMap.js';
import { readSnapshotPayloadFresh } from '../lib/snapshotPayload.js';
import { extractNamedTable, extractRows } from '../lib/sitelink.js';
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
const dayKeysBetween = (start, end) => {
  const out = [];
  for (const day = new Date(start); day.getTime() <= end.getTime(); day.setDate(day.getDate() + 1)) {
    out.push(formatLocalYmd(day));
  }
  return out;
};

const issues = [];
const warnings = [];
const checks = [];

async function withRetry(fn, attempts = 3, delayMs = 1500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function record(section, check, pass, details = null) {
  checks.push({ section, check, pass, details });
  if (!pass) issues.push({ section, check, details });
}

function warn(section, check, details = null) {
  checks.push({ section, check, pass: false, severity: 'warning', details });
  warnings.push({ section, check, details });
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

function monthEndDayKey(monthKey) {
  const [y, m] = String(monthKey || '').slice(0, 7).split('-').map(Number);
  if (!y || !m) return null;
  return `${monthKey}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
}

function sameCodeSet(rows) {
  return [...new Set((rows || []).map((row) => row?.code).filter(Boolean))].sort();
}

function normalizeTrueRevenueRows(rows) {
  return (rows || [])
    .map((row) => ({
      desc: row?.desc || '',
      invoiced: round2(row?.invoiced),
      taxInvoiced: round2(row?.taxInvoiced),
      taxAdj: round2(row?.taxAdj),
      netTax: round2(row?.netTax),
      deferred: round2(row?.deferred),
      deferredPrev: round2(row?.deferredPrev),
      adj: round2(row?.adj),
      adjPrev: round2(row?.adjPrev),
      truePeriod: round2(row?.truePeriod),
    }))
    .sort((a, b) => String(a.desc).localeCompare(String(b.desc)));
}

function normalizeRentalActivityRows(rows) {
  return (rows || [])
    .map((row) => ({
      type: row?.type || '',
      unitSize: row?.unitSize || '',
      totalUnits: Number(row?.totalUnits) || 0,
      occupied: Number(row?.occupied) || 0,
      vacant: Number(row?.vacant) || 0,
      occupiedArea: round2(row?.occupiedArea),
      totalArea: round2(row?.totalArea),
      grossPotential: round2(row?.grossPotential),
      occupiedRent: round2(row?.occupiedRent),
      occupiedDollarPerArea: round2(row?.occupiedDollarPerArea),
      totalDollarPerArea: round2(row?.totalDollarPerArea),
      movedIn: Number(row?.movedIn) || 0,
      movedOut: Number(row?.movedOut) || 0,
      transferred: Number(row?.transferred) || 0,
      netTransferred: Number(row?.netTransferred) || 0,
      net: Number(row?.net) || 0,
    }))
    .sort((a, b) => `${a.type}|${a.unitSize}`.localeCompare(`${b.type}|${b.unitSize}`));
}

function normalizeDiscountPlanRows(rows) {
  return (rows || [])
    .map((row) => ({
      plan: row?.plan || '',
      units: Number(row?.units) || 0,
      discount: round2(row?.discount),
    }))
    .sort((a, b) => String(a.plan).localeCompare(String(b.plan)));
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

async function latestRawReportIds(monthKey, reports) {
  const { data, error } = await retryOnStatementTimeout(async () => admin
    .from('raw_report')
    .select('id,site_code,report,pulled_at')
    .eq('month', monthKey)
    .in('report', reports)
    .order('pulled_at', { ascending: false }));
  if (error) throw new Error(error.message);
  const out = new Map();
  for (const row of data || []) {
    const key = `${row.site_code}|${row.report}`;
    if (!row?.id || out.has(key)) continue;
    out.set(key, row.id);
  }
  return out;
}

async function latestRawResponseMapByIds(idMap) {
  const out = new Map();
  const entries = [...idMap.entries()];
  const CHUNK_SIZE = 4;
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    const resolved = await Promise.all(chunk.map(async ([key, id]) => {
      const rawResponse = await withRetry(async () => {
        const { data, error } = await admin.from('raw_report').select('raw_response').eq('id', id).single();
        if (error) throw new Error(error.message);
        return data?.raw_response || null;
      });
      return [key, rawResponse];
    }));
    for (const [key, rawResponse] of resolved) out.set(key, rawResponse);
  }
  return out;
}

async function latestCurrentMonthRawPull(monthKey) {
  const { data, error } = await retryOnStatementTimeout(async () => admin
    .from('raw_report')
    .select('site_code,report,pulled_at')
    .eq('month', monthKey)
    .order('pulled_at', { ascending: false })
    .limit(1));
  if (error) throw new Error(error.message);
  return data?.[0] || null;
}

const now = new Date();
const currentMonthStart = reportingCurrentMonthStart(now);
const currentMonth = monthShort(currentMonthStart);
const currentMonthKey = `${currentMonth}-01`;
const currentMonthWindowStart = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth(), 1);
const currentMonthWindowEnd = lastCompleteDay(now);
const lastCompleteDayKey = formatLocalYmd(currentMonthWindowEnd);

const portal = await withTimeout(readPortalPayload(), 60000, 'stored portal payload read');
const payload = portal?.payload;
if (!payload?.sites?.length) {
  console.error(JSON.stringify({ ok: false, error: 'No usable stored portal payload returned' }, null, 2));
  process.exit(1);
}

record('portal', 'current_month matches reporting window', payload.current_month === currentMonth, {
  payloadCurrentMonth: payload.current_month,
  expectedCurrentMonth: currentMonth,
});
record('portal', 'stored payload has generated_at timestamp', !!(payload.generated_at || portal?.generatedAt), {
  generatedAt: payload.generated_at || portal?.generatedAt || null,
});
const latestCurrentRaw = await withTimeout(
  latestCurrentMonthRawPull(currentMonthKey),
  30000,
  'latest current-month raw_report freshness probe',
);
record('portal', 'current-month raw_report freshness probe returned a row', !!latestCurrentRaw, latestCurrentRaw || null);
if (latestCurrentRaw) {
  const generatedAt = payload.generated_at || portal?.generatedAt || null;
  const generatedAtMs = generatedAt ? new Date(generatedAt).getTime() : Number.NaN;
  const latestPulledAt = latestCurrentRaw.pulled_at || null;
  const latestPulledAtMs = latestPulledAt ? new Date(latestPulledAt).getTime() : Number.NaN;
  record(
    'portal',
    'stored payload generated_at is at or after the latest current-month raw_report pull',
    Number.isFinite(generatedAtMs) && Number.isFinite(latestPulledAtMs) && generatedAtMs >= latestPulledAtMs,
    {
      payloadGeneratedAt: generatedAt,
      latestRawPulledAt: latestPulledAt,
      latestRawSiteCode: latestCurrentRaw.site_code || null,
      latestRawReport: latestCurrentRaw.report || null,
      lagMinutes: Number.isFinite(generatedAtMs) && Number.isFinite(latestPulledAtMs)
        ? round2((latestPulledAtMs - generatedAtMs) / 60000)
        : null,
    },
  );
}

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

let explicitPrevRowsByCode = null;
if (payload.prev_month) {
  const [prevYear, prevMonthNum] = String(payload.prev_month).split('-').map(Number);
  const prevMonthStart = prevYear && prevMonthNum ? new Date(prevYear, prevMonthNum - 1, 1) : null;
  if (prevMonthStart) {
    const explicitPrev = await withTimeout(
      buildPayloadRange(prevMonthStart, prevMonthStart, { includeMonthly: true }),
      120000,
      'previous-month explicit parity rebuild',
    );
    const storedPrevRows = Array.isArray(payload.monthly?.[payload.prev_month]) ? payload.monthly[payload.prev_month] : [];
    const explicitPrevRows = Array.isArray(explicitPrev?.monthly?.[payload.prev_month]) ? explicitPrev.monthly[payload.prev_month] : [];
    const explicitByCode = new Map(explicitPrevRows.map((row) => [row?.code, row]));
    explicitPrevRowsByCode = explicitByCode;
    const prevMonthMismatches = [];
    for (const row of storedPrevRows) {
      const code = row?.code;
      const expected = explicitByCode.get(code);
      if (!code || !expected) {
        prevMonthMismatches.push({ code: code || null, field: 'row', actual: !!row, expected: !!expected });
        continue;
      }
      const checksToCompare = [
        ['occ', row?.occ, expected?.occ],
        ['tot', row?.tot, expected?.tot],
        ['occA', row?.occA, expected?.occA],
        ['totA', row?.totA, expected?.totA],
        ['rent', row?.rent, expected?.rent],
        ['moveIns', row?.moveIns, expected?.moveIns],
        ['moveOuts', row?.moveOuts, expected?.moveOuts],
        ['scheduledOuts', row?.scheduledOuts, expected?.scheduledOuts],
        ['reservationsMade', row?.reservationsMade, expected?.reservationsMade],
        ['activeReservations', row?.activeReservations, expected?.activeReservations],
        ['enquiries.total', row?.enquiries?.total, expected?.enquiries?.total],
        ['enquiries.reservationConversions', row?.enquiries?.reservationConversions, expected?.enquiries?.reservationConversions],
        ['enquiries.reservationConversionBase', row?.enquiries?.reservationConversionBase, expected?.enquiries?.reservationConversionBase],
        ['enquiries.phone', row?.enquiries?.phone, expected?.enquiries?.phone],
        ['enquiries.walkin', row?.enquiries?.walkin, expected?.enquiries?.walkin],
        ['enquiries.web', row?.enquiries?.web, expected?.enquiries?.web],
      ];
      for (const [field, actualValue, expectedValue] of checksToCompare) {
        if (round2(actualValue) !== round2(expectedValue)) {
          prevMonthMismatches.push({
            code,
            field,
            actual: round2(actualValue),
            expected: round2(expectedValue),
          });
        }
      }
    }
    record('history', 'stored payload previous-month slice matches an explicit raw_report rebuild for non-compacted fields', prevMonthMismatches.length === 0, {
      month: payload.prev_month,
      mismatches: prevMonthMismatches.slice(0, 100),
    });
    const explicitPrevRichDetailGaps = explicitPrevRows
      .filter((row) => (
        !Array.isArray(row?.trueRevenueByDesc)
        || !Array.isArray(row?.trueRevenueByType)
        || !Array.isArray(row?.rentalActivityByTypeSize)
        || !(row?.trueRevenueByDesc?.length || row?.trueRevenueByType?.length || row?.rentalActivityByTypeSize?.length)
      ))
      .map((row) => ({
        code: row?.code || null,
        trueRevenueByDesc: Array.isArray(row?.trueRevenueByDesc) ? row.trueRevenueByDesc.length : null,
        trueRevenueByType: Array.isArray(row?.trueRevenueByType) ? row.trueRevenueByType.length : null,
        rentalActivityByTypeSize: Array.isArray(row?.rentalActivityByTypeSize) ? row.rentalActivityByTypeSize.length : null,
      }));
    record('history', 'explicit previous-month live rebuild returns rich true-revenue and rental-activity detail', explicitPrevRichDetailGaps.length === 0, {
      month: payload.prev_month,
      gaps: explicitPrevRichDetailGaps,
    });
  }
}

try {
  const expectedSidecar = buildPortalPayloadWriteRow(payload, payload.generated_at || portal?.generatedAt || new Date().toISOString());
  const { data: sidecarRow, error: sidecarErr } = await retryOnStatementTimeout(async () => admin
    .from('portal_payload')
    .select('generated_at,current_month,current_slice,build_version,current_month_slice_version')
    .eq('id', 1)
    .maybeSingle());
  if (sidecarErr) throw new Error(sidecarErr.message);
  record('portal sidecar', 'current-slice sidecar row exists', !!sidecarRow, sidecarRow ? null : 'missing portal_payload row');
  if (sidecarRow) {
    record('portal sidecar', 'sidecar current_month matches live payload', sidecarRow.current_month === expectedSidecar.current_month, {
      actual: sidecarRow.current_month,
      expected: expectedSidecar.current_month,
    });
    record('portal sidecar', 'sidecar build_version matches live payload write row', String(sidecarRow.build_version || '') === String(expectedSidecar.build_version || ''), {
      actual: sidecarRow.build_version || null,
      expected: expectedSidecar.build_version || null,
    });
    record('portal sidecar', 'sidecar current_month_slice_version matches live payload write row', String(sidecarRow.current_month_slice_version || '') === String(expectedSidecar.current_month_slice_version || ''), {
      actual: sidecarRow.current_month_slice_version || null,
      expected: expectedSidecar.current_month_slice_version || null,
    });
    record('portal sidecar', 'sidecar current_slice is populated', !!sidecarRow.current_slice, {
      hasCurrentSlice: !!sidecarRow.current_slice,
    });
    if (sidecarRow.current_slice && expectedSidecar.current_slice) {
      const actualCurrentSlice = decodePortalPayloadStorageValue(sidecarRow.current_slice);
      const expectedCurrentSlice = decodePortalPayloadStorageValue(expectedSidecar.current_slice);
      const actualCodes = sameCodeSet(actualCurrentSlice?.sites || []);
      const expectedCodes = sameCodeSet(expectedCurrentSlice?.sites || []);
      record('portal sidecar', 'sidecar current-slice site set matches live payload write row', JSON.stringify(actualCodes) === JSON.stringify(expectedCodes), {
        actual: actualCodes,
        expected: expectedCodes,
      });
      const actualTotals = aggregateTotals(actualCurrentSlice?.sites || []);
      const expectedTotals = aggregateTotals(expectedCurrentSlice?.sites || []);
      compareNumber('portal sidecar', 'sidecar totals parity: occ', actualTotals?.occ, expectedTotals?.occ, 2);
      compareNumber('portal sidecar', 'sidecar totals parity: tot', actualTotals?.tot, expectedTotals?.tot, 2);
      compareNumber('portal sidecar', 'sidecar totals parity: reservationsMade', actualTotals?.reservationsMade, expectedTotals?.reservationsMade, 2);
      compareNumber('portal sidecar', 'sidecar totals parity: scheduledOuts', actualTotals?.scheduledOuts, expectedTotals?.scheduledOuts, 2);
    }
  }
} catch (error) {
  const message = error?.message || String(error);
  const missingSidecarColumns = /column portal_payload\.current_month does not exist|column .*current_slice.* does not exist/i.test(message);
  if (missingSidecarColumns) {
    warn('portal sidecar', 'optional portal sidecar columns are not installed', {
      error: message,
      whyItMatters: 'Current value correctness still passes without these columns because the portal falls back to the legacy payload row, but the sidecar improves small-current-slice recovery when the full stored payload read is under DB pressure.',
      smallestFix: 'Run supabase/portal-payload-sidecar-migration.sql against the live Supabase database, then rerun npm run check:audit.',
    });
  } else {
    record('portal sidecar', 'portal sidecar audit query completed', false, message);
  }
}

const rawMap = await withTimeout(
  latestRawReportMap(currentMonthKey, ['lead_funnel', 'move_ins_outs', 'scheduled_outs', 'insurance_roll', 'insurance_activity', 'marketing']),
  30000,
  'latest raw_report parity read',
);
const rawMismatches = [];
const rawCoverageGaps = [];
const freshCurrentParseMismatches = [];
for (const site of payload.sites) {
  const lfRow = rawMap.get(`${site.code}|lead_funnel`) || null;
  const mioRow = rawMap.get(`${site.code}|move_ins_outs`) || null;
  const soRow = rawMap.get(`${site.code}|scheduled_outs`) || null;
  const irRow = rawMap.get(`${site.code}|insurance_roll`) || null;
  const iaRow = rawMap.get(`${site.code}|insurance_activity`) || null;
  const mkRow = rawMap.get(`${site.code}|marketing`) || null;
  const lfRaw = lfRow?.raw_response || null;
  const mioRaw = mioRow?.raw_response || null;
  const soRaw = soRow?.raw_response || null;
  const irRaw = irRow?.raw_response || null;
  const iaRaw = iaRow?.raw_response || null;
  const mkRaw = mkRow?.raw_response || null;
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
  const actual = {
    enquiries: Number(site.enquiries?.total) || 0,
    reservationsMade: Number(site.reservationsMade) || 0,
    moveIns: Number(site.moveIns) || 0,
    moveOuts: Number(site.moveOuts) || 0,
  };
  const expected = { enquiries, reservationsMade, moveIns, moveOuts };
  const diffs = Object.fromEntries(
    Object.keys(expected)
      .filter((field) => round2(actual[field]) !== round2(expected[field]))
      .map((field) => [field, { actual: actual[field], expected: expected[field], delta: round2(actual[field] - expected[field]) }]),
  );
  if (Object.keys(diffs).length) rawMismatches.push({ code: site.code, name: site.name, diffs });

  if (!soRaw) rawCoverageGaps.push({ code: site.code, report: 'scheduled_outs' });
  if (!irRaw) rawCoverageGaps.push({ code: site.code, report: 'insurance_roll' });
  if (!iaRaw) rawCoverageGaps.push({ code: site.code, report: 'insurance_activity' });
  if (!mkRaw) rawCoverageGaps.push({ code: site.code, report: 'marketing' });
  const reparsedScheduledOuts = soRaw
    ? REPORTS.scheduled_outs.parse(extractRows(soRaw), currentMonthWindowStart, currentMonthWindowEnd, soRaw)
    : null;
  const reparsedInsuranceRoll = irRaw
    ? REPORTS.insurance_roll.parse(extractRows(irRaw), currentMonthWindowStart, currentMonthWindowEnd, irRaw)
    : null;
  const reparsedInsuranceActivity = iaRaw
    ? REPORTS.insurance_activity.parse(extractRows(iaRaw), currentMonthWindowStart, currentMonthWindowEnd, iaRaw)
    : null;
  const reparsedMarketing = mkRaw
    ? REPORTS.marketing.parse(extractRows(mkRaw), currentMonthWindowStart, currentMonthWindowEnd, mkRaw)
    : null;
  const freshActual = {
    scheduledOuts: Number(site.scheduledOuts) || 0,
    insuranceInsured: Number(site.insurance?.insured) || 0,
    insurancePremium: Number(site.insurance?.premium) || 0,
    insuredNewCustomersCount: Number(site.insuredNewCustomers?.count) || 0,
    insuredNewCustomersPremium: Number(site.insuredNewCustomers?.premiumSum) || 0,
    insuredNewCustomersCoverage: Number(site.insuredNewCustomers?.coverageSum) || 0,
    insuranceActivityNewPolicies: Number(site.insuranceActivity?.newPolicies) || 0,
    insuranceActivityNewPremium: Number(site.insuranceActivity?.newPremium) || 0,
    insuranceActivityCancellations: Number(site.insuranceActivity?.cancellations) || 0,
    marketingTenants: Number(site.marketing?.tenants) || 0,
    marketingCommercial: Number(site.marketing?.commercial) || 0,
    marketingResidential: Number(site.marketing?.residential) || 0,
    marketingAvgRent: Number(site.marketing?.avgRent) || 0,
  };
  const freshExpected = {
    scheduledOuts: Number(reparsedScheduledOuts?.scheduled_move_outs) || 0,
    insuranceInsured: Number(reparsedInsuranceRoll?.insured_units) || 0,
    insurancePremium: Number(reparsedInsuranceRoll?.monthly_premium) || 0,
    insuredNewCustomersCount: Number(reparsedInsuranceRoll?.insured_new_customers?.count) || 0,
    insuredNewCustomersPremium: Number(reparsedInsuranceRoll?.insured_new_customers?.premiumSum) || 0,
    insuredNewCustomersCoverage: Number(reparsedInsuranceRoll?.insured_new_customers?.coverageSum) || 0,
    insuranceActivityNewPolicies: Number(reparsedInsuranceActivity?.new_policies) || 0,
    insuranceActivityNewPremium: Number(reparsedInsuranceActivity?.new_premium) || 0,
    insuranceActivityCancellations: Number(reparsedInsuranceActivity?.cancellations) || 0,
    marketingTenants: Number(reparsedMarketing?.tenants) || 0,
    marketingCommercial: Number(reparsedMarketing?.commercial) || 0,
    marketingResidential: Number(reparsedMarketing?.residential) || 0,
    marketingAvgRent: Number(reparsedMarketing?.avg_rent) || 0,
  };
  const freshDiffs = Object.fromEntries(
    Object.keys(freshExpected)
      .filter((field) => round2(freshActual[field]) !== round2(freshExpected[field]))
      .map((field) => [field, { actual: freshActual[field], expected: freshExpected[field], delta: round2(freshActual[field] - freshExpected[field]) }]),
  );
  if (Object.keys(freshDiffs).length) freshCurrentParseMismatches.push({ code: site.code, name: site.name, diffs: freshDiffs });
}
record('raw parity', 'current-month core store metrics match raw_report through last complete day', rawMismatches.length === 0, {
  window: { start: currentMonthKey, end: lastCompleteDayKey },
  mismatches: rawMismatches,
});
record('raw parity', 'fresh raw_response exists for current-month scheduled-outs, insurance, and marketing reports', rawCoverageGaps.length === 0, rawCoverageGaps);
record('raw parity', 'current-month scheduled-outs, insurance, and marketing metrics match fresh raw_response reparses', freshCurrentParseMismatches.length === 0, {
  window: { start: currentMonthKey, end: lastCompleteDayKey },
  mismatches: freshCurrentParseMismatches,
});

// RentRoll raw_response rows are comparatively wide, and a single bulk current-month SELECT for both
// rent_roll and reservations has already proven prone to Supabase statement timeouts during the audit.
// Fetch just the latest ids first, then stream each raw_response one-by-one so the integrity check
// stays reliable under the same DB pressure the portal itself must survive.
const reservationRawIds = await withTimeout(
  latestRawReportIds(currentMonthKey, ['rent_roll', 'reservations']),
  30000,
  'reservation backlog raw_report id read',
);
const reservationRawMap = await withTimeout(
  latestRawResponseMapByIds(reservationRawIds),
  120000,
  'reservation backlog raw_report body read',
);
const reservationCoverageGaps = [];
const reservationBacklogMismatches = [];
for (const site of payload.sites) {
  const rrRaw = reservationRawMap.get(`${site.code}|rent_roll`) || null;
  const resRaw = reservationRawMap.get(`${site.code}|reservations`) || null;
  if (!rrRaw) reservationCoverageGaps.push({ code: site.code, report: 'rent_roll' });
  if (!resRaw) reservationCoverageGaps.push({ code: site.code, report: 'reservations' });
  if (!rrRaw || !resRaw) continue;
  const rr = REPORTS.rent_roll.parse(extractRows(rrRaw), currentMonthWindowStart, currentMonthWindowEnd, rrRaw);
  const res = REPORTS.reservations.parse(extractRows(resRaw), currentMonthWindowStart, currentMonthWindowEnd, resRaw);
  const occupiedIds = new Set(rr.occupied_tenant_ids || []);
  const activeReservations = Array.isArray(res.active_tenant_ids)
    ? res.active_tenant_ids.filter((id) => !occupiedIds.has(id)).length
    : (Number(res.active_reservations) || 0);
  const areaByType = Object.fromEntries((rr.unit_type_areas || []).map((row) => [String(row.unit_type_id), Number(row.avg_area) || 0]));
  const reservedSqftEstimate = Math.round(Object.entries(res.active_by_unit_type || {}).reduce((sum, [unitTypeId, tenantIds]) => {
    const count = Array.isArray(tenantIds) ? tenantIds.filter((id) => !occupiedIds.has(id)).length : (Number(tenantIds) || 0);
    return sum + count * (areaByType[String(unitTypeId)] || 0);
  }, 0));
  const actual = {
    activeReservations: Number(site.activeReservations) || 0,
    reservedSqftEstimate: Number(site.reservedSqftEstimate) || 0,
  };
  const expected = { activeReservations, reservedSqftEstimate };
  const diffs = Object.fromEntries(
    Object.keys(expected)
      .filter((field) => actual[field] !== expected[field])
      .map((field) => [field, { actual: actual[field], expected: expected[field], delta: actual[field] - expected[field] }]),
  );
  if (Object.keys(diffs).length) reservationBacklogMismatches.push({ code: site.code, name: site.name, diffs });
}
record('raw parity', 'fresh raw_response exists for current-month reservation backlog reports', reservationCoverageGaps.length === 0, reservationCoverageGaps);
record('raw parity', 'current-month reservation backlog metrics match fresh raw_response reparses', reservationBacklogMismatches.length === 0, reservationBacklogMismatches);

const finDiscountRawIds = await withTimeout(
  latestRawReportIds(currentMonthKey, ['financial', 'merchandise', 'discounts']),
  30000,
  'financial/discount raw_report id read',
);
const finDiscountRawMap = await withTimeout(
  latestRawResponseMapByIds(finDiscountRawIds),
  120000,
  'financial/discount raw_report body read',
);
const finDiscountCoverageGaps = [];
const finDiscountMismatches = [];
for (const site of payload.sites) {
  const finRaw = finDiscountRawMap.get(`${site.code}|financial`) || null;
  const meRaw = finDiscountRawMap.get(`${site.code}|merchandise`) || null;
  const discRaw = finDiscountRawMap.get(`${site.code}|discounts`) || null;
  if (!finRaw) finDiscountCoverageGaps.push({ code: site.code, report: 'financial' });
  if (!meRaw) finDiscountCoverageGaps.push({ code: site.code, report: 'merchandise' });
  if (!discRaw) finDiscountCoverageGaps.push({ code: site.code, report: 'discounts' });
  if (!finRaw || !meRaw || !discRaw) continue;
  const fin = REPORTS.financial.parse(extractRows(finRaw), currentMonthWindowStart, currentMonthWindowEnd, finRaw);
  const me = REPORTS.merchandise.parse(extractRows(meRaw), currentMonthWindowStart, currentMonthWindowEnd, meRaw);
  const disc = REPORTS.discounts.parse(extractRows(discRaw), currentMonthWindowStart, currentMonthWindowEnd, discRaw);
  const posCharge = (fin.categories || [])
    .filter((cat) => cat.category === 'POS')
    .reduce((sum, cat) => sum + (Number(cat.charge) || 0), 0);
  const actual = {
    revenueCollected: round2(site.revenue?.collected),
    revenueCharge: round2(site.revenue?.charge),
    revenuePayment: round2(site.revenue?.payment),
    revenueCredit: round2(site.revenue?.credit),
    revenueDiscount: round2(site.revenue?.discount),
    merchandiseSales: round2(site.merchandise?.sales),
    merchandiseCost: round2(site.merchandise?.cost),
    merchandiseMargin: round2(site.merchandise?.margin),
    merchandiseChargeFromFinancial: round2(site.merchandise?.chargeFromFinancial),
    discountUnitsTotal: Number(site.discountUnitsTotal) || 0,
    discountPlans: JSON.stringify(normalizeDiscountPlanRows(site.discountPlans)),
  };
  const expected = {
    revenueCollected: round2((Number(fin.total_charge) || 0) - (Number(fin.total_credit) || 0)),
    revenueCharge: round2(fin.total_charge),
    revenuePayment: round2(fin.total_payment),
    revenueCredit: round2(fin.total_credit),
    revenueDiscount: round2(fin.total_discount),
    merchandiseSales: round2(me.sales),
    merchandiseCost: round2(me.cost),
    merchandiseMargin: round2(me.margin),
    merchandiseChargeFromFinancial: round2(posCharge),
    discountUnitsTotal: Number(disc.discount_units_total) || 0,
    discountPlans: JSON.stringify(normalizeDiscountPlanRows(disc.discount_plans)),
  };
  const diffs = Object.fromEntries(
    Object.keys(expected)
      .filter((field) => actual[field] !== expected[field])
      .map((field) => [field, {
        actual: field === 'discountPlans' ? normalizeDiscountPlanRows(site.discountPlans) : actual[field],
        expected: field === 'discountPlans' ? normalizeDiscountPlanRows(disc.discount_plans) : expected[field],
      }]),
  );
  if (Object.keys(diffs).length) finDiscountMismatches.push({ code: site.code, name: site.name, diffs });
}
record('raw parity', 'fresh raw_response exists for current-month financial, merchandise, and discounts reports', finDiscountCoverageGaps.length === 0, finDiscountCoverageGaps);
record('raw parity', 'current-month financial, merchandise, and discount metrics match fresh raw_response reparses', finDiscountMismatches.length === 0, finDiscountMismatches);

const currentSliceSubstitutionMismatches = [];
if (payload.prev_month && explicitPrevRowsByCode?.size) {
  for (const site of payload.sites) {
    const prevRow = explicitPrevRowsByCode.get(site.code);
    if (!prevRow) continue;
    if (JSON.stringify(normalizeTrueRevenueRows(site.trueRevenueByDesc)) !== JSON.stringify(normalizeTrueRevenueRows(prevRow.trueRevenueByDesc))) {
      currentSliceSubstitutionMismatches.push({ code: site.code, field: 'trueRevenueByDesc' });
    }
    if (JSON.stringify(normalizeTrueRevenueRows(site.trueRevenueByType)) !== JSON.stringify(normalizeTrueRevenueRows(prevRow.trueRevenueByType))) {
      currentSliceSubstitutionMismatches.push({ code: site.code, field: 'trueRevenueByType' });
    }
    if (JSON.stringify(normalizeRentalActivityRows(site.rentalActivityByTypeSize)) !== JSON.stringify(normalizeRentalActivityRows(prevRow.rentalActivityByTypeSize))) {
      currentSliceSubstitutionMismatches.push({ code: site.code, field: 'rentalActivityByTypeSize' });
    }
  }
}
record('current slice policy', 'current-month true-revenue and rental-activity fields match the previous complete month live rebuild as intended', currentSliceSubstitutionMismatches.length === 0, {
  prevMonth: payload.prev_month || null,
  mismatches: currentSliceSubstitutionMismatches,
});

const autobillMonths = [...new Set([payload.current_month, payload.prev_month].filter(Boolean))];
if (autobillMonths.length) {
  const { data: autobillRows, error: autobillErr } = await retryOnStatementTimeout(async () => admin
    .from('autobill_daily')
    .select('site_code,month,sample_date,pct')
    .in('month', autobillMonths.map((mk) => `${mk}-01`)));
  if (autobillErr) throw new Error(autobillErr.message);
  const autobillMap = {};
  for (const row of autobillRows || []) {
    if (row?.pct == null) continue;
    const monthKey = String(row.month).slice(0, 7);
    const sampleDate = String(row.sample_date || '');
    const startDay = `${monthKey}-01`;
    const endDay = monthKey === payload.current_month ? lastCompleteDayKey : monthEndDayKey(monthKey);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sampleDate) || !endDay || sampleDate < startDay || sampleDate > endDay) continue;
    (((autobillMap[row.site_code] ??= {})[monthKey] ??= [])).push(Number(row.pct) || 0);
  }
  const autobillMismatches = [];
  const autobillSlices = [
    { month: payload.current_month, rows: payload.sites || [], label: 'current month' },
    { month: payload.prev_month, rows: payload.prev_month ? (payload.monthly?.[payload.prev_month] || []) : [], label: 'previous month' },
  ].filter((slice) => slice.month && Array.isArray(slice.rows) && slice.rows.length);
  for (const slice of autobillSlices) {
    for (const site of slice.rows) {
      const samples = autobillMap[site.code]?.[slice.month] || [];
      if (!samples.length || !(Number(site.autobillNewTotal) || 0)) continue;
      const expectedExact = samples.reduce((sum, pct) => sum + pct, 0) / samples.length / 100 * (Number(site.autobillNewTotal) || 0);
      const actualExact = Number(site.autobillNewCountExact ?? site.autobillNewCount) || 0;
      if (round2(actualExact) !== round2(expectedExact)) {
        autobillMismatches.push({
          month: slice.month,
          code: site.code,
          actualExact: round2(actualExact),
          expectedExact: round2(expectedExact),
          sampleCount: samples.length,
        });
      }
    }
  }
  record('autobill', 'payload autobill counts match window-filtered daily samples', autobillMismatches.length === 0, autobillMismatches.slice(0, 50));
}

const expectedDaily = formatLocalYmd(lastCompleteDay(now));

let snapshot = null;
try {
  snapshot = await withRetry(() => withTimeout(readSnapshotPayloadFresh(now), 60000, 'snapshot payload read'), 2, 3000);
} catch (error) {
  warn('snapshot', 'snapshot payload could be read for integrity checks', { error: error.message });
}
if (snapshot) {
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
}

let cockpit = null;
try {
  cockpit = await withRetry(() => withTimeout(readCockpitData(currentMonth), 60000, 'cockpit payload read'), 2, 3000);
} catch (error) {
  warn('cockpit', 'cockpit payload could be read for integrity checks', { error: error.message, month: currentMonth });
}
if (cockpit) {
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
    const expectedCockpitDays = dayKeysBetween(currentMonthStart, lastCompleteDay(now));
    const cockpitDates = new Set(cockpitCurve.map((point) => point?.date).filter(Boolean));
    const missingCockpitDates = expectedCockpitDays.filter((date) => !cockpitDates.has(date));
    record('cockpit', 'cockpit curve has one stored point for every complete day in scope', missingCockpitDates.length === 0, {
      missingDates: missingCockpitDates,
    });
  }
}

let floor = null;
try {
  floor = await withRetry(() => withTimeout(getFloorOccupancy(), 60000, 'floor occupancy read'), 2, 3000);
} catch (error) {
  warn('floor occupancy', 'floor occupancy payload could be read for integrity checks', { error: error.message });
}
if (floor) {
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
}

console.log(JSON.stringify({
  ok: issues.length === 0,
  currentMonth,
  lastCompleteDay: lastCompleteDayKey,
  checksRun: checks.length,
  issuesCount: issues.length,
  issues,
  warningsCount: warnings.length,
  warnings,
}, null, 2));
