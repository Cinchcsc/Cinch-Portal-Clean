// Single shared reader for portal_payload — the one row of aggregated JSON that buildPayload.js
// writes and everything downstream (bootstrap.js legacy shim, the new /api/portfolio route, any
// future consumer) reads from. Do not duplicate this Supabase read elsewhere.
import { gzipSync, gunzipSync } from 'node:zlib';
import { admin } from './supabaseAdmin.js';
import { aggregateTotals, buildCurrentMonthPayload, buildPayloadRange, PORTAL_PAYLOAD_BUILD_VERSION, PORTAL_SITE_CODES, PORTAL_SITE_NAME_BY_CODE } from './buildPayload.js';
import { reportingCurrentMonthStart, reportingPreviousMonthStart } from './reportingPeriod.js';
import { retryOnStatementTimeout } from './supabaseRetry.js';

export const CURRENT_MONTH_SLICE_VERSION = '2026-07-27-live-current-v2';
const LIVE_CURRENT_RESULT_REUSE_MS = 5000;

let sharedLiveCurrentBuild = {
  monthKey: null,
  promise: null,
  result: null,
  resultAtMs: 0,
};
let sharedLatestCurrentMonthRaw = {
  monthKey: null,
  promise: null,
  value: null,
  valueAtMs: 0,
};
let sharedHistoricalRepair = {
  cacheKey: null,
  promise: null,
  result: null,
};

const inquiryChannelKey = (label) => String(label ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
const isVisibleMarketingChannel = (label) => {
  const k = inquiryChannelKey(label);
  return k === 'phone' || k === 'walkin' || k === 'web';
};
const NON_AREA_PRICED_RENTAL_ACTIVITY_TYPES = new Set(['Parking', 'Mailbox']);
const ZERO_DEBT_AGEING = { '0-10': 0, '11-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '121-180': 0, '181-360': 0, '361+': 0 };
const DEBT_AGEING_KEYS = Object.keys(ZERO_DEBT_AGEING);
const VALID_MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const COMPRESSED_PORTAL_PAYLOAD_PREFIX = 'gz:';
function isValidMonthKey(month) {
  if (!VALID_MONTH_KEY_RE.test(String(month || ''))) return false;
  const mm = Number(String(month).slice(5, 7));
  return Number.isInteger(mm) && mm >= 1 && mm <= 12;
}

function normalizeStoredRentalActivityRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => {
    if (!row || typeof row !== 'object') return false;
    const type = String(row.type || '').trim();
    if (NON_AREA_PRICED_RENTAL_ACTIVITY_TYPES.has(type)) return true;
    const area = Number(row.area) || 0;
    const totalArea = Number(row.totalArea) || 0;
    const occupiedArea = Number(row.occupiedArea) || 0;
    const vacantArea = Number(row.vacantArea) || 0;
    return area > 0 || totalArea > 0 || occupiedArea > 0 || vacantArea > 0;
  });
}

function compactStoredMonthlyRow(row) {
  if (!row || typeof row !== 'object') return row;
  const debtors = row.debtors && typeof row.debtors === 'object' ? row.debtors : null;
  const enquiries = row.enquiries && typeof row.enquiries === 'object' ? row.enquiries : null;
  const insurance = row.insurance && typeof row.insurance === 'object' ? row.insurance : null;
  const insuranceActivity = row.insuranceActivity && typeof row.insuranceActivity === 'object' ? row.insuranceActivity : null;
  const revenue = row.revenue && typeof row.revenue === 'object' ? row.revenue : null;
  const merchandise = row.merchandise && typeof row.merchandise === 'object' ? row.merchandise : null;
  const marketing = row.marketing && typeof row.marketing === 'object' ? row.marketing : null;
  const ss = row.ss && typeof row.ss === 'object' ? row.ss : null;
  const offices = row.offices && typeof row.offices === 'object' ? row.offices : null;
  return {
    __compact_monthly: true,
    __padded_missing_site: row.__padded_missing_site === true,
    name: row.name,
    code: row.code,
    occ: row.occ || 0,
    tot: row.tot || 0,
    occPC: row.occPC || 0,
    occA: row.occA || 0,
    claA: row.claA || 0,
    totA: row.totA || 0,
    areaPC: row.areaPC || 0,
    areaPCmla: row.areaPCmla || 0,
    rent: row.rent || 0,
    grossOcc: row.grossOcc || 0,
    gpot: row.gpot || 0,
    economicOccPct: row.economicOccPct || 0,
    rpu: row.rpu || 0,
    rate: row.rate || 0,
    realRate: row.realRate || 0,
    ssRate: row.ssRate || 0,
    ssReal: row.ssReal || 0,
    ss: {
      occ: ss?.occ || 0,
      tot: ss?.tot || 0,
      occPC: ss?.occPC || 0,
      occA: ss?.occA || 0,
      rent: ss?.rent || 0,
      gpot: ss?.gpot || 0,
      rate: ss?.rate || 0,
      real: ss?.real || 0,
    },
    offices: {
      occ: offices?.occ || 0,
      tot: offices?.tot || 0,
      occPC: offices?.occPC || 0,
      rate: offices?.rate || 0,
    },
    moveIns: row.moveIns || 0,
    moveOuts: row.moveOuts || 0,
    netArea: row.netArea || 0,
    scheduledOuts: row.scheduledOuts || 0,
    reservations: row.reservations || 0,
    reservationsMade: row.reservationsMade || 0,
    activeReservations: row.activeReservations || 0,
    debtors: {
      total: debtors?.total || 0,
      accounts: debtors?.accounts || 0,
      allOverdue: debtors?.allOverdue || 0,
      tenantPct: debtors?.tenantPct || 0,
      rentRollPct: debtors?.rentRollPct || 0,
      ageing: debtors?.ageing || null,
    },
    occActualRent: row.occActualRent || 0,
    insurance: {
      insured: insurance?.insured || 0,
      premium: insurance?.premium || 0,
      penetration: insurance?.penetration || 0,
    },
    insurancePremiumSum: row.insurancePremiumSum || 0,
    insuredUnitsSum: row.insuredUnitsSum || 0,
    insuranceActivity: {
      newPolicies: insuranceActivity?.newPolicies || 0,
      newPremium: insuranceActivity?.newPremium || 0,
      cancellations: insuranceActivity?.cancellations || 0,
    },
    enquiries: {
      total: enquiries?.total || 0,
      conversions: enquiries?.conversions || 0,
      reservationConversions: enquiries?.reservationConversions || 0,
      reservationConversionBase: enquiries?.reservationConversionBase || 0,
      phone: enquiries?.phone || 0,
      walkin: enquiries?.walkin || 0,
      web: enquiries?.web || 0,
      webOnly: enquiries?.webOnly ?? enquiries?.web ?? 0,
      email: enquiries?.email || 0,
      channels: enquiries?.channels || {},
    },
    merchandise: {
      chargeFromFinancial: merchandise?.chargeFromFinancial || 0,
    },
    revenue: {
      collected: revenue?.collected || 0,
      charge: revenue?.charge || 0,
      payment: revenue?.payment || 0,
      credit: revenue?.credit || 0,
      discount: revenue?.discount || 0,
      categories: revenue?.categories || [],
    },
    marketing: {
      tenants: marketing?.tenants ?? row.occ ?? 0,
    },
    unitTypes: Array.isArray(row.unitTypes) ? row.unitTypes : [],
    unitMix: Array.isArray(row.unitMix) ? row.unitMix : [],
  };
}

