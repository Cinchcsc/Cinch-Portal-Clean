import { NextResponse } from 'next/server';
import { readPortalPayloadFreshCurrentMonth, summarizeHistoricalMonthlyCoverage } from '../../../lib/portalPayload.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Same production-read budget as /api/portfolio: the legacy bootstrap now uses the exact same
// fresh-current-month merge helper, so its first cold read can also exceed the default route
// timeout unless we raise it explicitly.
export const maxDuration = 300;

const AUTHENTICATED_NO_STORE = 'private, no-store';

const COLOURS = ['#95D108', '#679106', '#3A5203', '#8AC308', '#7AAB07'];

function moneyFromRate(rate, area) {
  return rate && area ? +(rate * area / 12).toFixed(2) : 0;
}

function legacyRentRollUnits(rec) {
  const out = {};
  const ssArea = rec.ss?.occA || 0;
  const ssRent = rec.ss?.rent ?? moneyFromRate(rec.ssRate ?? rec.ss?.rate, ssArea);
  if (ssArea || ssRent) {
    out['Self Storage'] = {
      unit_type: 'Self Storage',
      area: ssArea,
      rent: ssRent,
      original_rent: ssRent,
      effective_rent: moneyFromRate(rec.ssReal ?? rec.ss?.real, ssArea) || ssRent,
    };
  }

  for (const t of rec.unitTypes || []) {
    const name = /office/i.test(t.unit_type || '') ? 'Offices' : (t.unit_type || 'Other');
    const area = t.occ_area || 0;
    const rent = t.monthly_rent ?? moneyFromRate(t.rate_per_sqft_ann, area);
    const effRent = t.monthly_rent ?? moneyFromRate(t.real_rate_per_sqft_ann, area);
    // FIXED 7 Jul 2026 (exhaustive bug audit): a second raw unit-type row that normalizes to the
    // same display name (e.g. two rows both matching /office/i, or a genuine duplicate) used to
    // be silently dropped entirely (`if (out[name]) continue`) instead of merged — unlike every
    // other duplicate-row handler in this codebase (mergeByDesc, sumRevenueGroups,
    // mergeRowsAcrossMonths), which all sum collisions. Now sums instead of discarding.
    if (out[name]) {
      out[name].area += area;
      out[name].rent += rent;
      out[name].original_rent += rent;
      out[name].effective_rent += effRent;
      continue;
    }
    out[name] = {
      unit_type: name,
      area,
      rent,
      original_rent: rent,
      effective_rent: effRent,
    };
  }

  return Object.keys(out).length ? out : null;
}

function categoryAmount(categories, matcher, field = 'payment') {
  const row = (categories || []).find((z) => matcher.test(z.category || '') || matcher.test(z.desc || ''));
  return row ? Number(row[field] || 0) : 0;
}

function legacyDebtBucket(ageing, key) {
  if (!ageing || typeof ageing !== 'object') return 0;
  if (key === '0-10') return Number(ageing['0-10'] ?? ageing['1-30'] ?? 0) || 0;
  if (key === '11-30' && Object.prototype.hasOwnProperty.call(ageing, '1-30')) return 0;
  return Number(ageing[key] || 0) || 0;
}

function legacyRecord(rec, month) {
  if (!rec) return null;
  const revenue = rec.revenue || {};
  const enquiries = rec.enquiries || {};
  const debtAgeing = rec.debtors?.ageing || {};
  const categories = revenue.categories || [];
  const rentReceipts = categoryAmount(categories, /^rent$/i, 'payment');
  const insuranceReceipts = categoryAmount(categories, /insurance/i, 'payment');
  const totalReceipts = revenue.payment ?? revenue.collected ?? 0;

  return {
    month,
    rent_roll: rec.rent || 0,
    occupied_units: rec.occ || 0,
    total_units: rec.tot || 0,
    vacant_units: rec.vacant ?? Math.max(0, (rec.tot || 0) - (rec.occ || 0)),
    occupied_area: rec.occA || 0,
    total_area: rec.totA || 0,
    vacant_area: Math.max(0, (rec.totA || 0) - (rec.occA || 0)),
    total_receipts: totalReceipts,
    rent_receipts: rentReceipts,
    insurance_receipts: insuranceReceipts,
    other_receipts: Math.max(0, totalReceipts - rentReceipts - insuranceReceipts),
    revenue_total: revenue.collected || 0,
    revenue_rent: categoryAmount(categories, /^rent$/i, 'charge') - categoryAmount(categories, /^rent$/i, 'credit'),
    move_ins: rec.moveIns || 0,
    move_outs: rec.moveOuts || 0,
    rented_area_change: rec.netArea || 0,
    total_leads: enquiries.total || 0,
    phone_leads: enquiries.phone || 0,
    web_leads: (enquiries.webOnly ?? enquiries.web) || 0,
    walkin_leads: enquiries.walkin || 0,
    // Legacy bootstrap keeps its long-standing generic "reservations" field on the payload's
    // explicit InquiryTracking reservation-stage count (`rec.reservations`). The newer
    // `reservationsMade` metric powers the audited "Reservations vs Move-outs" portal widget and is
    // intentionally kept separate because it can diverge store-by-store.
    reservations: rec.reservations || 0,
    scheduled_move_outs: rec.scheduledOuts || 0,
    rental_discounts: revenue.discount || 0,
    credits_issued: revenue.credit || 0,
    // Keep the legacy bootstrap on the same audited "Merchandise Sales" source as the new portal:
    // FinancialSummary POS charges (`chargeFromFinancial`), not MerchandiseSummary's own sales total.
    merchandise: rec.merchandise?.chargeFromFinancial || 0,
    insurance_units: rec.insurance?.insured || 0,
    insurance_value: rec.insurance?.premium || 0,
    move_ins_insurance: rec.insuranceActivity?.newPolicies || 0,
    unique_tenants: rec.marketing?.tenants ?? rec.occ ?? 0,
    rate_ss_sqft: rec.ssRate ?? rec.ss?.rate ?? 0,
    rate_total_sqft: rec.rate || 0,
    real_rate_ss_sqft: rec.ssReal ?? rec.ss?.real ?? 0,
    real_rate_total_sqft: rec.realRate || 0,
    rent_roll_units: legacyRentRollUnits(rec),
    unit_mix_summary: rec.unitTypes || [],
    unit_size_summary: rec.unitMix || [],
    debtors_value_0: legacyDebtBucket(debtAgeing, '0-10'),
    debtors_value_11: legacyDebtBucket(debtAgeing, '11-30'),
    debtors_value_31: legacyDebtBucket(debtAgeing, '31-60'),
    debtors_value_61: legacyDebtBucket(debtAgeing, '61-90'),
    debtors_value_91: legacyDebtBucket(debtAgeing, '91-120'),
    debtors_value_121: legacyDebtBucket(debtAgeing, '121-180'),
    debtors_value_181: legacyDebtBucket(debtAgeing, '181-360'),
    debtors_value_361: legacyDebtBucket(debtAgeing, '361+'),
  };
}

