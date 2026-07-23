import { NextResponse } from 'next/server';
import { readPortalPayload } from '../../../lib/portalPayload.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLOURS = ['#95D108', '#679106', '#3A5203', '#8AC308', '#7AAB07'];

function moneyFromRate(rate, area) {
  return rate && area ? +(rate * area / 12).toFixed(2) : 0;
}

function legacyRentRollUnits(rec) {
  const out = {};
  const ssArea = rec.ss?.occA || 0;
  const ssRent = rec.ss?.rent || moneyFromRate(rec.ssRate || rec.ss?.rate, ssArea);
  if (ssArea || ssRent) {
    out['Self Storage'] = {
      unit_type: 'Self Storage',
      area: ssArea,
      rent: ssRent,
      original_rent: ssRent,
      effective_rent: moneyFromRate(rec.ssReal || rec.ss?.real, ssArea) || ssRent,
    };
  }

  for (const t of rec.unitTypes || []) {
    const name = /office/i.test(t.unit_type || '') ? 'Offices' : (t.unit_type || 'Other');
    const area = t.occ_area || 0;
    const rent = t.monthly_rent || moneyFromRate(t.rate_per_sqft_ann, area);
    const effRent = t.monthly_rent || moneyFromRate(t.real_rate_per_sqft_ann, area);
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

function legacyRecord(rec, month) {
  if (!rec) return null;
  const revenue = rec.revenue || {};
  const enquiries = rec.enquiries || {};
  const debtAgeing = rec.debtors?.ageing || {};
  const categories = revenue.categories || [];
  const rentReceipts = categoryAmount(categories, /^rent$/i, 'payment');
  const insuranceReceipts = categoryAmount(categories, /insurance/i, 'payment');
  const totalReceipts = revenue.payment || revenue.collected || 0;

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
    web_leads: enquiries.web || 0,
    walkin_leads: enquiries.walkin || 0,
    reservations: rec.reservations || 0,
    scheduled_move_outs: rec.scheduledOuts || 0,
    rental_discounts: revenue.discount || 0,
    credits_issued: revenue.credit || 0,
    merchandise: rec.merchandise?.sales || 0,
    insurance_units: rec.insurance?.insured || 0,
    insurance_value: rec.insurance?.premium || 0,
    move_ins_insurance: rec.insuranceActivity?.newPolicies || 0,
    unique_tenants: rec.marketing?.tenants || rec.occ || 0,
    rate_ss_sqft: rec.ssRate || rec.ss?.rate || 0,
    rate_total_sqft: rec.rate || 0,
    real_rate_ss_sqft: rec.ssReal || rec.ss?.real || 0,
    real_rate_total_sqft: rec.realRate || 0,
    rent_roll_units: legacyRentRollUnits(rec),
    unit_mix_summary: rec.unitTypes || [],
    unit_size_summary: rec.unitMix || [],
    debtors_value_0: 0,
    debtors_value_11: 0,
    debtors_value_31: debtAgeing['31-60'] || 0,
    debtors_value_61: debtAgeing['61-90'] || 0,
    debtors_value_91: debtAgeing['91-120'] || 0,
    debtors_value_121: debtAgeing['121-180'] || 0,
    debtors_value_181: debtAgeing['181-360'] || 0,
    debtors_value_361: debtAgeing['361+'] || 0,
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

function jsAssignment(name, value) {
  return `window.${name} = ${JSON.stringify(value)};`;
}

function bootstrapScript(legacy, configured) {
  return [
    jsAssignment('STATIC_PREVIEW', !configured),
    jsAssignment('colours', COLOURS),
    jsAssignment('ajax', { url: '/api' }),
    jsAssignment('PORTAL_USER', ''),
    jsAssignment('SITELINK_CONFIGURED', configured),
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
    const result = await readPortalPayload({ ensureFresh: true });
    const legacy = result?.payload ? payloadToLegacy(result.payload) : emptyBootstrap();
    return new NextResponse(bootstrapScript(legacy, Boolean(result?.payload)), {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const legacy = emptyBootstrap();
    return new NextResponse(
      `${bootstrapScript(legacy, false)}\nconsole.error(${JSON.stringify(`bootstrap failed: ${error.message}`)});`,
      {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    );
  }
}