function normalizeStoredEnquiries(enquiries) {
  if (!enquiries || typeof enquiries !== 'object') return enquiries || null;
  const channels = enquiries.channels && typeof enquiries.channels === 'object' ? enquiries.channels : {};
  const visibleChannels = Object.entries(channels).filter(([label]) => isVisibleMarketingChannel(label));
  if (!visibleChannels.length) return enquiries;
  const derived = visibleChannels.reduce((acc, [label, row]) => {
    const key = inquiryChannelKey(label);
    const count = Number(row?.enquiries) || 0;
    const converted = Number(row?.converted) || 0;
    if (key === 'phone') acc.phone += count;
    else if (key === 'walkin') acc.walkin += count;
    else if (key === 'web') acc.web += count;
    acc.total += count;
    acc.converted += converted;
    return acc;
  }, { phone: 0, walkin: 0, web: 0, total: 0, converted: 0 });
  return {
    ...enquiries,
    phone: derived.phone,
    walkin: derived.walkin,
    web: derived.web,
    webOnly: derived.web,
    total: derived.total,
    reservationConversions: derived.converted,
    reservationConversionBase: derived.total,
    channels,
  };
}

function normalizeStoredSite(site) {
  if (!site || typeof site !== 'object') return site;
  const debtors = site.debtors && typeof site.debtors === 'object' ? site.debtors : null;
  const ageing = debtors?.ageing && typeof debtors.ageing === 'object' ? debtors.ageing : null;
  const zeroDebtAgeing = !ageing && (Number(debtors?.allOverdue) || 0) === 0 ? { ...ZERO_DEBT_AGEING } : ageing;
  const normalizedAgeing = zeroDebtAgeing
    ? DEBT_AGEING_KEYS.reduce((acc, key) => {
        acc[key] = Number(zeroDebtAgeing[key]) || 0;
        return acc;
      }, {})
    : zeroDebtAgeing;
  const normalizedDebtors = debtors
    ? {
        ...debtors,
        ageing: normalizedAgeing,
        allOverdue: normalizedAgeing
          ? Object.values(normalizedAgeing).reduce((sum, value) => sum + (Number(value) || 0), 0)
          : (Number(debtors.allOverdue) || 0),
      }
    : debtors;
  return {
    ...site,
    debtors: normalizedDebtors,
    enquiries: normalizeStoredEnquiries(site.enquiries),
    rentalActivityByTypeSize: normalizeStoredRentalActivityRows(site.rentalActivityByTypeSize),
  };
}