function payloadToLegacy(payload) {
  const monthKeys = [...(payload.months || [])].sort().reverse();
  const byMonth = {};
  for (const month of monthKeys) {
    const rows = month === payload.current_month && payload.sites?.length
      ? payload.sites
      : (payload.monthly?.[month] || []);
    byMonth[month] = Object.fromEntries(rows.map((rec) => [rec.code, rec]));
  }

  const siteMap = new Map();
  for (const rec of payload.sites || []) siteMap.set(rec.code, rec.name || rec.code);
  for (const rows of Object.values(payload.monthly || {})) {
    for (const rec of rows || []) if (!siteMap.has(rec.code)) siteMap.set(rec.code, rec.name || rec.code);
  }

  const facilities = [...siteMap.entries()].map(([code, name]) => ({ code, name }));
  const locationData = {};
  for (const { code, name } of facilities) {
    locationData[code] = {
      name,
      KPIdata: monthKeys.map((month) => legacyRecord(byMonth[month]?.[code], month)),
    };
  }

  return {
    facilities,
    monthStrings: monthKeys.map((month) => `${month}-01`),
    locationData,
    updated: payload.generated_at || payload.current_month || '',
  };
}

function emptyBootstrap() {
  return {
    facilities: [],
    monthStrings: [],
    locationData: {},
    updated: '',
  };
}

function summarizePayloadCompleteness(payload) {
  const sites = Array.isArray(payload?.sites) ? payload.sites : [];
  const missingSites = sites
    .filter((site) => site?.__padded_missing_site)
    .map((site) => site?.code || site?.name)
    .filter(Boolean);
  const historicalCoverage = summarizeHistoricalMonthlyCoverage(payload, { excludeMonth: payload?.current_month || null });
  const incompleteMonths = [...historicalCoverage.incompleteMonths].sort();
  return {
    complete: missingSites.length === 0 && incompleteMonths.length === 0,
    missingSites,
    incompleteMonths,
  };
}

function jsAssignment(name, value) {
  return `window.${name} = ${JSON.stringify(value)};`;
}

function bootstrapScript(legacy, configured, completeness = { complete: true, missingSites: [], incompleteMonths: [] }) {
  return [
    jsAssignment('STATIC_PREVIEW', !configured),
    jsAssignment('colours', COLOURS),
    jsAssignment('ajax', { url: '/api' }),
    jsAssignment('PORTAL_USER', ''),
    jsAssignment('SITELINK_CONFIGURED', configured),
    jsAssignment('SITELINK_COMPLETE', completeness.complete !== false),
    jsAssignment('SITELINK_MISSING_SITES', Array.isArray(completeness.missingSites) ? completeness.missingSites : []),
    jsAssignment('SITELINK_INCOMPLETE_MONTHS', Array.isArray(completeness.incompleteMonths) ? completeness.incompleteMonths : []),
    jsAssignment('OPEX_RATIO', 0),
    jsAssignment('DATA_UPDATED', legacy.updated),
    jsAssignment('FACILITIES', legacy.facilities),
    jsAssignment('MONTH_STRINGS', legacy.monthStrings),
    jsAssignment('months', legacy.monthStrings),
    jsAssignment('PERSISTED_ASSETS', []),
    jsAssignment('locationData', legacy.locationData),
    '',
  ].join('\n');
}

export async function GET() {
  try {
    // Keep legacy bootstrap reads lightweight too. The scheduled rebuild cron is responsible for
    // refreshing portal_payload; a plain bootstrap read should not kick off a full rebuild inside an
    // end-user request.
    const result = await readPortalPayloadFreshCurrentMonth();
    const payload = result?.payload || null;
    const configured = !!(payload && payload.totals && Array.isArray(payload.sites) && payload.sites.length);
    const completeness = configured ? summarizePayloadCompleteness(payload) : { complete: false, missingSites: [], incompleteMonths: [] };
    const legacy = configured ? payloadToLegacy(payload) : emptyBootstrap();
    return new NextResponse(bootstrapScript(legacy, configured, completeness), {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': AUTHENTICATED_NO_STORE,
      },
    });
  } catch (error) {
    const legacy = emptyBootstrap();
    return new NextResponse(
      `${bootstrapScript(legacy, false, { complete: false, missingSites: [], incompleteMonths: [] })}\nconsole.error(${JSON.stringify(`bootstrap failed: ${error.message}`)});`,
      {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': AUTHENTICATED_NO_STORE,
        },
      },
    );
  }
}