function makeZeroStoredSite(code) {
  const name = PORTAL_SITE_NAME_BY_CODE[code] || code;
  return {
    __padded_missing_site: true,
    name,
    code,
    occ: 0,
    tot: 0,
    occPC: 0,
    occA: 0,
    claA: 0,
    totA: 0,
    areaPC: 0,
    areaPCmla: 0,
    rent: 0,
    grossOcc: 0,
    gpot: 0,
    economicOccPct: 0,
    rpu: 0,
    rate: 0,
    realRate: 0,
    rentSum: 0,
    stdRentSum: 0,
    areaSum: 0,
    ssRentSum: 0,
    ssStdRentSum: 0,
    ssAreaSum: 0,
    adjRentSum: 0,
    ssAdjRentSum: 0,
    trueRevenueNumerator: 0,
    ssTrueRevenueNumerator: 0,
    areaTotalAll: 0,
    ssAreaTotalAll: 0,
    rentTruePeriod: 0,
    realRateArea: 0,
    realRateAreaSource: 'stored historical padding',
    ssRentTruePeriod: 0,
    ssRealArea: 0,
    trueRevenuePeriodDays: null,
    officesRentSum: 0,
    officesAreaSum: 0,
    ssRate: 0,
    ssReal: 0,
    ss: { occ: 0, tot: 0, occA: 0, rent: 0, gpot: 0, rate: 0, real: 0, occPC: 0 },
    offices: { occ: 0, tot: 0, rate: 0, occPC: 0 },
    autobillRate: 0,
    avgStayDays: 0,
    stayDaysSum: 0,
    stayCount: 0,
    stayRentSum: 0,
    autobillCount: 0,
    tenantsCount: 0,
    autobillNewCount: 0,
    autobillNewCountExact: 0,
    autobillNewTotal: 0,
    moveIns: 0,
    moveOuts: 0,
    netArea: 0,
    moveOutsYear: 0,
    moveInAreaSum: 0,
    moveInRateSum: 0,
    moveOutAreaSum: 0,
    scheduledOuts: 0,
    reservations: 0,
    reservationsMade: 0,
    activeReservations: 0,
    reservedSqftEstimate: 0,
    debtors: {
      total: 0,
      accounts: 0,
      allOverdue: 0,
      tenantPct: 0,
      rentRollPct: 0,
      ageing: { '0-10': 0, '11-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '121-180': 0, '181-360': 0, '361+': 0 },
    },
    occActualRent: 0,
    insurance: { insured: 0, premium: 0, penetration: 0 },
    insurancePremiumSum: 0,
    insuredUnitsSum: 0,
    insuranceActivity: { newPolicies: 0, newPremium: 0, cancellations: 0 },
    insuredNewCustomers: { count: 0, premiumSum: 0, coverageSum: 0 },
    enquiries: { total: 0, conversions: 0, reservationConversions: 0, reservationConversionBase: 0, phone: 0, walkin: 0, web: 0, webOnly: 0, email: 0, channels: {} },
    merchandise: { sales: 0, cost: 0, margin: 0, chargeFromFinancial: 0 },
    revenue: { charge: 0, payment: 0, credit: 0, discount: 0, collected: 0, categories: [] },
    rateChanges: { increases: 0, decreases: 0, avgPct: 0 },
    marketing: { tenants: 0, commercial: 0, residential: 0, avgRent: 0, sources: [] },
    occD: 0,
    rentD: 0,
    areaD: 0,
    unitTypes: [],
    unitMix: [],
    vacant: 0,
    unrentable: 0,
    customerType: {
      business: { units: 0, area: 0, rent: 0, pct: 0, rate: 0 },
      residential: { units: 0, area: 0, rent: 0, pct: 0, rate: 0 },
    },
    unitRows: [],
    trueRevenueByDesc: [],
    trueRevenueByType: [],
    rentalActivityByTypeSize: [],
    occByTypeSize: [],
    discountPlans: [],
    discountUnitsTotal: 0,
    moveInVarianceCount: 0,
    moveInVarianceSum: 0,
    moveInStdRateSum: 0,
    moveInVarStdRatePct: 0,
    moveInVarStdRateActualPct: null,
    varFromStdRate: [],
  };
}

function padStoredMonthlyRows(rows) {
  if (!Array.isArray(rows)) return rows;
  const normalized = rows.map(normalizeStoredSite);
  const seen = new Set(normalized.map((row) => row?.code).filter(Boolean));
  const padded = [...normalized];
  for (const code of PORTAL_SITE_CODES) {
    if (!seen.has(code)) padded.push(makeZeroStoredSite(code));
  }
  return padded.sort((a, b) => String(a?.code || '').localeCompare(String(b?.code || '')));
}

function normalizeStoredPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const sites = Array.isArray(payload.sites) ? padStoredMonthlyRows(payload.sites) : payload.sites;
  const monthly = payload.monthly && typeof payload.monthly === 'object'
    ? Object.fromEntries(
        Object.entries(payload.monthly)
          .filter(([month]) => isValidMonthKey(month))
          .map(([month, rows]) => [
            month,
            padStoredMonthlyRows(rows),
          ]),
      )
    : payload.monthly;
  const monthlyFullyUsable = !!(monthly && typeof monthly === 'object' && Object.values(monthly).every((rows) => Array.isArray(rows)));
  const payloadMonths = Array.isArray(payload.months)
    ? payload.months.filter(isValidMonthKey).sort()
    : [];
  const normalizedMonths = payloadMonths.length
    ? payloadMonths
    : (monthlyFullyUsable ? Object.keys(monthly).sort() : payload.months);
  const payloadHistory = Array.isArray(payload.history)
    ? payload.history
        .filter((row) => isValidMonthKey(row?.month))
        .sort((a, b) => String(a?.month || '').localeCompare(String(b?.month || '')))
    : null;
  // Continued audit hardening (10 Aug 2026): `history` is a pure derived summary of `monthly`, but
  // older stored payload rows can carry a stale history schema long after the per-store monthly rows
  // already contain newer fields (for example enquiry history existed in `monthly` for 70 months while
  // `history` still omitted it, breaking MoM/YoY trends without marking the payload incomplete).
  // When monthly rows are available, rebuild history from them on read instead of trusting the older
  // stored derived array.
  const history = monthlyFullyUsable
    ? (() => {
        const historyByMonth = new Map((payloadHistory || []).map((row) => [row?.month, row]));
        return normalizedMonths
          .filter((month) => Array.isArray(monthly?.[month]))
          .map((month) => buildReadableHistoryPoint(month, monthly[month], historyByMonth.get(month)));
      })()
    : (payloadHistory?.length ? payloadHistory : payload.history);
  const totals = Array.isArray(sites) ? aggregateTotals(sites) : payload.totals;
  return {
    ...payload,
    build_version: payload.build_version || PORTAL_PAYLOAD_BUILD_VERSION,
    current_month_slice_version: payload.current_month_slice_version || null,
    months: normalizedMonths,
    sites,
    monthly,
    history,
    totals,
  };
}

export function normalizePortalPayloadForStorage(payload) {
  if (!payload || typeof payload !== 'object') return normalizeStoredPayload(payload);
  const allMonths = Array.isArray(payload.months)
    ? payload.months.filter(isValidMonthKey).sort()
    : Object.keys(payload.monthly || {}).filter(isValidMonthKey).sort();
  const trimmedMonthly = payload.monthly && typeof payload.monthly === 'object'
    ? Object.fromEntries(
        allMonths
          .filter((month) => Array.isArray(payload.monthly?.[month]))
          .map((month) => [month, payload.monthly[month].map(compactStoredMonthlyRow)]),
      )
    : payload.monthly;
  const normalized = normalizeStoredPayload({
    ...payload,
    months: allMonths,
    monthly: trimmedMonthly,
    history: Array.isArray(payload.history) ? payload.history : payload.history,
  });
  return `${COMPRESSED_PORTAL_PAYLOAD_PREFIX}${gzipSync(Buffer.from(JSON.stringify(normalized), 'utf8')).toString('base64')}`;
}

function decodeStoredPortalPayload(payload) {
  if (typeof payload === 'string' && payload.startsWith(COMPRESSED_PORTAL_PAYLOAD_PREFIX)) {
    const encoded = payload.slice(COMPRESSED_PORTAL_PAYLOAD_PREFIX.length);
    return JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'));
  }
  if (typeof payload === 'string') return JSON.parse(payload);
  return payload;
}

async function fetchPortalPayloadRow() {
  return retryOnStatementTimeout(async () => {
    const { data, error } = await admin
      .from('portal_payload')
      .select('payload,generated_at')
      .eq('id', 1)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data?.payload ? data : null;
  });
}

export async function readPortalPayload() {
  const data = await fetchPortalPayloadRow();
  if (!data?.payload) return null;

  const rawPayload = decodeStoredPortalPayload(data.payload);
  const payload = {
    ...normalizeStoredPayload(rawPayload),
    generated_at: data.generated_at || null,
  };
  return { payload, rawPayload, generatedAt: data.generated_at };
}

export function buildHistoryPoint(month, sites) {
  const sum = (get) => sites.reduce((acc, site) => acc + (get(site) || 0), 0);
  const occ = sum((site) => site.occ);
  const tot = sum((site) => site.tot);
  const occA = sum((site) => site.occA);
  const ssOccA = sum((site) => site.ss?.occA);
  const rent = sum((site) => site.rent);
  const areaSum = sum((site) => site.areaSum);
  const ssAreaSum = sum((site) => site.ssAreaSum);
  const adjRentSum = sum((site) => site.adjRentSum);
  const ssAdjRentSum = sum((site) => site.ssAdjRentSum);
  const enqTotal = sum((site) => site.enquiries?.total);
  const enqReservationConversions = sum((site) => site.enquiries?.reservationConversions);
  const enqReservationConversionBase = sum((site) => site.enquiries?.reservationConversionBase ?? site.enquiries?.total);
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  return {
    month,
    occ,
    tot,
    occPC: tot ? +(occ / tot * 100).toFixed(1) : 0,
    occA,
    rent,
    ssOccA,
    rate: areaSum ? round2(adjRentSum / areaSum * 12) : 0,
    ssRate: ssAreaSum ? round2(ssAdjRentSum / ssAreaSum * 12) : 0,
    revenue: sum((site) => site.revenue?.collected),
    moveIns: sum((site) => site.moveIns),
    moveOuts: sum((site) => site.moveOuts),
    insured: sum((site) => site.insurance?.insured),
    insurancePremium: sum((site) => site.insurancePremiumSum),
    enqTotal,
    enqReservationConversions,
    enqReservationConversionBase,
    enqPhone: sum((site) => site.enquiries?.phone),
    enqWeb: sum((site) => site.enquiries?.web),
    enqWalkin: sum((site) => site.enquiries?.walkin),
    enqConvPct: enqReservationConversionBase ? +(enqReservationConversions / enqReservationConversionBase * 100).toFixed(1) : null,
  };
}

function buildReadableHistoryPoint(month, sites, existing = null) {
  const derived = buildHistoryPoint(month, sites);
  if (!existing || typeof existing !== 'object') return derived;
  return {
    ...existing,
    ...derived,
    // Compact stored monthly rows omit the raw rate-building components (areaSum/adjRentSum), so a
    // read-time rebuild can enrich stale history fields like enquiries/move-outs while still
    // preserving already-correct stored rate history instead of collapsing it to zero.
    rate: derived.rate || Number(existing.rate) || 0,
    ssRate: derived.ssRate || Number(existing.ssRate) || 0,
  };
}

export function isPortalPayloadShapeUsable(payload) {
  return !!(
    payload &&
    Array.isArray(payload.months) &&
    payload.monthly &&
    typeof payload.monthly === 'object' &&
    Array.isArray(payload.history)
  );
}

function hasReadablePortalCurrentSlice(payload) {
  return !!(
    payload &&
    Array.isArray(payload.sites) &&
    payload.totals &&
    !payload.sites.some((site) => site?.__padded_missing_site)
  );
}

function hasRichPortalCurrentSlice(payload) {
  if (!hasReadablePortalCurrentSlice(payload)) return false;
  return payload.sites.every((site) => (
    site &&
    Object.prototype.hasOwnProperty.call(site, 'reservationsMade') &&
    Object.prototype.hasOwnProperty.call(site, 'activeReservations') &&
    Object.prototype.hasOwnProperty.call(site, 'reservedSqftEstimate') &&
    Object.prototype.hasOwnProperty.call(site, 'moveInVarianceCount') &&
    Object.prototype.hasOwnProperty.call(site, 'moveInStdRateSum') &&
    Object.prototype.hasOwnProperty.call(site, 'autobillNewCountExact') &&
    Array.isArray(site.trueRevenueByDesc) &&
    Array.isArray(site.trueRevenueByType) &&
    Array.isArray(site.occByTypeSize) &&
    Array.isArray(site.discountPlans) &&
    Array.isArray(site.varFromStdRate) &&
    Array.isArray(site.rentalActivityByTypeSize) &&
    site.enquiries &&
    Object.prototype.hasOwnProperty.call(site.enquiries, 'reservationConversionBase') &&
    Object.prototype.hasOwnProperty.call(site.enquiries, 'reservationConversions')
  ));
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function hasNestedOwn(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (!hasOwn(cur, key)) return false;
    cur = cur[key];
  }
  return true;
}

function hasUsableDebtorAgeing(row) {
  const ageing = row?.debtors?.ageing;
  if ((!ageing || typeof ageing !== 'object') && (Number(row?.debtors?.allOverdue) || 0) === 0) return true;
  if (!ageing || typeof ageing !== 'object') return false;
  const normalizedKeys = ['0-10', '11-30', '31-60', '61-90', '91-120', '121-180', '181-360', '361+'];
  const fallbackKeys = ['1-30', '31-60', '61-90', '91-120', '121-180', '181-360', '361+'];
  return normalizedKeys.every((key) => ageing[key] != null)
    || fallbackKeys.every((key) => ageing[key] != null);
}

export function historicalMonthNeedsRepair(rows) {
  return historicalMonthNeedsRepairForMonth(rows, null, null);
}

function firstRealMonthByCodeFromPayload(payload) {
  const out = new Map();
  const monthlyEntries = payload?.monthly && typeof payload.monthly === 'object'
    ? Object.entries(payload.monthly)
        .filter(([month, rows]) => isValidMonthKey(month) && Array.isArray(rows))
        .sort(([a], [b]) => a.localeCompare(b))
    : [];
  for (const [month, rows] of monthlyEntries) {
    for (const row of rows) {
      const code = row?.code;
      if (!code || row?.__padded_missing_site) continue;
      if (!out.has(code)) out.set(code, month);
    }
  }
  return out;
}

function expectedHistoricalCodesForMonth(month, firstRealMonthByCode) {
  if (!isValidMonthKey(month) || !(firstRealMonthByCode instanceof Map) || !firstRealMonthByCode.size) {
    return new Set(PORTAL_SITE_CODES);
  }
  const expected = new Set();
  for (const code of PORTAL_SITE_CODES) {
    const firstMonth = firstRealMonthByCode.get(code);
    if (!firstMonth || firstMonth <= month) expected.add(code);
  }
  return expected;
}

function historicalMonthNeedsStructuralRepairForMonth(rows, month, firstRealMonthByCode) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const expectedCodes = expectedHistoricalCodesForMonth(month, firstRealMonthByCode);
  const codes = new Set(rows.map((row) => row?.code).filter(Boolean));
  for (const code of expectedCodes) {
    if (!codes.has(code)) return true;
  }
  return rows.some((row) => row?.__padded_missing_site && expectedCodes.has(row?.code));
}

function historicalMonthNeedsRepairForMonth(rows, month, firstRealMonthByCode) {
  if (historicalMonthNeedsStructuralRepairForMonth(rows, month, firstRealMonthByCode)) return true;
  for (const row of rows) {
    if (!row || typeof row !== 'object') return true;
    const e = row?.enquiries;
    const impossibleLeadShape =
      (e?.reservationConversions || 0) > 0 &&
      (e?.reservationConversionBase || 0) === 0 &&
      (e?.total || 0) === 0 &&
      (e?.phone || 0) === 0 &&
      (e?.walkin || 0) === 0 &&
      ((e?.webOnly ?? e?.web ?? 0) === 0) &&
      !(e?.channels && Object.keys(e.channels).length);
    const missingDebtorSummary =
      !hasNestedOwn(row, ['debtors', 'total']) ||
      !hasNestedOwn(row, ['debtors', 'accounts']) ||
      !hasNestedOwn(row, ['debtors', 'allOverdue']);
    const missingRichHistoricalFields = (
      !hasOwn(row, 'reservationsMade') ||
      !hasOwn(row, 'activeReservations') ||
      missingDebtorSummary ||
      !hasNestedOwn(row, ['revenue', 'credit']) ||
      !hasNestedOwn(row, ['merchandise', 'chargeFromFinancial'])
    );
    if (impossibleLeadShape || missingRichHistoricalFields) return true;
  }
  return false;
}

export function summarizeHistoricalMonthlyCoverage(payload, { excludeMonth = null } = {}) {
  if (!payload || typeof payload !== 'object') {
    return { missingMonths: [], repairMonths: [], incompleteMonths: [] };
  }
  const payloadMonths = Array.isArray(payload.months)
    ? payload.months.filter(isValidMonthKey).sort()
    : [];
  const monthlyEntries = payload.monthly && typeof payload.monthly === 'object'
    ? Object.entries(payload.monthly).filter(([month]) => isValidMonthKey(month))
    : [];
  const monthlyKeys = monthlyEntries.map(([month]) => month).sort();
  const firstRealMonthByCode = firstRealMonthByCodeFromPayload(payload);
  const excluded = isValidMonthKey(excludeMonth) ? excludeMonth : null;
  const missingMonths = payloadMonths
    .filter((month) => month !== excluded && !monthlyKeys.includes(month));
  const repairMonths = monthlyEntries
    .filter(([month, rows]) => month !== excluded && Array.isArray(rows) && rows.length && historicalMonthNeedsStructuralRepairForMonth(rows, month, firstRealMonthByCode))
    .map(([month]) => month)
    .sort();
  const incompleteMonths = [...new Set([...missingMonths, ...repairMonths])].sort();
  return { missingMonths, repairMonths, incompleteMonths };
}

function newerTimestamp(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();
  if (!Number.isFinite(aMs)) return b || null;
  if (!Number.isFinite(bMs)) return a || null;
  return aMs >= bMs ? a : b;
}

function analyzeStoredHistoryForRead(payload) {
  return summarizeHistoricalMonthlyCoverage(payload).repairMonths;
}

function contiguousMonthSpans(months) {
  if (!months?.length) return [];
  const out = [];
  let start = months[0];
  let prev = months[0];
  const nextMonthKey = (mk) => {
    const [y, m] = String(mk || '').split('-').map(Number);
    const d = new Date(y, m, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  for (let i = 1; i < months.length; i++) {
    if (nextMonthKey(prev) === months[i]) {
      prev = months[i];
      continue;
    }
    out.push({ start, end: prev });
    start = prev = months[i];
  }
  out.push({ start, end: prev });
  return out;
}

function splitSpanIntoChunks({ start, end }, maxMonths = 2) {
  const parseMonthKey = (mk) => {
    const [y, m] = String(mk || '').split('-').map(Number);
    return (y && m) ? { year: y, month: m } : null;
  };
  const monthKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;
  const addMonths = (year, month, delta) => {
    const d = new Date(Date.UTC(year, month - 1 + delta, 1));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  };
  const compareMonthKeys = (a, b) => String(a || '').localeCompare(String(b || ''));
  const out = [];
  const startParts = parseMonthKey(start);
  const endParts = parseMonthKey(end);
  if (!startParts || !endParts) return out;
  let cur = monthKey(startParts.year, startParts.month);
  const finalKey = monthKey(endParts.year, endParts.month);
  while (compareMonthKeys(cur, finalKey) <= 0) {
    const chunkStartParts = parseMonthKey(cur);
    const rawChunkEndParts = addMonths(chunkStartParts.year, chunkStartParts.month, maxMonths - 1);
    const rawChunkEnd = monthKey(rawChunkEndParts.year, rawChunkEndParts.month);
    const chunkEnd = compareMonthKeys(rawChunkEnd, finalKey) > 0 ? finalKey : rawChunkEnd;
    const chunkEndParts = parseMonthKey(chunkEnd);
    out.push({
      start: new Date(chunkStartParts.year, chunkStartParts.month - 1, 1),
      end: new Date(chunkEndParts.year, chunkEndParts.month - 1, 1),
    });
    const next = addMonths(chunkEndParts.year, chunkEndParts.month, 1);
    cur = monthKey(next.year, next.month);
  }
  return out;
}

async function repairStoredHistoricalSlicesForRead(payload) {
  const repairMonths = analyzeStoredHistoryForRead(payload);
  if (!repairMonths.length) return payload;
  const repairedMonthly = {};
  const chunks = contiguousMonthSpans(repairMonths).flatMap((span) => splitSpanIntoChunks(span, 2));
  for (const chunk of chunks) {
    const rebuilt = await buildPayloadRange(chunk.start, chunk.end, { includeMonthly: true });
    Object.assign(repairedMonthly, rebuilt.monthly || {});
  }
  const monthly = { ...(payload.monthly || {}), ...repairedMonthly };
  const months = [...new Set([...(payload.months || []), ...Object.keys(monthly)])].sort();
  const historyByMonth = new Map((Array.isArray(payload.history) ? payload.history : []).map((row) => [row?.month, row]));
  for (const month of Object.keys(repairedMonthly)) {
    historyByMonth.set(month, buildHistoryPoint(month, monthly[month] || []));
  }
  return {
    ...payload,
    build_version: PORTAL_PAYLOAD_BUILD_VERSION,
    monthly,
    months,
    history: [...historyByMonth.values()]
      .filter((row) => row?.month)
      .sort((a, b) => String(a?.month || '').localeCompare(String(b?.month || ''))),
  };
}

async function getSharedStoredHistoricalRepair(payload, generatedAt, excludeMonth = null) {
  const repairMonths = summarizeHistoricalMonthlyCoverage(payload, { excludeMonth }).repairMonths;
  if (!repairMonths.length) return payload;
  const cacheKey = JSON.stringify({
    generatedAt: generatedAt || null,
    buildVersion: payload?.build_version || null,
    excludeMonth: excludeMonth || null,
    repairMonths,
  });
  if (sharedHistoricalRepair.cacheKey === cacheKey && sharedHistoricalRepair.result) {
    return sharedHistoricalRepair.result;
  }
  if (sharedHistoricalRepair.cacheKey === cacheKey && sharedHistoricalRepair.promise) {
    return sharedHistoricalRepair.promise;
  }
  const promise = repairStoredHistoricalSlicesForRead(payload)
    .then((result) => {
      if (sharedHistoricalRepair.cacheKey === cacheKey) {
        sharedHistoricalRepair.result = result;
      }
      return result;
    })
    .finally(() => {
      if (sharedHistoricalRepair.cacheKey === cacheKey) {
        sharedHistoricalRepair.promise = null;
      }
    });
  sharedHistoricalRepair = {
    cacheKey,
    promise,
    result: null,
  };
  return promise;
}

// Production hardening (28 Jul 2026, continued audit): the read path can now do two kinds of
// correctness repair before returning default /api/portfolio data:
//   1. in-memory repair of any known-bad historical stored slices, and
//   2. a live current-month build/merge from raw_report.
// Under ordinary conditions that still completes comfortably, but a 15s local cap proved too short
// during validation and caused the portal to fall back to stale stored current-month data even though
// the underlying reads were still healthy and the route itself has a 300s budget. Prefer a slightly
// slower but correct response over a premature stale fallback.
const LIVE_CURRENT_READ_TIMEOUT_MS = 90000;

function liveCurrentMonthKey(currentMonthStart) {
  return `${currentMonthStart.getFullYear()}-${String(currentMonthStart.getMonth() + 1).padStart(2, '0')}`;
}

async function latestCurrentMonthRawPulledAt(currentMonthStart) {
  const monthKey = liveCurrentMonthKey(currentMonthStart);
  if (
    sharedLatestCurrentMonthRaw.monthKey === monthKey &&
    sharedLatestCurrentMonthRaw.promise
  ) {
    return sharedLatestCurrentMonthRaw.promise;
  }
  if (
    sharedLatestCurrentMonthRaw.monthKey === monthKey &&
    (Date.now() - sharedLatestCurrentMonthRaw.valueAtMs) <= LIVE_CURRENT_RESULT_REUSE_MS
  ) {
    return sharedLatestCurrentMonthRaw.value;
  }
  const nextMonthStart = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() + 1, 1);
  const startKey = `${currentMonthStart.getFullYear()}-${String(currentMonthStart.getMonth() + 1).padStart(2, '0')}-01`;
  const endKey = `${nextMonthStart.getFullYear()}-${String(nextMonthStart.getMonth() + 1).padStart(2, '0')}-01`;
  const promise = (async () => {
    const { data, error } = await retryOnStatementTimeout(async () => admin
      .from('raw_report')
      .select('pulled_at')
      .gte('month', startKey)
      .lt('month', endKey)
      .order('pulled_at', { ascending: false })
      .limit(1));
    if (error) throw new Error(error.message);
    const value = data?.[0]?.pulled_at || null;
    if (sharedLatestCurrentMonthRaw.monthKey === monthKey) {
      sharedLatestCurrentMonthRaw.value = value;
      sharedLatestCurrentMonthRaw.valueAtMs = Date.now();
    }
    return value;
  })().finally(() => {
    if (sharedLatestCurrentMonthRaw.monthKey === monthKey) {
      sharedLatestCurrentMonthRaw.promise = null;
    }
  });
  sharedLatestCurrentMonthRaw = {
    monthKey,
    promise,
    value: null,
    valueAtMs: 0,
  };
  return promise;
}

async function retryLiveCurrentBuild(currentMonthStart, attempts = 3, delayMs = 1500) {
  let lastError;
  const prevMonthStart = reportingPreviousMonthStart(currentMonthStart);
  for (let i = 0; i < attempts; i++) {
    try {
      return await buildCurrentMonthPayload(currentMonthStart, prevMonthStart);
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        console.warn(`[portalPayload] live current-month build attempt ${i + 1}/${attempts} failed; retrying in ${delayMs}ms:`, error?.message || error);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

function reusableLiveCurrentResult(currentMonthStart) {
  const monthKey = liveCurrentMonthKey(currentMonthStart);
  if (sharedLiveCurrentBuild.monthKey !== monthKey || !sharedLiveCurrentBuild.result) return null;
  if ((Date.now() - sharedLiveCurrentBuild.resultAtMs) > LIVE_CURRENT_RESULT_REUSE_MS) return null;
  return sharedLiveCurrentBuild.result;
}

async function getSharedLiveCurrentBuild(currentMonthStart) {
  const monthKey = liveCurrentMonthKey(currentMonthStart);
  const reusable = reusableLiveCurrentResult(currentMonthStart);
  if (reusable) return reusable;
  if (sharedLiveCurrentBuild.monthKey === monthKey && sharedLiveCurrentBuild.promise) {
    return sharedLiveCurrentBuild.promise;
  }
  const promise = retryLiveCurrentBuild(currentMonthStart)
    .then((result) => {
      if (sharedLiveCurrentBuild.monthKey === monthKey) {
        sharedLiveCurrentBuild.result = result;
        sharedLiveCurrentBuild.resultAtMs = Date.now();
      }
      return result;
    })
    .finally(() => {
      if (sharedLiveCurrentBuild.monthKey === monthKey) {
        sharedLiveCurrentBuild.promise = null;
      }
    });
  sharedLiveCurrentBuild = {
    monthKey,
    promise,
    result: null,
    resultAtMs: 0,
  };
  return promise;
}

async function readLiveCurrentWithTimeout(currentMonthStart) {
  let timeoutId = null;
  try {
    return await Promise.race([
      getSharedLiveCurrentBuild(currentMonthStart),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`live current-month build exceeded ${LIVE_CURRENT_READ_TIMEOUT_MS}ms`)), LIVE_CURRENT_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function mergeFreshCurrentMonth(storedPayload, livePayload) {
  if (!storedPayload || !livePayload?.totals || !Array.isArray(livePayload.sites) || !livePayload.sites.length) {
    return storedPayload;
  }
  const currentMonth = livePayload.current_month;
  const months = [...new Set([...(storedPayload.months || []), currentMonth])].sort();
  const prevMonth = months.filter((month) => month < currentMonth).slice(-1)[0] || null;
  const monthly = {
    ...(storedPayload.monthly || {}),
    [currentMonth]: livePayload.sites,
  };
  const currentHistoryPoint = buildHistoryPoint(currentMonth, livePayload.sites);
  const history = Array.isArray(storedPayload.history)
    ? [
        ...storedPayload.history.filter((row) => row?.month !== currentMonth),
        currentHistoryPoint,
      ].sort((a, b) => String(a?.month || '').localeCompare(String(b?.month || '')))
    : [currentHistoryPoint];
  return {
    ...storedPayload,
    // Continued audit hardening (10 Aug 2026): the fast path only rebuilds the CURRENT month and
    // merges it into whatever historical months were already stored. Stamping the whole payload with
    // the latest build version here falsely implies the historical slices were also regenerated under
    // the current semantics, which can hide stale older history behind a "current" build marker.
    // Preserve the stored historical build marker until a true historical repair/full rebuild updates
    // it; current_month_slice_version below is the explicit marker for the fresh live current slice.
    build_version: storedPayload.build_version || livePayload.build_version || PORTAL_PAYLOAD_BUILD_VERSION,
    current_month_slice_version: CURRENT_MONTH_SLICE_VERSION,
    generated_at: newerTimestamp(storedPayload.generated_at, livePayload.generated_at),
    current_month: currentMonth,
    prev_month: prevMonth,
    months,
    sites: livePayload.sites,
    totals: livePayload.totals,
    monthly,
    history,
  };
}

export function payloadFromLiveCurrent(livePayload) {
  if (!livePayload?.totals || !Array.isArray(livePayload.sites) || !livePayload.sites.length) return null;
  const currentMonth = livePayload.current_month;
  const [year, month] = String(currentMonth || '').split('-').map(Number);
  const prevMonth = year && month ? `${new Date(year, month - 2, 1).getFullYear()}-${String(new Date(year, month - 2, 1).getMonth() + 1).padStart(2, '0')}` : null;
  return {
    build_version: livePayload.build_version || PORTAL_PAYLOAD_BUILD_VERSION,
    current_month_slice_version: CURRENT_MONTH_SLICE_VERSION,
    generated_at: livePayload.generated_at || null,
    current_month: currentMonth,
    prev_month: prevMonth,
    months: currentMonth ? [currentMonth] : [],
    sites: livePayload.sites,
    totals: livePayload.totals,
    monthly: currentMonth ? { [currentMonth]: livePayload.sites } : {},
    history: currentMonth ? [buildHistoryPoint(currentMonth, livePayload.sites)] : [],
  };
}

function payloadFromReadableCurrentSlice(payload, generatedAt = null) {
  if (!hasReadablePortalCurrentSlice(payload)) return null;
  return payloadFromLiveCurrent({
    build_version: payload.build_version || PORTAL_PAYLOAD_BUILD_VERSION,
    generated_at: payload.generated_at || generatedAt || null,
    current_month: payload.current_month || null,
    sites: payload.sites,
    totals: payload.totals,
  });
}

export async function readPortalPayloadFreshCurrentMonth(now = new Date()) {
  let stored = null;
  let liveBuildFailed = false;
  let storedReadFailed = false;
  try {
    stored = await readPortalPayload();
  } catch (error) {
    storedReadFailed = true;
    console.warn('[portalPayload] stored portal_payload read failed; serving live current-month fallback:', error?.message || error);
  }

  const currentMonthStart = reportingCurrentMonthStart(now);
  const currentMonthKey = `${currentMonthStart.getFullYear()}-${String(currentMonthStart.getMonth() + 1).padStart(2, '0')}`;
  if (stored?.payload) {
    stored = {
      ...stored,
      payload: await getSharedStoredHistoricalRepair(stored.payload, stored.generatedAt, currentMonthKey),
    };
  }
  const storedPayloadUsable = isPortalPayloadShapeUsable(stored?.payload);
  const storedPayloadCurrent = storedPayloadUsable && stored?.payload?.current_month === currentMonthKey && hasReadablePortalCurrentSlice(stored?.payload);
  const storedPayloadCurrentRich = storedPayloadUsable && stored?.payload?.current_month === currentMonthKey && hasRichPortalCurrentSlice(stored?.payload);
  const storedBuildVersionCurrent = stored?.payload?.build_version === PORTAL_PAYLOAD_BUILD_VERSION;
  const storedCurrentSliceVersionCurrent = stored?.payload?.current_month_slice_version === CURRENT_MONTH_SLICE_VERSION;
  if (storedPayloadCurrent && storedBuildVersionCurrent && storedPayloadCurrentRich && stored?.generatedAt) {
    try {
      const latestRawPulledAt = await latestCurrentMonthRawPulledAt(currentMonthStart);
      const storedAtMs = new Date(stored.generatedAt).getTime();
      const latestRawAtMs = latestRawPulledAt ? new Date(latestRawPulledAt).getTime() : 0;
      const storedCoversLatestRaw = !latestRawPulledAt || (Number.isFinite(storedAtMs) && Number.isFinite(latestRawAtMs) && storedAtMs >= latestRawAtMs);
      // Trust either:
      //   1. the explicit live-current merged slice marker, or
      //   2. any freshly-written full/stored payload whose generated_at is already at or beyond the
      //      latest current-month raw_report pull.
      // The second case matters for manual/full rebuilds and repaired stored payloads, which can be
      // completely fresh yet still have no current_month_slice_version marker because they did not
      // come through mergeFreshCurrentMonth().
      if ((storedCurrentSliceVersionCurrent || storedCoversLatestRaw) && storedCoversLatestRaw) {
        return {
          payload: stored.payload,
          generatedAt: stored.generatedAt,
        };
      }
    } catch (error) {
      console.warn('[portalPayload] current-month freshness probe failed; serving the last known-good stored current-month payload instead of forcing a live merge:', error?.message || error);
      // Resilience hardening (28 Jul 2026): when the payload already carries a current-month slice
      // marker from a prior successful live merge, a transient failure in the *freshness probe* is
      // weaker evidence than the existence of that known-good stored slice. Escalating immediately
      // into a full live rebuild here turns a cheap metadata blip into a slow page load or outright
      // read failure during upstream turbulence. Prefer the already-validated stored slice and let a
      // later successful rebuild/read catch up if newer raw rows did land meanwhile.
      if (storedCurrentSliceVersionCurrent && storedPayloadCurrentRich) {
        return {
          payload: stored.payload,
          generatedAt: stored.generatedAt,
        };
      }
    }
  }

  let liveCurrent = null;
  try {
    // Read-path hardening (27 Jul 2026): transient Supabase statement timeouts were still causing
    // the default portal read to drop straight to the stored payload, which keeps the app alive but
    // can silently serve stale current-month figures after the raw data has already advanced. The
    // current-month build often succeeds on an immediate retry under the exact same data, so retry a
    // couple of times here before giving up and falling back to stored-only.
    liveCurrent = await readLiveCurrentWithTimeout(currentMonthStart);
  } catch (error) {
    liveBuildFailed = true;
    // Production hardening (27 Jul 2026): a transient current-month live rebuild failure should not
    // blank the whole portal or force mock data when yesterday's stored payload is still readable.
    // Prefer slightly stale but real persisted data over "unconfigured" on read-time merge errors.
    console.warn('[portalPayload] live current-month build failed; falling back to stored portal_payload:', error?.message || error);
    if (!stored?.payload) {
      try {
        const recoveredStored = await readPortalPayload();
        if (recoveredStored?.payload) stored = recoveredStored;
      } catch (retryError) {
        console.warn('[portalPayload] stored portal_payload retry after live current build failure also failed:', retryError?.message || retryError);
      }
    }
    if (!stored?.payload) throw error;
  }

  if (liveCurrent && storedReadFailed && !stored?.payload) {
    try {
      const recoveredStored = await readPortalPayload();
      if (recoveredStored?.payload) {
        stored = recoveredStored;
      }
    } catch (error) {
      console.warn('[portalPayload] stored portal_payload retry after live current build failed; returning current-month-only fallback:', error?.message || error);
    }
  }

  const recoveredStoredPayloadUsable = isPortalPayloadShapeUsable(stored?.payload);
  const mergeBasePayload = recoveredStoredPayloadUsable
    ? stored.payload
    : (storedPayloadUsable ? stored.payload : null);
  const payload = mergeBasePayload
    ? mergeFreshCurrentMonth(mergeBasePayload, liveCurrent)
    : (liveBuildFailed
        ? payloadFromReadableCurrentSlice(stored?.payload, stored?.generatedAt)
        : payloadFromLiveCurrent(liveCurrent));
  if (!payload) return null;
  return {
    payload,
    generatedAt: payload?.generated_at || stored?.generatedAt || null,
  };
}
