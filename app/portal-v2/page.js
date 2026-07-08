'use client';

// Faithful React port of the decoded Cinch portal artifact bundle.
// The original was a two-part system: a `DCLogic`-based class (this component's
// logic: state, setState, render-value builder) rendered against a declarative
// HTML template (`<x-dc>...</x-dc>`) using `{{ }}` interpolation, `sc-if`, and
// `sc-for` bindings. `h(...)` in the original mapped 1:1 to `React.createElement`.
// This file collapses both halves into one idiomatic React function component
// using hooks, preserving all state, derived values, and markup 1:1.

import { useEffect, useMemo, useRef, useState } from 'react';

const C = { blue: '#2757E8', blue2: '#7CA0F4', teal: '#12B5A5', slate: '#94A3B8', green: '#08875D', red: '#D92D20', amber: '#F79009', track: '#EEF1F5' };

// ---------------------------------------------------------------------------
// Mock data seed (verbatim from the decoded source)
// ---------------------------------------------------------------------------
const RAW_STORES = [
  ['Bicester', 'South East', 310, 348, 92.4], ['Gillingham', 'South East', 432, 496, 90.5], ['Sidcup', 'London', 425, 490, 92.6],
  ['Bedford', 'East', 141, 163, 87.0], ['Huntingdon', 'East', 462, 538, 79.4], ['Earlsfield', 'London', 286, 334, 93.7],
  ['Mitcham', 'London', 329, 395, 87.4], ['Letchworth', 'East', 492, 598, 84.3], ['Sittingbourne', 'South East', 362, 447, 82.3],
  ['Leighton Buzzard', 'East', 513, 636, 86.0], ['Brighton', 'South Coast', 342, 428, 81.9], ['Newcastle', 'North', 226, 303, 56.0],
  ['Southend', 'East', 312, 441, 75.1], ['Newbury', 'South East', 349, 532, 68.2], ['Woking', 'South East', 420, 647, 66.0],
  ['Brentwood', 'East', 437, 679, 73.1], ['Watford', 'London', 486, 806, 68.3], ['Newmarket', 'East', 370, 618, 60.9],
  ['Reading', 'South East', 401, 512, 78.0], ['Guildford', 'South East', 356, 470, 74.5], ['Basildon', 'East', 298, 410, 71.2],
  ['Chelmsford', 'East', 372, 505, 76.8], ['Maidstone', 'South East', 330, 452, 72.9], ['Luton', 'East', 288, 425, 66.5],
  ['Milton Keynes', 'East', 445, 590, 79.9], ['Croydon', 'London', 390, 560, 69.7], ['Ipswich', 'East', 330, 505, 64.2],
];

function buildStores() {
  const stores = RAW_STORES.map(([name, region, occupied, total, claPct], i) => {
    const rateVar = 0.9 + ((i * 37) % 20) / 100;
    const area = Math.round(occupied * 77 * rateVar);
    const rentRoll = Math.round(occupied * 161 * rateVar);
    return {
      name, region, occupied, total, claPct, occPct: +(occupied / total * 100).toFixed(1), area, rentRoll,
      rate: +(rentRoll * 12 / area).toFixed(2),
    };
  });
  return stores;
}

function buildMonths() {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const out = []; let y = 2025, m = 0; // start Jan 2025 -> 24 months
  for (let i = 0; i < 24; i++) { out.push({ value: i, label: names[m] + ' ' + y }); m++; if (m > 11) { m = 0; y++; } }
  return out; // index 17 = Jun 2026
}

// money/int formatters (verbatim: this.money / this.int in the original)
function money(n) { return '£' + Math.round(n).toLocaleString('en-GB'); }
function intFmt(n) { return Math.round(n).toLocaleString('en-GB'); }
// Round-half-up to 2dp — mirrors lib/reportMap.js's R2(). Plain `.toFixed(2)` rounds DOWN on
// values whose binary float representation sits just under the true .xx5 boundary (e.g. 28.005
// stored as 28.00499999999999...), which is why rates were sometimes showing a penny low.
function R2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// Client-side re-aggregation of /api/portfolio's `sites[]` array, mirroring lib/buildPayload.js's
// `totals` block field-for-field (same sum-then-divide rule everywhere — never average per-site
// rates/percentages). Needed so the top store-selector filter can recompute portfolio-style totals
// for whatever subset of stores is selected, rather than only ever showing the full-portfolio
// totals the server precomputes. Keep this in sync with lib/buildPayload.js if that file changes.
function computeTotals(sites) {
  const sum = (k) => sites.reduce((a, s) => a + (s[k] || 0), 0);
  const occA = sum('occA'), claA = sum('claA'), totA = sum('totA'), occ = sum('occ'), tot = sum('tot'), rent = sum('rent');
  const t = {
    n: sites.length, occ, tot, occA, claA, totA, rent, gpot: sum('gpot'), grossOcc: sum('grossOcc'),
    occPC: tot ? +(occ / tot * 100).toFixed(1) : 0, areaPC: totA ? +(occA / totA * 100).toFixed(1) : 0,
    claPC: claA ? +(occA / claA * 100).toFixed(1) : (totA ? +(occA / totA * 100).toFixed(1) : 0),
    // Rate: dcStandardRate-based, unchanged. Real Rate: REPLACED 8 Jul 2026 to mirror
    // lib/buildPayload.js's aggregateTotals() exactly — True Revenue-based (Σ(TruePeriod−adj)),
    // divided by TOTAL area (areaTotalAll, incl. vacant units), NOT areaSum (occupied-only, still
    // correct for Rate). Keep this in sync with lib/buildPayload.js if that file changes.
    rate: sum('areaSum') ? R2(sum('stdRentSum') / sum('areaSum') * 12) : 0,
    realRate: sum('areaTotalAll') ? R2(sum('trueRevenueNumerator') / sum('areaTotalAll') * 12) : 0,
    ssRate: sum('ssAreaSum') ? R2(sum('ssStdRentSum') / sum('ssAreaSum') * 12) : 0,
    ssReal: sum('ssAreaTotalAll') ? R2(sum('ssTrueRevenueNumerator') / sum('ssAreaTotalAll') * 12) : 0,
    ssOcc: sites.reduce((a, s) => a + (s.ss ? s.ss.occ : 0), 0), ssTot: sites.reduce((a, s) => a + (s.ss ? s.ss.tot : 0), 0),
    officesOcc: sites.reduce((a, s) => a + (s.offices ? s.offices.occ : 0), 0), officesTot: sites.reduce((a, s) => a + (s.offices ? s.offices.tot : 0), 0),
    officesRate: sum('officesAreaSum') ? R2(sum('officesRentSum') / sum('officesAreaSum') * 12) : 0,
  };
  t.ssOccPC = t.ssTot ? +(t.ssOcc / t.ssTot * 100).toFixed(1) : 0;
  t.officesOccPC = t.officesTot ? +(t.officesOcc / t.officesTot * 100).toFixed(1) : 0;
  const debtAccounts = sites.reduce((a, s) => a + (s.debtors ? s.debtors.accounts : 0), 0);
  const debtTotal = sites.reduce((a, s) => a + (s.debtors ? s.debtors.allOverdue : 0), 0);
  const occActualRentSum = sum('occActualRent');
  t.debtorTenantPct = t.occ ? +(debtAccounts / t.occ * 100).toFixed(1) : 0;
  t.debtorRentRollPct = occActualRentSum ? +(debtTotal / occActualRentSum * 100).toFixed(1) : 0;
  t.debtorTotal = debtTotal;
  // Autobill Conversion = new autobilled customers / total new customers this month (legacy
  // tooltip, confirmed 2 Jul 2026) — mirrors lib/buildPayload.js exactly.
  const autobillNewCountSum = sum('autobillNewCount'), autobillNewTotalSum = sum('autobillNewTotal');
  t.autobillPC = autobillNewTotalSum ? +(autobillNewCountSum / autobillNewTotalSum * 100).toFixed(1) : 0;
  const custSum = (seg, k) => sites.reduce((a, s) => a + ((s.customerType && s.customerType[seg] && s.customerType[seg][k]) || 0), 0);
  const bizUnits = custSum('business', 'units'), resUnits = custSum('residential', 'units');
  const bizArea = custSum('business', 'area'), resArea = custSum('residential', 'area');
  const bizRent = custSum('business', 'rent'), resRent = custSum('residential', 'rent');
  const custTotUnits = bizUnits + resUnits;
  t.customerType = {
    business: { units: bizUnits, pct: custTotUnits ? +(bizUnits / custTotUnits * 100).toFixed(1) : 0, rate: bizArea ? R2(bizRent / bizArea * 12) : 0 },
    residential: { units: resUnits, pct: custTotUnits ? +(resUnits / custTotUnits * 100).toFixed(1) : 0, rate: resArea ? R2(resRent / resArea * 12) : 0 },
  };
  t.reservationsActive = sum('activeReservations');
  t.scheduledOuts = sum('scheduledOuts');
  t.reservationsNet = t.reservationsActive - t.scheduledOuts;
  // Mirrors lib/buildPayload.js's aggregateTotals() — client-side recompute for the store filter.
  t.reservationsMade = sum('reservationsMade');
  t.reservationsMadeNet = t.reservationsMade - sum('moveOuts');
  const insurancePremiumSum = sum('insurancePremiumSum'), insuredUnitsSum = sum('insuredUnitsSum');
  t.insurancePremium = insurancePremiumSum;
  t.insurancePctRoll = t.rent ? +(insurancePremiumSum / t.rent * 100).toFixed(1) : 0;
  t.insurancePctInsured = t.occ ? +(insuredUnitsSum / t.occ * 100).toFixed(1) : 0;
  // True Revenue (Financials page) — mirrors lib/buildPayload.js's sumRevenueGroups exactly.
  const sumRevenueGroups = (field) => {
    const g = {};
    for (const s of sites) for (const row of (s[field] || [])) {
      const o = (g[row.desc] ??= { desc: row.desc, invoiced: 0, taxInvoiced: 0, taxAdj: 0, netTax: 0, deferred: 0, deferredPrev: 0, adj: 0, adjPrev: 0, truePeriod: 0 });
      o.invoiced += row.invoiced; o.taxInvoiced += row.taxInvoiced; o.taxAdj += row.taxAdj; o.netTax += row.netTax;
      o.deferred += row.deferred; o.deferredPrev += row.deferredPrev; o.adj += row.adj; o.adjPrev += row.adjPrev; o.truePeriod += row.truePeriod;
    }
    return Object.values(g).map((o) => { for (const k of Object.keys(o)) if (k !== 'desc') o[k] = R2(o[k]); return o; }).sort((a, b) => b.truePeriod - a.truePeriod);
  };
  t.trueRevenueByDesc = sumRevenueGroups('trueRevenueByDesc');
  t.trueRevenueByType = sumRevenueGroups('trueRevenueByType');
  // Rental Activity (Unit Mix Detail page) — mirrors lib/buildPayload.js's rollup exactly, so the
  // store filter recomputes these client-side the same way it does for every other rollup here.
  const rentalActivityByTypeSize = (() => {
    const g = {};
    for (const s of sites) for (const row of (s.rentalActivityByTypeSize || [])) {
      const key = `${row.type}|${row.unitSize}`;
      const o = (g[key] ??= {
        type: row.type, unitSize: row.unitSize, area: row.area, standardRate: row.standardRate,
        totalUnits: 0, occupied: 0, vacant: 0, occupiedRent: 0, movedIn: 0, movedOut: 0,
        netTransferred: 0, transfers: 0, net: 0, totalArea: 0, occupiedArea: 0, vacantArea: 0,
        netArea: 0, grossPotential: 0,
      });
      o.totalUnits += row.totalUnits; o.occupied += row.occupied; o.vacant += row.vacant;
      o.occupiedRent += row.occupiedRent; o.movedIn += row.movedIn; o.movedOut += row.movedOut;
      o.netTransferred += row.netTransferred; o.transfers += row.transfers; o.net += row.net;
      o.totalArea += row.totalArea; o.occupiedArea += row.occupiedArea; o.vacantArea += row.vacantArea;
      o.netArea += row.netArea; o.grossPotential += row.grossPotential;
    }
    return Object.values(g).map((o) => ({
      ...o,
      occPct: o.totalUnits ? +(o.occupied / o.totalUnits * 100).toFixed(1) : 0,
      vacPct: o.totalUnits ? +(o.vacant / o.totalUnits * 100).toFixed(1) : 0,
      totalDollarPerArea: o.totalArea ? R2(o.grossPotential / o.totalArea * 12) : 0,
      occupiedDollarPerArea: o.occupiedArea ? R2(o.occupiedRent / o.occupiedArea * 12) : 0,
      occupiedRent: R2(o.occupiedRent), grossPotential: R2(o.grossPotential),
    })).sort((a, b) => a.area - b.area);
  })();
  t.rentalActivityByTypeSize = rentalActivityByTypeSize;
  return t;
}

function seq(base, growth, noise, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.round((base + growth * i + Math.sin(i * 1.3) * noise) * 100) / 100);
  return out;
}

function chip(delta, dir) {
  const up = dir === 'up';
  const col = dir === null ? '#667085' : up ? C.green : C.red;
  const bg = dir === null ? '#F2F4F7' : up ? '#E7F6EF' : '#FEECEB';
  return {
    deltaStyle: { display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '11px', fontWeight: 600, color: col, background: bg, borderRadius: '6px', padding: '2px 7px', marginTop: '7px', fontVariantNumeric: 'tabular-nums' },
    deltaArrow: dir === null ? '' : up ? '↑' : '↓',
  };
}

// deltaTick(): builds the {delta, dir} pair chip() expects, from a current vs. previous raw number.
// Added 8 Jul 2026 for the Dashboard KPI cards' "vs last month" arrows (Michael: "put the ticks that
// show the net changes with arrows and they're red or green on the 29 pull one"). Mirrors the display
// convention the placeholder mock data already used: percentage tiles show the point difference
// suffixed "%", money tiles show "£"+diff. Returns {delta: null, dir: null} — no chip at all, chip()
// has no neutral/flat colour — whenever prev is unavailable or the change rounds to zero.
function deltaTick(cur, prev, kind) {
  if (cur == null || prev == null || !isFinite(cur) || !isFinite(prev)) return { delta: null, dir: null };
  const diff = cur - prev;
  const eps = kind === 'money' || kind === 'moneyWhole' ? 0.005 : kind === 'count' ? 0.5 : 0.05;
  if (Math.abs(diff) < eps) return { delta: null, dir: null };
  const abs = Math.abs(diff);
  const delta = kind === 'money' ? `£${abs.toFixed(2)}` : kind === 'moneyWhole' ? money(abs) : kind === 'count' ? intFmt(Math.round(abs)) : `${abs.toFixed(1)}%`;
  return { delta, dir: diff > 0 ? 'up' : 'down' };
}

// Custom widget builder field catalog — every numeric column available on a live site record
// (lib/buildPayload.js's recordFor()), grouped for the picker UI, plus a `mock` accessor so the
// builder still works (on the ~6 fields that exist) when previewing with mock data / no live pull
// yet. `live`/`mock` are small accessors rather than a flat dot-path string because a few values
// (rates, percentages) live under nested objects (`s.ss.rate`, `s.debtors.total`, etc.) with
// different shapes between the live record and the mock RAW_STORES record.
const FIELD_CATALOG = [
  { group: 'Occupancy & Area', items: [
    { value: 'occ', label: 'Occupied Units', live: (s) => s.occ || 0, mock: (s) => s.occupied || 0 },
    { value: 'tot', label: 'Total Units', live: (s) => s.tot || 0, mock: (s) => s.total || 0 },
    { value: 'occPC', label: 'Occupancy %', live: (s) => s.occPC || 0, mock: (s) => s.occPct || 0 },
    { value: 'occA', label: 'Occupied Area (ft²)', live: (s) => s.occA || 0, mock: (s) => s.area || 0 },
    { value: 'claA', label: 'CLA Area (ft²)', live: (s) => s.claA || 0, mock: () => 0 },
    { value: 'totA', label: 'Total Area / MLA (ft²)', live: (s) => s.totA || 0, mock: () => 0 },
    { value: 'areaPC', label: 'Occupied Area % of CLA', live: (s) => s.areaPC || 0, mock: (s) => s.claPct || 0 },
    { value: 'areaPCmla', label: 'Occupied Area % of MLA', live: (s) => s.areaPCmla || 0, mock: () => 0 },
    { value: 'vacant', label: 'Vacant Units', live: (s) => s.vacant || 0, mock: () => 0 },
    { value: 'unrentable', label: 'Unrentable Units', live: (s) => s.unrentable || 0, mock: () => 0 },
  ]},
  { group: 'Rent & Rate', items: [
    { value: 'rent', label: 'Rent Roll (£)', live: (s) => s.rent || 0, mock: (s) => s.rentRoll || 0 },
    { value: 'gpot', label: 'Gross Potential (£)', live: (s) => s.gpot || 0, mock: () => 0 },
    { value: 'grossOcc', label: 'Gross Occupied (£)', live: (s) => s.grossOcc || 0, mock: () => 0 },
    { value: 'rpu', label: 'Rent per Unit (£)', live: (s) => s.rpu || 0, mock: () => 0 },
    { value: 'rate', label: 'Rate per ft² (£)', live: (s) => s.rate || 0, mock: () => 0 },
    { value: 'realRate', label: 'Total Real Rate per ft² (£)', live: (s) => s.realRate || 0, mock: () => 0 },
    { value: 'occActualRent', label: 'Actual Occupied Unit Rates (£)', live: (s) => s.occActualRent || 0, mock: () => 0 },
  ]},
  { group: 'Indoor Self Storage', items: [
    { value: 'ss.occ', label: 'Self Storage Occupied Units', live: (s) => (s.ss && s.ss.occ) || 0, mock: () => 0 },
    { value: 'ss.tot', label: 'Self Storage Total Units', live: (s) => (s.ss && s.ss.tot) || 0, mock: () => 0 },
    { value: 'ss.occPC', label: 'Self Storage Occupancy %', live: (s) => (s.ss && s.ss.occPC) || 0, mock: () => 0 },
    { value: 'ss.occA', label: 'Self Storage Occupied Area (ft²)', live: (s) => (s.ss && s.ss.occA) || 0, mock: () => 0 },
    { value: 'ss.rate', label: 'Self Storage Rate per ft² (£)', live: (s) => (s.ss && s.ss.rate) || 0, mock: () => 0 },
    { value: 'ss.real', label: 'Self Storage Real Rate per ft² (£)', live: (s) => (s.ss && s.ss.real) || 0, mock: () => 0 },
    { value: 'ss.rent', label: 'Self Storage Rent Roll (£)', live: (s) => (s.ss && s.ss.rent) || 0, mock: () => 0 },
    { value: 'ss.gpot', label: 'Self Storage Gross Potential (£)', live: (s) => (s.ss && s.ss.gpot) || 0, mock: () => 0 },
  ]},
  { group: 'Offices', items: [
    { value: 'offices.occ', label: 'Offices Occupied Units', live: (s) => (s.offices && s.offices.occ) || 0, mock: () => 0 },
    { value: 'offices.tot', label: 'Offices Total Units', live: (s) => (s.offices && s.offices.tot) || 0, mock: () => 0 },
    { value: 'offices.occPC', label: 'Offices Occupancy %', live: (s) => (s.offices && s.offices.occPC) || 0, mock: () => 0 },
    { value: 'offices.rate', label: 'Offices Rate per ft² (£)', live: (s) => (s.offices && s.offices.rate) || 0, mock: () => 0 },
  ]},
  { group: 'Move-ins, Move-outs & Reservations', items: [
    { value: 'moveIns', label: 'Move-ins', live: (s) => s.moveIns || 0, mock: () => 0 },
    { value: 'moveOuts', label: 'Move-outs', live: (s) => s.moveOuts || 0, mock: () => 0 },
    { value: 'netArea', label: 'Net ft² (Move-ins/outs)', live: (s) => s.netArea || 0, mock: () => 0 },
    { value: 'moveOutsYear', label: 'Move-outs (year to date)', live: (s) => s.moveOutsYear || 0, mock: () => 0 },
    { value: 'scheduledOuts', label: 'Scheduled Move-outs', live: (s) => s.scheduledOuts || 0, mock: () => 0 },
    { value: 'reservations', label: 'Reservations (InquiryTracking)', live: (s) => s.reservations || 0, mock: () => 0 },
    { value: 'activeReservations', label: 'Active Reservations', live: (s) => s.activeReservations || 0, mock: () => 0 },
  ]},
  { group: 'Debtors', items: [
    { value: 'debtors.total', label: 'Debtors: Total Overdue (£, 30+ days)', live: (s) => (s.debtors && s.debtors.total) || 0, mock: () => 0 },
    { value: 'debtors.accounts', label: 'Debtors: Accounts Overdue (30+ days)', live: (s) => (s.debtors && s.debtors.accounts) || 0, mock: () => 0 },
    { value: 'debtors.allOverdue', label: 'Debtors: All Overdue (£, any age)', live: (s) => (s.debtors && s.debtors.allOverdue) || 0, mock: () => 0 },
    { value: 'debtors.tenantPct', label: 'Debtor Levels: % Tenants', live: (s) => (s.debtors && s.debtors.tenantPct) || 0, mock: () => 0 },
    { value: 'debtors.rentRollPct', label: 'Debtor Levels: % Rent Roll', live: (s) => (s.debtors && s.debtors.rentRollPct) || 0, mock: () => 0 },
  ]},
  { group: 'Insurance', items: [
    { value: 'insurance.insured', label: 'Insurance: Insured Units', live: (s) => (s.insurance && s.insurance.insured) || 0, mock: () => 0 },
    { value: 'insurance.premium', label: 'Insurance: Monthly Premium (£)', live: (s) => (s.insurance && s.insurance.premium) || 0, mock: () => 0 },
    { value: 'insurance.penetration', label: 'Insurance: Penetration %', live: (s) => (s.insurance && s.insurance.penetration) || 0, mock: () => 0 },
    { value: 'insuranceActivity.newPolicies', label: 'Insurance: New Move-in Policies', live: (s) => (s.insuranceActivity && s.insuranceActivity.newPolicies) || 0, mock: () => 0 },
    { value: 'insuranceActivity.newPremium', label: 'Insurance: New Premium (£)', live: (s) => (s.insuranceActivity && s.insuranceActivity.newPremium) || 0, mock: () => 0 },
    { value: 'insuranceActivity.cancellations', label: 'Insurance: Cancellations', live: (s) => (s.insuranceActivity && s.insuranceActivity.cancellations) || 0, mock: () => 0 },
  ]},
  { group: 'Enquiries', items: [
    { value: 'enquiries.total', label: 'Enquiries: Total', live: (s) => (s.enquiries && s.enquiries.total) || 0, mock: () => 0 },
    { value: 'enquiries.conversions', label: 'Enquiries: Conversions', live: (s) => (s.enquiries && s.enquiries.conversions) || 0, mock: () => 0 },
    { value: 'enquiries.phone', label: 'Enquiries: Phone', live: (s) => (s.enquiries && s.enquiries.phone) || 0, mock: () => 0 },
    { value: 'enquiries.walkin', label: 'Enquiries: Walk-ins', live: (s) => (s.enquiries && s.enquiries.walkin) || 0, mock: () => 0 },
    { value: 'enquiries.web', label: 'Enquiries: Web (+Email)', live: (s) => (s.enquiries && s.enquiries.web) || 0, mock: () => 0 },
    { value: 'enquiries.webOnly', label: 'Enquiries: Web only', live: (s) => (s.enquiries && s.enquiries.webOnly) || 0, mock: () => 0 },
    { value: 'enquiries.email', label: 'Enquiries: Email only', live: (s) => (s.enquiries && s.enquiries.email) || 0, mock: () => 0 },
  ]},
  { group: 'Merchandise & Revenue', items: [
    { value: 'merchandise.sales', label: 'Merchandise: Sales (£)', live: (s) => (s.merchandise && s.merchandise.sales) || 0, mock: () => 0 },
    { value: 'merchandise.cost', label: 'Merchandise: Cost (£)', live: (s) => (s.merchandise && s.merchandise.cost) || 0, mock: () => 0 },
    { value: 'merchandise.margin', label: 'Merchandise: Margin (£)', live: (s) => (s.merchandise && s.merchandise.margin) || 0, mock: () => 0 },
    { value: 'revenue.collected', label: 'Revenue: Collected (£)', live: (s) => (s.revenue && s.revenue.collected) || 0, mock: () => 0 },
    { value: 'revenue.charge', label: 'Revenue: Charged (£)', live: (s) => (s.revenue && s.revenue.charge) || 0, mock: () => 0 },
    { value: 'revenue.payment', label: 'Revenue: Payments (£)', live: (s) => (s.revenue && s.revenue.payment) || 0, mock: () => 0 },
    { value: 'revenue.discount', label: 'Revenue: Discounts (£)', live: (s) => (s.revenue && s.revenue.discount) || 0, mock: () => 0 },
  ]},
  { group: 'Rate Changes & Marketing', items: [
    { value: 'rateChanges.increases', label: 'Rate Changes: Increases', live: (s) => (s.rateChanges && s.rateChanges.increases) || 0, mock: () => 0 },
    { value: 'rateChanges.decreases', label: 'Rate Changes: Decreases', live: (s) => (s.rateChanges && s.rateChanges.decreases) || 0, mock: () => 0 },
    { value: 'rateChanges.avgPct', label: 'Rate Changes: Avg Increase %', live: (s) => (s.rateChanges && s.rateChanges.avgPct) || 0, mock: () => 0 },
    { value: 'marketing.tenants', label: 'Marketing: Tenants', live: (s) => (s.marketing && s.marketing.tenants) || 0, mock: () => 0 },
    { value: 'marketing.commercial', label: 'Marketing: Commercial Tenants', live: (s) => (s.marketing && s.marketing.commercial) || 0, mock: () => 0 },
    { value: 'marketing.residential', label: 'Marketing: Residential Tenants', live: (s) => (s.marketing && s.marketing.residential) || 0, mock: () => 0 },
    { value: 'marketing.avgRent', label: 'Marketing: Avg Rent (£)', live: (s) => (s.marketing && s.marketing.avgRent) || 0, mock: () => 0 },
  ]},
  { group: 'Autobill & Tenancy', items: [
    { value: 'autobillRate', label: 'Autobill Rate % (whole book)', live: (s) => s.autobillRate || 0, mock: () => 0 },
    { value: 'autobillCount', label: 'Autobill Tenants (whole book)', live: (s) => s.autobillCount || 0, mock: () => 0 },
    { value: 'tenantsCount', label: 'Total Tenants (whole book)', live: (s) => s.tenantsCount || 0, mock: () => 0 },
    { value: 'autobillNewCount', label: 'Autobill: New Autobilled Tenants (this month)', live: (s) => s.autobillNewCount || 0, mock: () => 0 },
    { value: 'autobillNewTotal', label: 'Autobill: New Tenants (this month)', live: (s) => s.autobillNewTotal || 0, mock: () => 0 },
    { value: 'avgStayDays', label: 'Average Length of Stay (days)', live: (s) => s.avgStayDays || 0, mock: () => 0 },
  ]},
];
const FIELD_INDEX = Object.fromEntries(FIELD_CATALOG.flatMap((g) => g.items).map((f) => [f.value, f]));
const fieldLabel = (v) => (FIELD_INDEX[v] ? FIELD_INDEX[v].label : v);
const fieldValue = (s, v, isLive) => {
  const f = FIELD_INDEX[v];
  if (!f) return 0;
  const n = isLive ? f.live(s) : f.mock(s);
  return Number.isFinite(n) ? n : 0;
};
const OP_SYMBOL = { '/': '÷', '*': '×', '+': '+', '-': '−' };
const applyOp = (a, op, b) => op === '/' ? (b ? a / b : 0) : op === '*' ? a * b : op === '+' ? a + b : a - b;
// Evaluate a widget's 2-4 column formula left-to-right, e.g. fields=[rent, occA, tot] ops=[/, *]
// -> (rent / occA) * tot. `isLive` picks each field's live vs. mock accessor.
function evalWidget(s, w, isLive) {
  const fields = w.fields && w.fields.length ? w.fields : [w.a, w.b];   // back-compat with old {a,b,sign} shape
  const ops = w.ops && w.ops.length ? w.ops : [w.sign || '/'];
  let v = fieldValue(s, fields[0], isLive);
  for (let i = 1; i < fields.length; i++) v = applyOp(v, ops[i - 1] || '/', fieldValue(s, fields[i], isLive));
  return v;
}

// ---------------------------------------------------------------------------
// Small chart primitives (verbatim ports of hbars/vbars/lineChart/donut/gauge)
// ---------------------------------------------------------------------------
function HBars({ items, opts = {} }) {
  const max = opts.max || Math.max(...items.map((i) => i.value), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '104px 1fr minmax(70px, auto)', alignItems: 'center', gap: '12px' }}>
          <div style={{ fontSize: '12.5px', color: '#475467', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.label}</div>
          <div style={{ height: '10px', borderRadius: '6px', background: C.track, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: Math.min(100, (it.value / max) * 100) + '%', borderRadius: '6px', background: it.color || C.blue, transition: 'width .6s cubic-bezier(.2,.8,.2,1)' }} />
          </div>
          <div style={{ fontSize: '12.5px', fontWeight: 600, color: '#101828', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{it.disp}</div>
        </div>
      ))}
    </div>
  );
}

function VBars({ items, opts = {} }) {
  const max = opts.max || Math.max(...items.map((i) => i.value), 1);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '18px', height: '170px', padding: '6px 4px 0' }}>
      {items.map((it, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', height: '100%', justifyContent: 'flex-end' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#101828', fontVariantNumeric: 'tabular-nums' }}>{it.disp}</div>
          <div style={{ width: '100%', maxWidth: '72px', height: Math.max(4, (it.value / max) * 118) + 'px', borderRadius: '8px 8px 3px 3px', background: it.color || C.blue, transition: 'height .6s cubic-bezier(.2,.8,.2,1)' }} />
          <div style={{ fontSize: '11.5px', color: '#667085', textAlign: 'center', whiteSpace: 'nowrap' }}>{it.label}</div>
        </div>
      ))}
    </div>
  );
}

// Portfolio comparison bar chart: one vertical bar PER STORE, all stores shown by default
// (per Michael, 2 Jul 2026 — the dashboard's job is "which store is underperforming compared to
// the rest of the portfolio", not a month-over-month trend, so trend LineCharts are wrong here).
// Sortable (defaults to highest-first, since that's the most common "who's the outlier" reading),
// and horizontally scrollable since a full portfolio (27+ stores) won't fit one screen width.
function StoreBarChart({ items, opts = {} }) {
  const [sortDir, setSortDir] = useState('desc');
  const sorted = items.slice().sort((a, b) => sortDir === 'desc' ? b.value - a.value : a.value - b.value);
  // Pinned summary bar (legacy portal parity: every per-store comparison chart ends with an
  // "Average" bar — or "Total" for count charts like Rate Increases). opts.average =
  // { value, disp, label? }. Excluded from sorting (always last), included in the scale.
  const summaryBar = opts.average ? { label: opts.average.label || 'Average', value: opts.average.value, disp: opts.average.disp, color: C.slate } : null;
  const shown = summaryBar ? [...sorted, summaryBar] : sorted;
  const vals = shown.map((i) => i.value);
  const max = opts.max || Math.max(...vals, 1);
  // Scale from the lowest value (not always 0) when the metric is a bounded ratio (e.g. % of CLA)
  // rather than a raw magnitude — otherwise every store's bar looks nearly identical because real
  // stores cluster in a narrow band (e.g. 60-95%) that gets compressed against a 0 baseline.
  const min = opts.zero === false ? Math.min(...vals, 0) : 0;
  const range = (max - min) || 1;
  const BAR_H = 140;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
        <button onClick={() => setSortDir((d) => d === 'desc' ? 'asc' : 'desc')}
          style={{ display: 'flex', alignItems: 'center', gap: '5px', background: '#F9FAFB', border: '1px solid #EAECF0', borderRadius: '8px', padding: '5px 10px', fontSize: '11.5px', fontWeight: 600, color: '#475467', cursor: 'pointer' }}>
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none">
            {sortDir === 'desc'
              ? <path d="M12 4v16M12 20l-5-5M12 20l5-5" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              : <path d="M12 20V4M12 4l-5 5M12 4l5 5" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
          </svg>
          {sortDir === 'desc' ? 'Highest → lowest' : 'Lowest → highest'}
        </button>
      </div>
      {/* Bars widened + value label rotated vertically (6 Jul 2026, Michael: "make the values easy
          to read, maybe put them vertically") — with 27 stores crammed into 30px columns the old
          10px horizontal value text either overlapped neighbors or had to shrink unreadably small.
          Rotating the value to match the already-vertical store-name label below lets both use a
          bigger, bolder font in the same footprint. */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '7px', height: '236px', padding: '6px 2px 0', overflowX: 'auto' }}>
        {shown.map((it, i) => (
          <div key={i} title={it.label + ': ' + it.disp} style={{ flex: '0 0 auto', width: '38px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', height: '100%', justifyContent: 'flex-end' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#101828', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: '56px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{it.disp}</div>
            <div style={{ width: '100%', maxWidth: '26px', height: Math.max(4, ((it.value - min) / range) * BAR_H) + 'px', borderRadius: '4px 4px 2px 2px', background: it.color || C.blue, transition: 'height .6s cubic-bezier(.2,.8,.2,1)' }} />
            <div style={{ fontSize: '10.5px', color: '#667085', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', width: '100%', writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: '66px' }}>{it.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LineChart({ series, opts = {} }) {
  const W = 620, H = 150, pad = 8;
  const all = series.flatMap((s) => s.values);
  let min = Math.min(...all), max = Math.max(...all);
  if (opts.zero) min = Math.min(min, 0);
  if (max === min) max = min + 1;
  const n = series[0].values.length;
  const x = (i) => pad + (i / (n - 1)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - min) / (max - min)) * (H - pad * 2);
  const gid = useMemo(() => 'g' + Math.random().toString(36).slice(2, 7), []);
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 16px', marginBottom: '6px' }}>
        {series.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#667085' }}>
            <span style={{ width: '10px', height: '3px', borderRadius: '2px', background: s.color, display: 'inline-block', opacity: s.dashed ? 0.6 : 1 }} />
            {s.name}
          </div>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="150" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={series[0].color} stopOpacity={0.18} />
            <stop offset="100%" stopColor={series[0].color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((f, i) => (
          <line key={i} x1={pad} x2={W - pad} y1={pad + f * (H - pad * 2)} y2={pad + f * (H - pad * 2)} stroke="#F2F4F7" strokeWidth={1} />
        ))}
        <path d={`M ${series[0].values.map((v, i) => x(i) + ' ' + y(v)).join(' L ')} L ${x(n - 1)} ${H - pad} L ${x(0)} ${H - pad} Z`} fill={`url(#${gid})`} />
        {series.map((s, si) => (
          <polyline key={si} points={s.values.map((v, i) => x(i) + ',' + y(v)).join(' ')} fill="none" stroke={s.color} strokeWidth={2.4} strokeDasharray={s.dashed ? '5 4' : '0'} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ))}
        {series.filter((s) => !s.dashed).map((s, si) => (
          <circle key={'c' + si} cx={x(n - 1)} cy={y(s.values[n - 1])} r={3.6} fill={s.color} stroke="#fff" strokeWidth={2} />
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '10.5px', color: '#98A2B3' }}>
        {(opts.labels || []).map((l, i) => <span key={i}>{l}</span>)}
      </div>
    </div>
  );
}

function Donut({ pct, color }) {
  const r = 42, circ = 2 * Math.PI * r, dash = (Math.max(0, Math.min(100, pct)) / 100) * circ;
  return (
    <div style={{ position: 'relative', width: '104px', height: '104px' }}>
      <svg viewBox="0 0 104 104" width="104" height="104">
        <circle cx={52} cy={52} r={r} fill="none" stroke={C.track} strokeWidth={11} />
        <circle cx={52} cy={52} r={r} fill="none" stroke={color} strokeWidth={11} strokeLinecap="round" strokeDasharray={`${dash} ${circ}`} transform="rotate(-90 52 52)" style={{ transition: 'stroke-dasharray .7s cubic-bezier(.2,.8,.2,1)' }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', fontWeight: 700, color: '#0C1425' }}>{Math.round(pct)}%</div>
    </div>
  );
}

function Gauge({ pct }) {
  const p = Math.max(0, Math.min(100, pct)), cx = 60, cy = 58, r = 46;
  const ang = Math.PI * (1 - p / 100);
  const ex = cx + r * Math.cos(ang), ey = cy - r * Math.sin(ang);
  const color = p >= 70 ? C.green : p >= 50 ? C.amber : C.red;
  return (
    <div style={{ position: 'relative', width: '120px', height: '76px' }}>
      <svg viewBox="0 0 120 72" width="120" height="72">
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke={C.track} strokeWidth={11} strokeLinecap="round" />
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${ex} ${ey}`} fill="none" stroke={color} strokeWidth={11} strokeLinecap="round" style={{ transition: 'all .7s cubic-bezier(.2,.8,.2,1)' }} />
      </svg>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: '2px', textAlign: 'center', fontSize: '18px', fontWeight: 700, color: '#0C1425' }}>{Math.round(pct)}%</div>
    </div>
  );
}

// Nav icons (verbatim path data from navGroups())
function NavIcon({ id }) {
  const defs = {
    dashboard: (
      <>
        <rect x={3} y={3} width={8} height={8} rx={2} stroke="currentColor" strokeWidth={2} />
        <rect x={13} y={3} width={8} height={8} rx={2} stroke="currentColor" strokeWidth={2} />
        <rect x={3} y={13} width={8} height={8} rx={2} stroke="currentColor" strokeWidth={2} />
        <rect x={13} y={13} width={8} height={8} rx={2} stroke="currentColor" strokeWidth={2} />
      </>
    ),
    kpis: <path d="M4 19V5M4 19h16M8 15l3-4 3 3 4-6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />,
    financials: <path d="M12 3v18M8 7h5a3 3 0 0 1 0 6H8m0 0h6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />,
    ancillaries: (
      <>
        <path d="M3 12a9 9 0 1 1 18 0 9 9 0 0 1-18 0Z" stroke="currentColor" strokeWidth={2} />
        <path d="M12 8v4l3 2" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      </>
    ),
    marketing: (
      <>
        <path d="M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1Z" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
        <path d="M17 9a3 3 0 0 1 0 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      </>
    ),
    mom: (
      <>
        <rect x={3} y={4} width={18} height={17} rx={2} stroke="currentColor" strokeWidth={2} />
        <path d="M3 9h18M8 2v4M16 2v4" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      </>
    ),
    unitmix: (
      <>
        <rect x={3} y={3} width={7} height={7} stroke="currentColor" strokeWidth={2} />
        <rect x={14} y={3} width={7} height={4} stroke="currentColor" strokeWidth={2} />
        <rect x={3} y={14} width={4} height={7} stroke="currentColor" strokeWidth={2} />
        <rect x={11} y={12} width={10} height={9} stroke="currentColor" strokeWidth={2} />
      </>
    ),
  };
  return <svg width={18} height={18} viewBox="0 0 24 24" fill="none">{defs[id]}</svg>;
}

// Minimal DataTable — the original template mounted an externally-registered
// `<dc-import name="DataTable">` widget whose internals were not part of the
// decoded source. This is a plain-React reconstruction matching the visual
// language used elsewhere in the template (header row, threshold coloring,
// money/pct/ft formatting) with simple client-side pagination via pageSize.
function formatCell(type, value) {
  if (value == null) return '';
  switch (type) {
    case 'int': return intFmt(value);
    case 'money': return money(value);
    case 'money2': return '£' + Number(value).toFixed(2);
    case 'pct': return Number(value).toFixed(1) + '%';
    case 'ft': return intFmt(value) + ' ft²';
    // Added 8 Jul 2026 (Michael: "the ticks that show the net changes with arrows and they're red or
    // green" — for the Rates per ft² table specifically, as percent change vs last month rather than
    // an absolute £ diff). Pairs with color:'delta' on the column def, which colors by the raw
    // (unformatted) value's sign — this only formats the text/arrow.
    case 'pctDelta': {
      const n = Number(value);
      if (!isFinite(n)) return '';
      const arrow = n > 0 ? '↑ ' : n < 0 ? '↓ ' : '';
      const sign = n > 0 ? '+' : '';
      return arrow + sign + n.toFixed(1) + '%';
    }
    default: return String(value);
  }
}
function thresholdColor(value) {
  if (value >= 85) return C.green;
  if (value >= 70) return C.amber;
  return C.red;
}
// `totals` (optional): object keyed by column key with pre-computed portfolio totals/averages for
// this table — rendered as a pinned footer row (visible on every pagination page), matching the
// legacy portal's month-labelled totals row at the bottom of every per-store table. Sums are
// summed and rates/percentages are re-derived sum-then-divide by the CALLER (same rule as
// computeTotals — never average per-site rates here). `totalsLabel` is the first-column label
// ("Total" or "Average").
function DataTable({ title, columns, rows, live, pageSize = 12, totals, totalsLabel }) {
  // Scrollbar instead of pagination (6 Jul 2026, Michael: "instead of having pages on the widgets
  // that have lots of information, make it a scroll bar for that widget" — every row is in the DOM
  // at once, capped to a fixed viewport height (~pageSize rows) with its own internal scrollbar, so
  // the outer page just has ONE page-level scrollbar plus one inner scrollbar per tall widget,
  // rather than Prev/Next click-through pagination). Header row is sticky so it stays visible while
  // scrolling within the widget. Only kicks in when there are more rows than fit — short tables are
  // unaffected (maxHeight simply never gets reached).
  const ROW_H = 41; // approx rendered row height (padding 11px*2 + line height) — used to cap scroll viewport to ~pageSize rows
  const needsScroll = rows.length > pageSize;
  return (
    <div style={{ background: '#fff', border: '1px solid #EAECF0', borderRadius: '16px', boxShadow: '0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '14px 18px', borderBottom: '1px solid #F2F4F7' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.blue }} />
        <span style={{ fontSize: '12.5px', fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: '#475467', flex: 1 }}>{title}</span>
        {live && <span style={{ fontSize: '9.5px', fontWeight: 700, letterSpacing: '.08em', color: '#08875D', background: '#E7F6EF', borderRadius: '5px', padding: '2px 6px' }}>LIVE</span>}
      </div>
      <div style={{ overflowX: 'auto', overflowY: needsScroll ? 'auto' : 'visible', maxHeight: needsScroll ? (ROW_H * pageSize) + 'px' : undefined }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', fontSize: '13.5px', minWidth: '560px' }}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} style={{ textAlign: c.align === 'right' ? 'right' : 'left', padding: '11px 18px', fontSize: '11px', fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085', background: '#F9FAFB', borderBottom: '1px solid #EAECF0', position: needsScroll ? 'sticky' : undefined, top: needsScroll ? 0 : undefined, zIndex: 1 }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {columns.map((c) => {
                  const raw = row[c.key];
                  const display = formatCell(c.type, raw);
                  let color = '#1D2939';
                  if (c.key === columns[0].key) color = '#101828';
                  if (c.color === 'threshold' && typeof raw === 'number') color = thresholdColor(raw);
                  // Legacy True Revenue convention (confirmed against Michael's screenshot): red = negative
                  // value, green = positive value, zero stays neutral black — applied per-cell, not per-column
                  // (e.g. "Tax Adj"/"Adjustments" read red on almost every row simply because those SiteLink
                  // figures are consistently negative reductions, while "Deferred Rev" reads green because
                  // it's consistently positive — it's the sign driving the color, not the column itself).
                  if (c.color === 'delta' && typeof raw === 'number') color = raw < 0 ? C.red : raw > 0 ? C.green : '#1D2939';
                  return (
                    <td key={c.key} style={{ padding: '11px 18px', textAlign: c.align === 'right' ? 'right' : 'left', color, fontWeight: c.key === columns[0].key ? 500 : 400, borderBottom: '1px solid #F2F4F7', fontVariantNumeric: c.type && c.type !== 'text' ? 'tabular-nums' : undefined }}>{display}</td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {totals && (
            <tfoot>
              <tr>
                {columns.map((c, ci) => (
                  <td key={c.key} style={{ padding: '11px 18px', textAlign: c.align === 'right' ? 'right' : 'left', color: '#101828', fontWeight: 700, background: '#F9FAFB', borderTop: '2px solid #EAECF0', fontVariantNumeric: c.type && c.type !== 'text' ? 'tabular-nums' : undefined }}>
                    {ci === 0 ? (totalsLabel || 'Total') : (totals[c.key] != null ? formatCell(c.type, totals[c.key]) : '')}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function PortalV2Page() {
  const STORES = useMemo(buildStores, []);
  const REGIONS = useMemo(() => [...new Set(STORES.map((s) => s.region))], [STORES]);
  const MONTHS = useMemo(buildMonths, []);

  const [page, setPage] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState({});
  const [region, setRegion] = useState('All');
  const [period, setPeriod] = useState('1M');
  const [monthFrom, setMonthFrom] = useState(17);
  const [monthTo, setMonthTo] = useState(17);
  const [storePopOpen, setStorePopOpen] = useState(false);
  const [periodPopOpen, setPeriodPopOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSel, setExportSel] = useState({});
  const [builderOpen, setBuilderOpen] = useState(false);
  // Builder now supports 2-4 columns: builderFields[i] paired with builderOps[i-1] between
  // columns i-1 and i (evaluated left-to-right — see evalWidget() above). Defaults mirror the old
  // 2-field Rent Roll ÷ Occupied Area widget.
  const [builderFields, setBuilderFields] = useState(['rent', 'occA']);
  const [builderOps, setBuilderOps] = useState(['/']);
  const [builderName, setBuilderName] = useState('');
  const [customWidgets, setCustomWidgets] = useState([]);
  const [updated, setUpdated] = useState('just now');
  const [spin, setSpin] = useState(false);

  // Live data (dashboard KPI row + Rates per ft² table only so far). Everything else on every
  // page continues to read from the RAW_STORES-derived mock data above.
  const [liveTotals, setLiveTotals] = useState(null); // portfolio.totals, or null if unavailable/unconfigured
  // Named liveSitesRaw (not liveSites) because buildPage() below shadows `liveSites` with a
  // store-filtered view of this array — every live widget reads the shadowed name, so the top
  // store-selector filter applies everywhere automatically instead of needing per-widget edits.
  const [liveSitesRaw, setLiveSitesRaw] = useState(null); // portfolio.sites[], or null if unavailable/unconfigured
  // Previous single month's sites[] (8 Jul 2026), fetched via the same fast ranged endpoint solely to
  // power the "vs last month" delta/arrow ticks on a few Dashboard KPI cards — see fetchLiveRange().
  // null whenever there's no valid comparison (earliest stored month, a multi-month range selected, or
  // the fetch failed) — the affected tiles just render with no arrow in that case, same as before this
  // existed.
  const [livePrevSitesRaw, setLivePrevSitesRaw] = useState(null);
  const [liveMonthly, setLiveMonthly] = useState(null); // portfolio.monthly (per-month, per-site LIGHT records)
  const [liveMonths, setLiveMonths] = useState(null);   // portfolio.months (sorted ascending "YYYY-MM" strings) — ALWAYS the full stored history, never scoped to the selector, so Month-on-Month and the selector's own dropdowns keep working regardless of what's picked
  const [liveHistory, setLiveHistory] = useState(null); // portfolio.history (one point per stored month, portfolio-wide) — powers Month-on-Month, unaffected by the PERIOD selector below
  const [viewLive, setViewLive] = useState(true);       // false once a specific month/range has been picked and successfully loaded (vs. the default live-current-month view)

  const reloadTimer = useRef(null);
  const rangeInitialized = useRef(false);   // snaps monthFrom/monthTo to the real latest month exactly once, the first time liveMonths loads — never overrides a month the person has since picked themselves
  const initialFetchStarted = useRef(false); // FIXED 7 Jul 2026 (Michael: "total units is 51 less than legacy portal... go through and double check July"): Next.js dev runs in React StrictMode, which double-invokes mount effects — the mount useEffect below was calling fetchLiveTotals() TWICE in quick succession. Both calls' async .then() callbacks saw rangeInitialized.current still false-then-true in a race: call A correctly snapped monthFrom/monthTo to the latest month (July) and fetched it, but call B's callback closed over the STALE pre-snap monthFrom/monthTo (still 17 = June) and re-fetched June AFTER call A, silently clobbering the correct July data back to June on every single page load — not just occasionally. This guard makes the second StrictMode invocation a no-op so only one fetch chain ever runs.

  // Index <-> "YYYY-MM" key helpers (index 0 = Jan 2025; negative indices reach back into real stored
  // history, e.g. 2016). FIXED 7 Jul 2026 (Michael: "date picker only lets me see up to Jan 2025",
  // then "seeing data for every store which can't be right"): `(idx % 12) + 1` used JS's `%`, which
  // keeps the sign of the DIVIDEND — for any negative idx (any month before 2025) this produces m=0 or
  // a negative number instead of 1-12 (e.g. idx=-103 should be June, but `-103 % 12` is -7, giving
  // m=-6). That corrupted BOTH the dropdown labels (garbled/blank for most pre-2025 months) AND the
  // actual date sent to the server when one was selected — `new Date(y, m-1, 1)` with an out-of-range
  // month silently ROLLS OVER to a different, wrong year/month instead of erroring, so a selection that
  // looked like a specific historical month could silently fetch a different one instead. Fixed with a
  // true floor-based modulo (`idx - Math.floor(idx/12)*12`), which is always in [0,11] regardless of
  // idx's sign.
  const monthKeyOf = (idx) => { const y = 2025 + Math.floor(idx / 12), m = idx - Math.floor(idx / 12) * 12 + 1; return `${y}-${String(m).padStart(2, '0')}`; };
  const indexOfMonthKey = (mk) => { const [y, m] = mk.split('-').map(Number); return (y - 2025) * 12 + (m - 1); };

  // Global PERIOD selector (Michael, 6 Jul 2026): fetches the FULL detail for a specific from/to
  // month range from /api/portfolio's ?from/?to params (server computes this live from already-
  // stored raw data — see lib/buildPayload.js's buildPayloadRange()) and swaps liveTotals/
  // liveSitesRaw to it, so every widget on every page switches to that month/range. Deliberately
  // does NOT touch liveMonthly/liveMonths/liveHistory — those stay as the full unscoped history so
  // Month-on-Month and the selector's own dropdown options are unaffected by what's currently picked.
  const fetchLiveRange = (fromKey, toKey, onSettled) => {
    fetch(`/api/portfolio?from=${fromKey}&to=${toKey}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data || !data.configured || !data.totals) {
          console.warn(`[portal-v2] /api/portfolio?from=${fromKey}&to=${toKey} returned no data — keeping the current view.`);
          onSettled && onSettled();
          return;
        }
        setLiveTotals(data.totals);
        setLiveSitesRaw(Array.isArray(data.sites) ? data.sites : null);
        setViewLive(fromKey === toKey && toKey === (liveMonths && liveMonths[liveMonths.length - 1]));
        onSettled && onSettled();
      })
      .catch((err) => { console.warn(`[portal-v2] /api/portfolio?from=${fromKey}&to=${toKey} fetch failed.`, err); onSettled && onSettled(); });

    // "vs last month" delta ticks (8 Jul 2026, Michael: "put the ticks that show the net changes with
    // arrows... on the 29 pull one") — only meaningful for a single selected month, compared against
    // the one calendar month right before it. A multi-month range has no single obvious "previous
    // period" (previous equal-length range? previous single month?), so we deliberately don't guess —
    // livePrevSitesRaw just goes null, which makes the delta ticks disappear rather than mislead.
    if (fromKey === toKey) {
      const prevKey = monthKeyOf(indexOfMonthKey(fromKey) - 1);
      fetch(`/api/portfolio?from=${prevKey}&to=${prevKey}`)
        .then((res) => res.json())
        // Checking data.totals (not just data.configured) matters here: buildPayloadRange() returns
        // configured:true with totals:null and sites:[] for an out-of-range month (e.g. fromKey is
        // already the earliest stored month) — without this, an empty-but-truthy [] would flow through
        // to computeTotals([]), which returns all-zero totals instead of null, and deltaTick() would
        // then render a fake "100% up" arrow against that phantom zero instead of correctly hiding it.
        .then((data) => setLivePrevSitesRaw(data && data.configured && data.totals && Array.isArray(data.sites) ? data.sites : null))
        .catch(() => setLivePrevSitesRaw(null));
    } else {
      setLivePrevSitesRaw(null);
    }
  };

  const fetchLiveTotals = (onInitialSettled) => {
    fetch('/api/portfolio')
      .then((res) => res.json())
      .then((data) => {
        if (!data || !data.configured || !data.totals) {
          console.warn('[portal-v2] /api/portfolio not configured — dashboard KPI row + rate table + trend charts are using mock data.');
          setLiveTotals(null);
          setLiveSitesRaw(null);
          setLiveMonthly(null);
          setLiveMonths(null);
          setLiveHistory(null);
          onInitialSettled && onInitialSettled();
          return;
        }
        // FIXED 8 Jul 2026 (Michael: "remove the first pull that does 27 sites, it's annoying"): this
        // unscoped call reads the PERSISTED portal_payload singleton, which lags behind live raw data
        // (only refreshed by npm run pull / cron). It used to set liveTotals/liveSitesRaw here too, so
        // every load briefly rendered its stale site count/totals before fetchLiveRange() below
        // (always computed live from raw_report, and fast since the 8 Jul buildPayloadRange fix)
        // overwrote it moments later. Now this call ONLY supplies the month-list/history metadata that
        // only the unscoped payload has — liveTotals/liveSitesRaw are set exclusively by
        // fetchLiveRange, so the UI goes straight from loading/mock to correct live data, no stale
        // flash in between.
        setLiveMonthly(data.monthly && typeof data.monthly === 'object' ? data.monthly : null);
        const months = Array.isArray(data.months) ? data.months : null;
        setLiveMonths(months);
        setLiveHistory(Array.isArray(data.history) ? data.history : null);

        if (months && months.length) {
          if (!rangeInitialized.current) {
            // First successful load: snap the selector to the real latest stored month instead of
            // the placeholder index-17 default, then ACTUALLY FETCH that month — FIXED 6 Jul 2026:
            // this used to only call setMonthFrom/setMonthTo without fetching, so the selector
            // visually showed the latest month while every widget kept showing whatever the
            // unscoped default payload happened to be (stale/pinned to a different month from an
            // earlier rebuild-as-of.js run) — exactly the "Debtor Levels/Past Due Balances show 0"
            // symptom, since that stale default happened to be a month with no past_due data.
            rangeInitialized.current = true;
            const latestKey = months[months.length - 1];
            const latestIdx = indexOfMonthKey(latestKey);
            setMonthFrom(latestIdx); setMonthTo(latestIdx);
            fetchLiveRange(latestKey, latestKey, onInitialSettled);
          } else {
            // A specific month/range is already selected (or was on a previous load) — re-fetch it
            // instead of silently falling back to whatever the unscoped default just returned.
            fetchLiveRange(monthKeyOf(monthFrom), monthKeyOf(monthTo), onInitialSettled);
          }
        } else {
          onInitialSettled && onInitialSettled();
        }
      })
      .catch((err) => {
        console.warn('[portal-v2] /api/portfolio fetch failed — dashboard KPI row + rate table + trend charts are using mock data.', err);
        setLiveTotals(null);
        setLiveSitesRaw(null);
        setLiveMonthly(null);
        setLiveMonths(null);
        setLiveHistory(null);
        onInitialSettled && onInitialSettled();
      });
  };

  // reload(): mirrors the original DCLogic method — toggles the loading skeleton
  // and is invoked by every state-changing action (nav clicks, filters, refresh).
  // Hooked here to also re-fetch live totals so a manual refresh pulls fresh data.
  const reload = () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    setLoading(true);
    fetchLiveTotals();
    reloadTimer.current = setTimeout(() => setLoading(false), 550);
  };

  useEffect(() => {
    // FIXED 8 Jul 2026 (Michael: "still that annoying fake pull from the 27 sites" — after the earlier
    // fix removed the STALE-real-27-site flash, a NEW 27-site flash appeared in its place). Root cause:
    // RAW_STORES (the mock fallback data above) hardcodes exactly 27 stores. liveSitesRaw now stays
    // null until the real fetch chain resolves, but this skeleton used to hide on a FIXED 700ms timer —
    // shorter than the actual chain (unscoped /api/portfolio for month metadata, THEN a second ranged
    // fetch for the real numbers, sequential, over a real network). Once the skeleton cleared before
    // that chain finished, every "kpiT ? live : mock" fallback rendered the 27-store mock data —
    // visually identical to the old bug even though the mechanism is completely different. Fix: hide
    // the skeleton when the real fetch chain actually finishes; this timer is now only a safety net so
    // the skeleton can't get stuck forever if a fetch hangs.
    const safety = setTimeout(() => setLoading(false), 4000);
    if (!initialFetchStarted.current) {
      initialFetchStarted.current = true;
      fetchLiveTotals(() => { clearTimeout(safety); setLoading(false); });
    }
    const onDocClick = (e) => {
      if (storePopOpen || periodPopOpen) {
        if (!e.target.closest || !e.target.closest('select')) {
          setStorePopOpen(false);
          setPeriodPopOpen(false);
        }
      }
    };
    document.addEventListener('click', onDocClick, true);
    return () => {
      clearTimeout(safety);
      document.removeEventListener('click', onDocClick, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredStores = () => {
    const anySel = Object.values(selected).some(Boolean);
    return STORES.filter((s) => {
      if (region !== 'All' && s.region !== region) return false;
      if (anySel && !selected[s.name]) return false;
      return true;
    });
  };
  const factor = () => filteredStores().length / STORES.length;

  const momLabels = () => {
    const s = 6;
    return MONTHS.slice(s, s + 12).map((m) => m.label.replace(' 20', " '"));
  };

  // selectRange(): the ONE place that actually swaps the whole portal's view to a specific month or
  // from/to range (Michael, 6 Jul 2026 — the PERIOD selector was previously decorative, see
  // fetchLiveRange() above). Fetches with the EXACT indices passed in, rather than reading
  // monthFrom/monthTo state back out — React state updates are async, so a handler that calls
  // setMonthFrom(x) then immediately reads monthFrom would still see the OLD value.
  const selectRange = (fromIdx, toIdx) => {
    setMonthFrom(fromIdx); setMonthTo(toIdx);
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    setLoading(true);
    fetchLiveRange(monthKeyOf(fromIdx), monthKeyOf(toIdx));
    reloadTimer.current = setTimeout(() => setLoading(false), 550);
  };

  const applyPreset = (pl) => {
    // Anchor "latest" to the real most-recent stored month once live data has loaded, instead of the
    // hardcoded index-17 (Jun 2026) placeholder — otherwise every preset would silently stop
    // updating once actual data moves past whatever month was hardcoded here.
    const latestIdx = liveMonths && liveMonths.length ? indexOfMonthKey(liveMonths[liveMonths.length - 1]) : 17;
    const earliestIdx = liveMonths && liveMonths.length ? indexOfMonthKey(liveMonths[0]) : 0;
    let from = latestIdx;
    if (pl === '3M') from = latestIdx - 2;
    else if (pl === '6M') from = latestIdx - 5;
    else if (pl === '12M') from = latestIdx - 11;
    else if (pl === 'YTD') from = indexOfMonthKey(`${monthKeyOf(latestIdx).slice(0, 4)}-01`);
    else if (pl === 'All') from = earliestIdx;
    setPeriod(pl);
    selectRange(Math.max(earliestIdx, from), latestIdx);
  };

  // ---------- page content (verbatim port of buildPage()) ----------
  function buildPage() {
    const fs = filteredStores();
    const f = factor();
    // Store-name filter for live data: same `selected` toggle state the mock filteredStores() above
    // uses. Region filtering can't apply to live sites (no region field on real data — same gap
    // flagged throughout this file), so only the individual store checkboxes take effect here; "All"
    // (nothing individually selected) shows every live site, matching filteredStores()'s own rule.
    // This shadows the `liveSitesRaw` state for the rest of buildPage() — every widget below that
    // reads `liveSites` automatically gets the filtered view without being edited individually.
    const liveSites = (() => {
      if (!liveSitesRaw) return null;
      const anySel = Object.values(selected).some(Boolean);
      if (!anySel) return liveSitesRaw;
      return liveSitesRaw.filter((s) => selected[s.name]);
    })();
    // Same store-filter mirror as liveSites, applied to last month's snapshot — feeds the "vs last
    // month" delta ticks below so they respect the store filter exactly like every other live number.
    const livePrevSites = (() => {
      if (!livePrevSitesRaw) return null;
      const anySel = Object.values(selected).some(Boolean);
      if (!anySel) return livePrevSitesRaw;
      return livePrevSitesRaw.filter((s) => selected[s.name]);
    })();
    const agg = fs.reduce((a, s) => {
      a.occupied += s.occupied; a.total += s.total; a.area += s.area; a.rentRoll += s.rentRoll; a.claW += s.occupied * s.claPct;
      return a;
    }, { occupied: 0, total: 0, area: 0, rentRoll: 0, claW: 0 });
    const occPct = agg.total ? (agg.occupied / agg.total) * 100 : 0;
    const claPct = agg.occupied ? agg.claW / agg.occupied : 0;
    const gross = occPct ? agg.rentRoll / (occPct / 100) : 0;
    const out = { kpiRow: [], statCards: [], tables: [], chartCards: [], unitMix: [] };

    if (page === 'dashboard') {
      // --- KPI row: live-wired for these 6 tiles only ---
      let useLive = false;
      let t = null;
      if (liveSites) {
        useLive = true;
        t = computeTotals(liveSites);   // recomputed client-side so the store filter applies (see computeTotals)
      } else {
        // Fallback mock path (also used if /api/portfolio is unconfigured or errors).
        console.warn('[portal-v2] KPI row rendering with mock RAW_STORES data (no live totals available).');
      }

      if (useLive) {
        // Defensive fallback to 0 per-field: a stale/incomplete portal_payload row (e.g. written
        // before claA/claPC existed) should degrade a single tile to "0.0%" rather than crash the
        // whole dashboard. If you see 0s here, re-run `npm run pull` to refresh portal_payload.
        const claPC = t.claPC ?? 0;
        out.kpiRow = [
          { label: 'Occupancy (% of CLA)', value: claPC.toFixed(1) + '%', delta: null, dir: null, sub: 'vs last month' },
          { label: 'Occupied Units', value: intFmt(t.occ ?? 0), delta: null, dir: null, sub: 'of ' + intFmt(t.tot ?? 0) },
        ];
      } else {
        out.kpiRow = [
          { label: 'Occupancy (% of CLA)', value: occPct.toFixed(1) + '%', delta: '1.4%', dir: 'up', sub: 'vs last month' },
          { label: 'Occupied Units', value: intFmt(agg.occupied), delta: '42', dir: 'up', sub: 'of ' + intFmt(agg.total) },
        ];
      }

      // Portfolio Occupancy: live-wired from /api/portfolio's per-site array. occPct <- occPC,
      // claPct <- areaPC (per-site "% of CLA": occA/claA when claA is known, else occA/totA — same
      // rule used everywhere else, e.g. recordFor() in lib/buildPayload.js), rentRoll <- rent.
      // Same "no region field on live data" gap as the Rates per ft² table below.
      const liveOccRows = liveSites ? liveSites.map((s) => ({
        name: s.name, occupied: s.occ || 0, total: s.tot || 0, occPct: s.occPC || 0, claPct: s.areaPC || 0, rentRoll: s.rent || 0,
      })) : null;
      if (!liveOccRows) console.warn('[portal-v2] Portfolio Occupancy table rendering with mock RAW_STORES data (no live sites available).');
      // Totals row (legacy parity: the legacy portal's per-store tables all end with a portfolio
      // totals row). Sums for units/rent; occupancy %s re-derived sum-then-divide (t.occPC/t.claPC
      // from computeTotals on the live path — never an average of per-site %s).
      const occTotals = (liveOccRows && t)
        ? { occupied: t.occ ?? 0, total: t.tot ?? 0, occPct: t.occPC ?? 0, claPct: t.claPC ?? 0, rentRoll: t.rent ?? 0 }
        : { occupied: agg.occupied, total: agg.total, occPct: +occPct.toFixed(1), claPct: +claPct.toFixed(1), rentRoll: agg.rentRoll };
      out.tables = [{
        title: 'Portfolio Occupancy', live: true, pageSize: 12, wide: true, totals: occTotals, totalsLabel: 'Total',
        columns: liveOccRows ? [
          { key: 'name', label: 'Location', type: 'text' },
          { key: 'occupied', label: 'Occupied', type: 'int', align: 'right' }, { key: 'total', label: 'Total', type: 'int', align: 'right' },
          { key: 'occPct', label: 'Occupancy %', type: 'pct', align: 'right', color: 'threshold' }, { key: 'claPct', label: '% of CLA', type: 'pct', align: 'right', color: 'threshold' },
          { key: 'rentRoll', label: 'Rent Roll', type: 'money', align: 'right' },
        ] : [
          { key: 'name', label: 'Location', type: 'text' }, { key: 'region', label: 'Region', type: 'text' },
          { key: 'occupied', label: 'Occupied', type: 'int', align: 'right' }, { key: 'total', label: 'Total', type: 'int', align: 'right' },
          { key: 'occPct', label: 'Occupancy %', type: 'pct', align: 'right', color: 'threshold' }, { key: 'claPct', label: '% of CLA', type: 'pct', align: 'right', color: 'threshold' },
          { key: 'rentRoll', label: 'Rent Roll', type: 'money', align: 'right' },
        ],
        rows: liveOccRows || fs,
      }];
      // Rates per ft²: live-wired from /api/portfolio's per-site array when available.
      // Column mapping (matches the SS/Total × asking/real pattern used everywhere else in the
      // backend, e.g. legacyRecord()'s rate_ss_sqft / rate_total_sqft / real_rate_ss_sqft /
      // real_rate_total_sqft): selfRate <- ssRate, totalRate <- rate, realRate <- ssReal,
      // realTotal <- realRate. NOTE: the backend has no "region" field per site (region only
      // exists in the mock RAW_STORES data), so that column is dropped for live rows rather than
      // showing a fabricated value — a real region mapping would need to be added upstream first.
      // Per-site "vs last month" % change (8 Jul 2026, Michael, confirmed via screenshot that THIS
      // table — not the Dashboard KPI cards — is "the 29 pull one" he meant): uses livePrevSites, the
      // same previous-month fetch that powers the KPI cards' delta ticks, matched by site code. A
      // local prevT here rather than reusing kpiT/kpiPrevT below, since those aren't declared until
      // later in this same function.
      const prevByCode = livePrevSites ? Object.fromEntries(livePrevSites.map((s) => [s.code, s])) : {};
      const prevT = livePrevSites ? computeTotals(livePrevSites) : null;
      const pctChange = (cur, prev) => (prev == null || !prev) ? null : R2((cur - prev) / prev * 100);
      const liveRateRows = liveSites ? liveSites.map((s) => {
        const p = prevByCode[s.code];
        return {
          name: s.name, selfRate: s.ssRate || 0, totalRate: s.rate || 0, realRate: s.ssReal || 0, realTotal: s.realRate || 0, area: s.occA || 0,
          selfRateD: p ? pctChange(s.ssRate || 0, p.ssRate) : null,
          totalRateD: p ? pctChange(s.rate || 0, p.rate) : null,
          realRateD: p ? pctChange(s.ssReal || 0, p.ssReal) : null,
          realTotalD: p ? pctChange(s.realRate || 0, p.realRate) : null,
        };
      }) : null;
      const mockRateRows = fs.map((s) => ({ name: s.name, region: s.region, selfRate: s.rate, totalRate: +(s.rate * 0.957).toFixed(2), realRate: +(s.rate * 0.925).toFixed(2), realTotal: +(s.rate * 0.89).toFixed(2), area: s.area }));
      if (!liveRateRows) console.warn('[portal-v2] Rates per ft² table rendering with mock RAW_STORES data (no live sites available).');
      // Average row (legacy parity: the legacy Rate/Real Rate tables end with a portfolio average
      // row). Live path reuses computeTotals' weighted rates (Σ rent ÷ Σ area × 12 — never a mean
      // of per-site rates); mock path weights each mock rate by that store's occupied area.
      const rateTotals = (liveRateRows && t)
        ? { selfRate: t.ssRate ?? 0, totalRate: t.rate ?? 0, realRate: t.ssReal ?? 0, realTotal: t.realRate ?? 0, area: t.occA ?? 0,
            selfRateD: prevT ? pctChange(t.ssRate ?? 0, prevT.ssRate) : null,
            totalRateD: prevT ? pctChange(t.rate ?? 0, prevT.rate) : null,
            realRateD: prevT ? pctChange(t.ssReal ?? 0, prevT.ssReal) : null,
            realTotalD: prevT ? pctChange(t.realRate ?? 0, prevT.realRate) : null,
          }
        : (() => {
            const aSum = mockRateRows.reduce((a, r) => a + r.area, 0);
            const w = (k) => aSum ? R2(mockRateRows.reduce((a, r) => a + r[k] * r.area, 0) / aSum) : 0;
            return { selfRate: w('selfRate'), totalRate: w('totalRate'), realRate: w('realRate'), realTotal: w('realTotal'), area: aSum };
          })();
      out.tables.push({
        title: 'Rates per ft² (All Stores)', live: true, pageSize: 12, wide: true, totals: rateTotals, totalsLabel: 'Average',
        columns: liveRateRows ? [
          { key: 'name', label: 'Location', type: 'text' },
          { key: 'selfRate', label: 'Self Storage Rate', type: 'money2', align: 'right' },
          { key: 'selfRateD', label: 'Δ SS Rate', type: 'pctDelta', align: 'right', color: 'delta' },
          { key: 'totalRate', label: 'Total Rate', type: 'money2', align: 'right' },
          { key: 'totalRateD', label: 'Δ Total Rate', type: 'pctDelta', align: 'right', color: 'delta' },
          { key: 'realRate', label: 'Self Storage Real Rate', type: 'money2', align: 'right' },
          { key: 'realRateD', label: 'Δ SS Real Rate', type: 'pctDelta', align: 'right', color: 'delta' },
          { key: 'realTotal', label: 'Total Real Rate', type: 'money2', align: 'right' },
          { key: 'realTotalD', label: 'Δ Total Real Rate', type: 'pctDelta', align: 'right', color: 'delta' },
          { key: 'area', label: 'Occupied Area', type: 'ft', align: 'right' },
        ] : [
          { key: 'name', label: 'Location', type: 'text' }, { key: 'region', label: 'Region', type: 'text' },
          { key: 'selfRate', label: 'Self Storage Rate', type: 'money2', align: 'right' }, { key: 'totalRate', label: 'Total Rate', type: 'money2', align: 'right' },
          { key: 'realRate', label: 'Self Storage Real Rate', type: 'money2', align: 'right' }, { key: 'realTotal', label: 'Total Real Rate', type: 'money2', align: 'right' },
          { key: 'area', label: 'Occupied Area', type: 'ft', align: 'right' },
        ],
        rows: liveRateRows || mockRateRows,
      });
      out.statCards = [
        (() => {
          // Move-ins & Move-outs: sum each site's moveIns/moveOuts/netArea (from lib/buildPayload.js,
          // sourced from ManagementSummary) across all live sites — same live-data pattern as Enquiries.
          if (liveSites) {
            const sum = (k) => liveSites.reduce((a, s) => a + (s[k] || 0), 0);
            return { title: 'Move-ins & Move-outs', tiles: [
              { value: intFmt(sum('moveIns')), label: 'Move-ins', delta: null, dir: null },
              { value: intFmt(sum('moveOuts')), label: 'Move-outs', delta: null, dir: null },
              { value: intFmt(sum('netArea')) + ' ft²', label: 'Net ft²', delta: null, dir: null },
            ] };
          }
          console.warn('[portal-v2] Move-ins & Move-outs stat card rendering with mock RAW_STORES data (no live sites available).');
          return { title: 'Move-ins & Move-outs', tiles: [
            { value: intFmt(112 * f), label: 'Move-ins', delta: '12', dir: 'up' }, { value: intFmt(86 * f), label: 'Move-outs', delta: '1', dir: 'up' }, { value: intFmt(2040 * f) + ' ft²', label: 'Net ft²', delta: '160', dir: 'up' },
          ] };
        })(),
        (() => {
          // Enquiries — single source of truth: sum each site's `enquiries` object (itself computed
          // from lib/reportMap.js's lead_funnel/InquiryTracking parser per the locked spec) across
          // ALL live sites — same "no region filter on live data" caveat as the rate table/charts.
          if (liveSites) {
            const sum = (k) => liveSites.reduce((a, s) => a + ((s.enquiries && s.enquiries[k]) || 0), 0);
            return { title: 'Enquiries', tiles: [
              { value: intFmt(sum('phone')), label: 'Phone', delta: null, dir: null },
              { value: intFmt(sum('walkin')), label: 'Walk-ins', delta: null, dir: null },
              { value: intFmt(sum('web')), label: 'Web', delta: null, dir: null },
              { value: intFmt(sum('total')), label: 'Total', delta: null, dir: null },
            ] };
          }
          console.warn('[portal-v2] Enquiries stat card rendering with mock RAW_STORES data (no live sites available).');
          return { title: 'Enquiries', tiles: [
            { value: intFmt(94 * f), label: 'Phone', delta: '2', dir: 'up' }, { value: intFmt(61 * f), label: 'Walk-ins', delta: '2', dir: 'down' }, { value: intFmt(1210 * f), label: 'Web', delta: '10', dir: 'up' }, { value: intFmt(1365 * f), label: 'Total', delta: '10', dir: 'up' },
          ] };
        })(),
      ];
      // Dashboard comparison charts: per Michael (2 Jul 2026), the dashboard's job is portfolio
      // comparison ("which store is underperforming"), not a month-over-month trend — so these are
      // vertical bar charts, one bar PER STORE, current month only, all stores shown by default
      // (region/store filters, when applied elsewhere on the page, narrow `fs`/`liveSites` before
      // this point same as every other dashboard widget). Trend-over-time, if needed, belongs on a
      // dedicated analytics page or a per-store drill-down — not here.
      // NOTE: unlike the mock's region/checkbox filter (fs), live sites have no "region" field
      // (same gap flagged on the Rates per ft² table), so all live sites are shown unfiltered here.
      const thresholdColorFor = (v) => v >= 85 ? C.green : v >= 75 ? C.amber : C.red;
      const liveAreaBars = liveSites ? liveSites.map((s) => ({ label: s.name, value: s.occA || 0, disp: intFmt(s.occA || 0) + ' ft²', color: C.blue })) : null;
      const liveRateBars = liveSites ? liveSites.map((s) => ({ label: s.name, value: s.ssRate || 0, disp: '£' + (s.ssRate || 0).toFixed(2), color: C.teal })) : null;
      const liveClaBars = liveSites ? liveSites.map((s) => ({ label: s.name, value: s.areaPC || 0, disp: (s.areaPC || 0).toFixed(1) + '%', color: thresholdColorFor(s.areaPC || 0) })) : null;
      if (!liveAreaBars) console.warn('[portal-v2] Dashboard comparison charts rendering with mock RAW_STORES data (no live sites available).');

      // Pinned "Average" bar on each comparison chart (legacy parity — the legacy portal's bar
      // charts all end with an Average bar). Area = mean per store; rate/% = the portfolio's
      // weighted figure (computeTotals) on the live path, mean of mock values otherwise.
      const nBars = liveSites ? liveSites.length : fs.length;
      const avgArea = (liveAreaBars && t) ? (nBars ? (t.occA ?? 0) / nBars : 0) : (fs.length ? agg.area / fs.length : 0);
      const avgSSRate = (liveRateBars && t) ? (t.ssRate ?? 0) : (fs.length ? fs.reduce((a, s) => a + s.rate, 0) / fs.length : 0);
      const avgCla = (liveClaBars && t) ? (t.claPC ?? 0) : (fs.length ? fs.reduce((a, s) => a + s.claPct, 0) / fs.length : 0);
      out.chartCards = [
        { title: 'Rented Area by Store', el: <StoreBarChart items={liveAreaBars || fs.map((s) => ({ label: s.name, value: s.area, disp: intFmt(s.area) + ' ft²', color: C.blue }))} opts={{ average: { value: avgArea, disp: intFmt(avgArea) + ' ft²' } }} /> },
        { title: 'Self Storage Rate per ft² by Store', el: <StoreBarChart items={liveRateBars || fs.map((s) => ({ label: s.name, value: s.rate, disp: '£' + s.rate.toFixed(2), color: C.teal }))} opts={{ average: { value: avgSSRate, disp: '£' + avgSSRate.toFixed(2) } }} /> },
        { title: 'Occupied Area % of CLA by Store', el: <StoreBarChart items={liveClaBars || fs.map((s) => ({ label: s.name, value: s.claPct, disp: s.claPct.toFixed(1) + '%', color: thresholdColorFor(s.claPct) }))} opts={{ zero: false, average: { value: avgCla, disp: avgCla.toFixed(1) + '%' } }} /> },
      ];
      customWidgets.forEach((w) => {
        // Custom widgets: use live per-site records when a live pull is loaded (evalWidget's `live`
        // accessors), falling back to mock RAW_STORES data (evalWidget's `mock` accessors, which
        // only cover the original 6 fields) only when no live data is available yet.
        const isLive = !!liveSites;
        const src = liveSites || fs;
        const items = src.slice().sort((a, b) => evalWidget(b, w, isLive) - evalWidget(a, w, isLive)).slice(0, 8).map((s) => {
          const v = evalWidget(s, w, isLive);
          return { label: s.name, value: Math.abs(v), disp: (Math.round(v * 100) / 100).toLocaleString('en-GB'), color: C.teal };
        });
        out.chartCards.push({
          title: w.name, el: <HBars items={items} />, removable: true,
          onRemove: () => setCustomWidgets((cur) => cur.filter((x) => x.id !== w.id)),
          dotColor: C.teal,
        });
      });
    }

    else if (page === 'kpis') {
      // Total Store Occupancy / Indoor Self Storage / Offices Occupancy stat cards: live-wired from
      // /api/portfolio's totals. Per the legacy portal's own tooltip (confirmed 2 Jul 2026):
      //   Occupancy: Occupancy Statistics → Unit Mix → sum of occupied/total units (for that type)
      //   Rent / Occupied Area: Rent Roll → sum of Rent / unit Area (for that type)
      //   Rate per ft² = (Rent / Occupied Area) * 12
      // totals.occPC/rate already follow this for the whole store; totals.ssOccPC/ssRate and
      // totals.officesOccPC/officesRate (added to lib/buildPayload.js) do the same for the
      // Indoor Self Storage and Offices unit types specifically.
      const kpiT = liveSites ? computeTotals(liveSites) : null;   // recomputed client-side so the store filter applies
      if (!kpiT) console.warn('[portal-v2] KPIs stat cards rendering with mock RAW_STORES data (no live totals available).');
      // "vs last month" comparator for the delta ticks below (8 Jul 2026) — null when unavailable
      // (earliest stored month, a multi-month range selected, or the prev-month fetch failed), in
      // which case deltaTick() falls back to {delta: null, dir: null} and the tile shows no arrow.
      const kpiPrevT = livePrevSites ? computeTotals(livePrevSites) : null;
      out.statCards = [
        kpiT
          ? { title: 'Total Store Occupancy', live: true, tiles: [{ value: (kpiT.occPC ?? 0).toFixed(1) + '%', label: 'Occupancy', ...deltaTick(kpiT.occPC, kpiPrevT && kpiPrevT.occPC, 'pct') }, { value: '£' + (kpiT.rate ?? 0).toFixed(2), label: 'Rate per ft²', ...deltaTick(kpiT.rate, kpiPrevT && kpiPrevT.rate, 'money') }], note: intFmt(kpiT.occ ?? 0) + ' / ' + intFmt(kpiT.tot ?? 0) + ' units occupied' }
          : { title: 'Total Store Occupancy', tiles: [{ value: occPct.toFixed(1) + '%', label: 'Occupancy', delta: '2%', dir: 'up' }, { value: '£28.46', label: 'Rate per ft²', delta: '£0.22', dir: 'up' }], note: intFmt(agg.occupied) + ' / ' + intFmt(agg.total) + ' units occupied' },
        kpiT
          ? { title: 'Indoor Self Storage', live: true, tiles: [{ value: (kpiT.ssOccPC ?? 0).toFixed(1) + '%', label: 'Occupancy', ...deltaTick(kpiT.ssOccPC, kpiPrevT && kpiPrevT.ssOccPC, 'pct') }, { value: '£' + (kpiT.ssRate ?? 0).toFixed(2), label: 'Rate per ft²', ...deltaTick(kpiT.ssRate, kpiPrevT && kpiPrevT.ssRate, 'money') }] }
          : { title: 'Indoor Self Storage', tiles: [{ value: (occPct + 1.1).toFixed(1) + '%', label: 'Occupancy', delta: '2%', dir: 'up' }, { value: '£29.74', label: 'Rate per ft²', delta: '£0.20', dir: 'up' }] },
        kpiT
          ? { title: 'Offices Occupancy', live: true, tiles: [{ value: (kpiT.officesOccPC ?? 0).toFixed(1) + '%', label: 'Occupancy', ...deltaTick(kpiT.officesOccPC, kpiPrevT && kpiPrevT.officesOccPC, 'pct') }, { value: '£' + (kpiT.officesRate ?? 0).toFixed(2), label: 'Rate per ft²', ...deltaTick(kpiT.officesRate, kpiPrevT && kpiPrevT.officesRate, 'money') }] }
          : { title: 'Offices Occupancy', tiles: [{ value: '78.0%', label: 'Occupancy', delta: '3%', dir: 'up' }, { value: '£61.90', label: 'Rate per ft²', delta: null, dir: null }] },
        // Reservations vs Move-outs: REBUILT 6 Jul 2026 (Michael's idea). The old ReservationList/
        // ScheduledMoveOuts-based version was confirmed structurally live-only on BOTH sides —
        // ReservationList has no date param at all and its "active" filter compares against
        // `new Date()` (today's real date, not any historical reference point); ScheduledMoveOuts
        // takes a date param but returns an IDENTICAL count regardless of it (confirmed via
        // npm run probe:scheduled-outs-historical). The legacy portal's own equivalent widget has the
        // exact same limitation — confirmed live in-browser (explicitly selecting "Last Month" still
        // showed the same numbers as "This Month"). So neither side could ever be historical.
        // FIX: rebuilt on two reports that ARE genuinely date-scoped — Reservations now comes from
        // lead_funnel (InquiryTracking)'s reservation-stage row count, confirmed via
        // npm run probe:lead-funnel-reservations to give real, different counts per month (6/24/12/
        // 15/19 across 5 test months) — and Move-outs now comes from ManagementSummary's actual
        // completed move-outs (already reliable, same source as the working Move-ins & Move-outs
        // widget), rather than "currently scheduled/pending" move-outs. This changes the widget's
        // meaning from "current pipeline snapshot" to "Reservations Made vs Move-outs Completed" for
        // the selected month/range — both sides now work for every stored month, live and historical,
        // like every other widget on this page. Renamed back from "...Scheduled Move-outs" since
        // Move-outs is no longer the scheduled/pending figure.
        // RE-CONFIRMED then SWITCHED BACK 7 Jul 2026 (Michael): re-investigated after a "~230 net
        // difference from legacy" report. Re-verified live in-browser that legacy's "Scheduled
        // Reservations vs Scheduled Move-outs" (KPIs page) is still a pure live snapshot — ignores the
        // date-range picker entirely (stayed on "Jul 2026" / 0-0-0 even with the picker set to Jan
        // 2026), unlike Debtor Levels right next to it, which does respect the picker. Legacy's July
        // figure was 0/0/0 at check time, likely their own backend hasn't refreshed since the month
        // rolled over (two other "current month" tiles on the same legacy page — Move-ins & Move-outs,
        // Autobill — showed the same all-zero pattern).
        // Pulled our OWN live activeReservations/scheduledOuts totals to see what the pre-6-Jul-rebuild
        // metric would read TODAY: 438 reservations / 267 scheduled move-outs / net +171 — vs. the
        // historical widget's 571 / 154 / +417. The ~246 gap between those two lines up with the
        // ~230 Michael originally flagged, confirming the "~230 difference" was this same live-vs-
        // historical mismatch, not a calculation error on either side. Notably, 438 lands very close to
        // the "~446 target" that task #25's old ~3x-overcount investigation was chasing — meaning the
        // occupied-tenant-ID filter already in `activeReservations` (see its definition above, ids
        // .filter(id => !occupiedIds.has(id))) already fixed that overcount; it just wasn't visible
        // here because the widget had moved on to a different metric.
        // Decision (Michael, 7 Jul): switch this widget BACK to the live snapshot
        // (activeReservations/scheduledOuts) — matches legacy's own methodology and is confirmed no
        // longer overcounted. Renamed to "Scheduled Reservations vs Scheduled Move-outs" so the title
        // makes the live-only, not-historical nature explicit — like every other "always current"
        // widget on this page (Move-ins & Move-outs, Autobill), this one will NOT change when the
        // global date-range picker is set to a past month, by design (there's no historical concept of
        // "how many reservations were open on a past date" — SiteLink doesn't track that).
        liveSites
          ? { title: 'Scheduled Reservations vs Scheduled Move-outs', live: true, tiles: [
              { value: intFmt(liveSites.reduce((a, s) => a + (s.activeReservations || 0), 0)), label: 'Reservations', delta: null, dir: null },
              { value: intFmt(liveSites.reduce((a, s) => a + (s.scheduledOuts || 0), 0)), label: 'Move-outs', delta: null, dir: null },
              { value: (() => { const n = liveSites.reduce((a, s) => a + (s.activeReservations || 0) - (s.scheduledOuts || 0), 0); return (n >= 0 ? '+' : '') + intFmt(n); })(), label: 'Net change', delta: null, dir: null },
            ] }
          // FIXED 7 Jul 2026 (exhaustive bug audit): this fallback used to hardcode the literal live
          // read from 7 Jul 2026 (438/267/+171), unscaled by the store-filter `f` — unlike every
          // other mock fallback on this page. That made it uniquely easy to mistake for a genuine
          // live read during a slow/failed fetch (the loading skeleton is on a fixed 700ms timer
          // decoupled from the actual fetch, and a fetch error leaves liveSites null with no other
          // visual cue besides the missing LIVE badge) — and it would have silently gone stale as
          // time passed. Now scaled by `f` like every sibling card, matching the established mock
          // pattern instead of masquerading as a frozen real snapshot.
          : { title: 'Scheduled Reservations vs Scheduled Move-outs', tiles: [{ value: intFmt(438 * f), label: 'Reservations', delta: null, dir: null }, { value: intFmt(267 * f), label: 'Move-outs', delta: null, dir: null }, { value: '+' + intFmt(171 * f), label: 'Net change', delta: null, dir: null }] },
        // Reserved Scheduled Sqft — added 6 Jul 2026 (Michael). ESTIMATE: ReservationList has no
        // area column (confirmed via probe:reservation-area); this is reservation count per
        // UnitTypeID × that type's average unit area (confirmed via probe:unittypeid-map — a
        // UnitTypeID spans multiple sizes, so an exact figure isn't possible). Also inherits the
        // known ~3x active-reservations overcount (Task #25) until that's fixed — treat this as
        // directional, not exact, same caveat as Reservations vs Scheduled Move-outs.
        // CHANGED 6 Jul 2026 (Michael): dropped the old hardcoded "always show June + July side by
        // side" two-tile design — now that the global PERIOD selector actually works, this widget
        // just shows ONE tile for whatever month/range is currently selected, same as every other
        // widget (was previously force-showing July even while viewing June, which made no sense).
        (() => {
          if (liveSites && liveSites.length) {
            const sqft = liveSites.reduce((a, s) => a + (s.reservedSqftEstimate || 0), 0);
            return { title: 'Reserved Scheduled Sqft', live: true, tiles: [{ value: intFmt(sqft) + ' ft²', label: 'Reserved', delta: null, dir: null }] };
          }
          return { title: 'Reserved Scheduled Sqft', tiles: [{ value: intFmt(2600 * f) + ' ft²', label: 'Reserved', delta: '140', dir: 'up' }] };
        })(),
        // Debtor Levels: live-wired from /api/portfolio's totals (lib/buildPayload.js). Per the
        // legacy portal's own tooltip (confirmed 2 Jul 2026): % Tenants = PastDueBalances
        // Delinquency Units / Occupancy Statistics Occupied Units; % Rent Roll = PastDueBalances
        // Delinquency Total / Occupancy Statistics Actual Occupied Unit Rates (the tooltip calls
        // the source "ManagementSummary", but the fields actually live in PastDueBalances/
        // OccupancyStatistics in this pipeline). Total = raw £ overdue, summed across sites.
        kpiT
          ? { title: 'Debtor Levels', live: true, tiles: [{ value: (kpiT.debtorTenantPct ?? 0).toFixed(1) + '%', label: '% Tenants', ...deltaTick(kpiT.debtorTenantPct, kpiPrevT && kpiPrevT.debtorTenantPct, 'pct') }, { value: (kpiT.debtorRentRollPct ?? 0).toFixed(1) + '%', label: '% Rent Roll', ...deltaTick(kpiT.debtorRentRollPct, kpiPrevT && kpiPrevT.debtorRentRollPct, 'pct') }, { value: money(kpiT.debtorTotal ?? 0), label: 'Total', ...deltaTick(kpiT.debtorTotal, kpiPrevT && kpiPrevT.debtorTotal, 'moneyWhole') }] }
          : { title: 'Debtor Levels', tiles: [{ value: '1.8%', label: '% Tenants', delta: '0%', dir: null }, { value: '0.6%', label: '% Rent Roll', delta: '0%', dir: null }, { value: money(2790 * f), label: 'Total', delta: '£93', dir: 'up' }] },
        // Move-ins & Move-outs: was present on the legacy portal's KPIs page (missed when this page
        // was first built — it only existed on the Dashboard page here) — same live-data pattern as
        // the Dashboard's copy: sum each site's moveIns/moveOuts/netArea (ManagementSummary).
        (() => {
          if (!liveSites) return { title: 'Move-ins & Move-outs', tiles: [
              { value: intFmt(112 * f), label: 'Move-ins', delta: '12', dir: 'up' }, { value: intFmt(86 * f), label: 'Move-outs', delta: '1', dir: 'up' }, { value: intFmt(2040 * f) + ' ft²', label: 'Net ft²', delta: '160', dir: 'up' },
            ] };
          const moveIns = liveSites.reduce((a, s) => a + (s.moveIns || 0), 0);
          const moveOuts = liveSites.reduce((a, s) => a + (s.moveOuts || 0), 0);
          const netArea = liveSites.reduce((a, s) => a + (s.netArea || 0), 0);
          // "vs last month" comparators — same livePrevSites source as kpiPrevT above, just reduced
          // directly since this card isn't computeTotals()-derived.
          const prevMoveIns = livePrevSites ? livePrevSites.reduce((a, s) => a + (s.moveIns || 0), 0) : null;
          const prevMoveOuts = livePrevSites ? livePrevSites.reduce((a, s) => a + (s.moveOuts || 0), 0) : null;
          const prevNetArea = livePrevSites ? livePrevSites.reduce((a, s) => a + (s.netArea || 0), 0) : null;
          return { title: 'Move-ins & Move-outs', live: true, tiles: [
              { value: intFmt(moveIns), label: 'Move-ins', ...deltaTick(moveIns, prevMoveIns, 'count') },
              { value: intFmt(moveOuts), label: 'Move-outs', ...deltaTick(moveOuts, prevMoveOuts, 'count') },
              { value: intFmt(netArea) + ' ft²', label: 'Net ft²', ...deltaTick(netArea, prevNetArea, 'count') },
            ] };
        })(),
        // Move-In Rental Rate — added 6 Jul 2026 from Michael's uploaded MoveInsAndMoveOuts export
        // ("rental rate (13) / area" — column 13, MovedInRentalRate, ÷ MovedInArea). Σ rate ÷ Σ area
        // × 12, same sum-then-divide/annualise convention as every other rate/ft² widget — the rate
        // achieved specifically on THIS month's new move-ins, as distinct from the whole-book Rate/
        // Real Rate widgets elsewhere.
        (() => {
          if (!liveSites) return { title: 'Move-In Rental Rate', tiles: [{ value: '£24.60', label: 'Per ft² (this month’s move-ins)', delta: '£0.80', dir: 'up' }] };
          const moveInRate = (sites) => { const area = sites.reduce((a, s) => a + (s.moveInAreaSum || 0), 0); return area ? R2(sites.reduce((a, s) => a + (s.moveInRateSum || 0), 0) / area * 12) : 0; };
          const rate = moveInRate(liveSites);
          const prevRate = livePrevSites ? moveInRate(livePrevSites) : null;
          return { title: 'Move-In Rental Rate', live: true, tiles: [{ value: '£' + rate.toFixed(2), label: 'Per ft² (this month’s move-ins)', ...deltaTick(rate, prevRate, 'money') }] };
        })(),
        // Increase in Sqft Rented — REMOVED 6 Jul 2026 (Michael). Still available as the "Net ft²"
        // tile on the Move-ins & Move-outs card above (mio.net_area) if needed again.
        // Autobill Conversion: live-wired from /api/portfolio's totals. Renamed from "Autobill" (2
        // Jul 2026, widget name review) to match the Ancillaries page's identical metric/tile —
        // both now compute "new autobilled customers / total new customers" per the legacy tooltip,
        // not the old whole-book autobill rate (kept as kpiT.autobillPC_allTenants if ever needed).
        kpiT
          ? { title: 'Autobill Conversion', live: true, tiles: [{ value: (kpiT.autobillPC ?? 0).toFixed(1) + '%', label: 'Autobill conversion', ...deltaTick(kpiT.autobillPC, kpiPrevT && kpiPrevT.autobillPC, 'pct') }], hasViz: true, el: <Donut pct={kpiT.autobillPC ?? 0} color={C.blue} /> }
          : { title: 'Autobill Conversion', tiles: [{ value: '86%', label: 'Autobill conversion', delta: '3%', dir: 'down' }], hasViz: true, el: <Donut pct={86} color={C.blue} /> },
        // Customer Churn: legacy formula is trailing-12-month move-outs / average occupancy over the
        // same 12 months (confirmed 2 Jul 2026). Live-wired (3 Jul 2026) against `liveHistory`
        // (portfolio history, one point per stored month — see lib/buildPayload.js) once at least 12
        // months are stored; falls back to mock until then (the pipeline only kept current+previous
        // month before — needs `npm run backfill 12` or more, see scripts/backfill.js). NOTE: like
        // the Month-on-Month trend charts, this is portfolio-wide and does not respect the
        // store/region filter (no per-site history retained yet).
        (() => {
          const h12 = (liveHistory && liveHistory.length >= 12) ? liveHistory.slice(-12) : null;
          if (h12) {
            const moveOutsSum = h12.reduce((a, m) => a + (m.moveOuts || 0), 0);
            const avgOcc = h12.reduce((a, m) => a + (m.occ || 0), 0) / h12.length;
            const churnPct = avgOcc ? R2(moveOutsSum / avgOcc * 100) : 0;
            return { title: 'Customer Churn', live: true, tiles: [{ value: churnPct.toFixed(1) + '%', label: 'Rolling 12-month', delta: null, dir: null }], hasViz: true, el: <Donut pct={churnPct} color={C.teal} /> };
          }
          if (liveHistory) console.warn(`[portal-v2] Customer Churn still mock — only ${liveHistory.length} month(s) of history stored (need 12). Run npm run backfill 12 (or more).`);
          return { title: 'Customer Churn', tiles: [{ value: '78.88%', label: 'Rolling 12-month', delta: '1%', dir: 'down' }], hasViz: true, el: <Donut pct={78.88} color={C.teal} /> };
        })(),
      ];
      // Occupied Area (% of MLA): live-wired per-store from areaPCmla (occA/totA — Maximum Lettable
      // Area, distinct from the CLA-based areaPC used elsewhere). Converted from HBars (horizontal,
      // top-8 only) to StoreBarChart per Michael (2 Jul 2026) — same vertical, all-stores,
      // sortable comparison pattern used on the dashboard, not a truncated top-N horizontal list.
      const liveMlaBars = liveSites ? liveSites.map((s) => ({ label: s.name, value: s.areaPCmla || 0, disp: (s.areaPCmla || 0).toFixed(1) + '%', color: (s.areaPCmla || 0) >= 85 ? C.green : (s.areaPCmla || 0) >= 75 ? C.amber : C.red })) : null;
      // Units / Rate per ft² by Customer Type: live-wired from totals.customerType (lib/buildPayload.js
      // sums RentRoll's per-site business/residential units, area and rent first, then divides once).
      const custT = kpiT?.customerType;
      // Rate Increases by Store: converted from a "per month" trend (needed 12mo history we don't
      // have) to a per-store CURRENT-MONTH comparison — TenantRentChangeHistory's increases count
      // is already captured per site (rec.rateChanges.increases), so this doesn't need history at
      // all, and fits the same "which store is the outlier" comparison philosophy as every other
      // dashboard/KPI chart.
      const liveRateIncBars = liveSites ? liveSites.map((s) => ({ label: s.name, value: (s.rateChanges && s.rateChanges.increases) || 0, disp: intFmt((s.rateChanges && s.rateChanges.increases) || 0), color: C.blue })) : null;
      if (!liveMlaBars || !custT || !liveRateIncBars) console.warn('[portal-v2] KPIs chart cards rendering with mock data (no live totals/customerType available).');
      // Pinned summary bars (legacy parity): % of MLA ends with a portfolio "Average" bar
      // (kpiT.areaPC = Σ occA ÷ Σ totA — MLA-based, sum-then-divide), Rate Increases with a
      // "Total" bar (legacy labels that chart's summary bar "Total", not "Average").
      const avgMla = (liveMlaBars && kpiT) ? (kpiT.areaPC ?? 0) : (fs.length ? fs.reduce((a, s) => a + s.occPct, 0) / fs.length : 0);
      const rateIncTotal = liveRateIncBars
        ? liveRateIncBars.reduce((a, b) => a + b.value, 0)
        : fs.reduce((a, s) => a + Math.round((38 * f) / fs.length) + (s.occupied % 5), 0);
      out.chartCards = [
        { title: 'Occupied Area (% of MLA) by Store', el: <StoreBarChart items={liveMlaBars || fs.map((s) => ({ label: s.name, value: s.occPct, disp: s.occPct.toFixed(1) + '%', color: s.occPct >= 85 ? C.green : s.occPct >= 75 ? C.amber : C.red }))} opts={{ zero: false, average: { value: avgMla, disp: avgMla.toFixed(1) + '%' } }} /> },
        { title: 'Units by Customer Type', el: <VBars items={custT ? [{ label: 'Personal', value: custT.residential.pct, disp: custT.residential.pct + '%', color: C.blue }, { label: 'Business', value: custT.business.pct, disp: custT.business.pct + '%', color: C.blue2 }] : [{ label: 'Personal', value: 81, disp: '81%', color: C.blue }, { label: 'Business', value: 19, disp: '19%', color: C.blue2 }]} opts={{ max: 100 }} /> },
        { title: 'Rate per ft² by Customer Type', el: <VBars items={custT ? [{ label: 'Personal', value: custT.residential.rate, disp: '£' + custT.residential.rate.toFixed(2), color: C.blue }, { label: 'Business', value: custT.business.rate, disp: '£' + custT.business.rate.toFixed(2), color: C.teal }] : [{ label: 'Personal', value: 29.1, disp: '£29.10', color: C.blue }, { label: 'Business', value: 31.4, disp: '£31.40', color: C.teal }]} opts={{ max: 40 }} /> },
        { title: 'Rate Increases by Store (Current Month)', el: <StoreBarChart items={liveRateIncBars || fs.map((s) => ({ label: s.name, value: Math.round((38 * f) / fs.length) + (s.occupied % 5), disp: intFmt(Math.round((38 * f) / fs.length) + (s.occupied % 5)), color: C.blue }))} opts={{ average: { label: 'Total', value: rateIncTotal, disp: intFmt(rateIncTotal) } }} /> },
      ];
      const unitDefs = [['9 ft²', 'Locker', 4, 36], ['15 ft²', 'Locker', 16, 240], ['25 ft²', 'Small', 31, 775], ['35 ft²', 'Small', 78, 2730], ['50 ft²', 'Medium', 88, 4400], ['75 ft²', 'Medium', 40, 3000], ['100 ft²', 'Large', 13, 1300], ['125 ft²', 'Large', 10, 1250], ['150 ft²', 'Large', 9, 1350], ['180 ft²', 'Drive Up', 2, 360], ['200 ft²', 'Drive Up', 3, 600], ['250 ft²', 'Enterprise', 2, 500]];
      // Unit Mix Occupancy: live-wired from /api/portfolio's per-site `unitMix` array (lib/reportMap.js's
      // occupancy parser groups Indoor Self Storage rows by rounded per-unit Area — see `ssSizes` in the
      // occupancy.parse() comments). We sum tot/occ/total_area across all sites per size bucket, then
      // divide once (never average per-site occupancy %s). No "Type" column exists on live data (unit_mix
      // only covers Indoor Self Storage, not Locker/Small/Medium/Large/Drive Up/Enterprise categories),
      // so that column is dropped for live rows rather than fabricated.
      const liveUnitMixRows = liveSites ? (() => {
        const bySize = {};
        for (const s of liveSites) for (const m of (s.unitMix || [])) {
          const k = m.area; const b = (bySize[k] ??= { size: k, total: 0, occupied: 0, area: 0 });
          b.total += m.tot || 0; b.occupied += m.occ || 0; b.area += m.total_area || 0;
        }
        return Object.values(bySize).sort((a, b) => a.size - b.size).map((b) => ({
          size: b.size + ' ft²', total: b.total, occupied: b.occupied, available: b.total - b.occupied,
          area: b.area, occPct: b.total ? +(b.occupied / b.total * 100).toFixed(1) : 0,
        }));
      })() : null;
      if (!liveUnitMixRows || !liveUnitMixRows.length) console.warn('[portal-v2] Unit Mix Occupancy table rendering with mock data (no live unitMix available).');
      const unitMixRows = (liveUnitMixRows && liveUnitMixRows.length) ? liveUnitMixRows : unitDefs.map(([size, type, baseUnits, baseArea]) => {
        const total = Math.round(baseUnits * 12 * f);
        const occPct2 = 70 + ((baseUnits * 7 + baseArea) % 30);
        const occ = Math.round((total * occPct2) / 100);
        return { size, type, total, occupied: occ, available: total - occ, area: Math.round(baseArea * 12 * f), occPct: +occPct2.toFixed(1) };
      });
      // Totals row: sums per column, occupancy % re-derived from the summed units (sum-then-divide).
      const unitMixTotals = (() => {
        const s = (k) => unitMixRows.reduce((a, r) => a + (r[k] || 0), 0);
        const tot = s('total'), occ = s('occupied');
        return { total: tot, occupied: occ, available: s('available'), area: s('area'), occPct: tot ? +(occ / tot * 100).toFixed(1) : 0 };
      })();
      out.tables.push({
        title: 'Unit Mix Occupancy (All Stores)', live: true, pageSize: 12, wide: true, totals: unitMixTotals, totalsLabel: 'Total',
        columns: (liveUnitMixRows && liveUnitMixRows.length) ? [
          { key: 'size', label: 'Unit Size', type: 'text' },
          { key: 'total', label: 'Total Units', type: 'int', align: 'right' }, { key: 'occupied', label: 'Occupied', type: 'int', align: 'right' },
          { key: 'available', label: 'Available', type: 'int', align: 'right' }, { key: 'area', label: 'Area (ft²)', type: 'ft', align: 'right' },
          { key: 'occPct', label: 'Occupancy %', type: 'pct', align: 'right', color: 'threshold' },
        ] : [
          { key: 'size', label: 'Unit Size', type: 'text' }, { key: 'type', label: 'Type', type: 'text' },
          { key: 'total', label: 'Total Units', type: 'int', align: 'right' }, { key: 'occupied', label: 'Occupied', type: 'int', align: 'right' },
          { key: 'available', label: 'Available', type: 'int', align: 'right' }, { key: 'area', label: 'Area (ft²)', type: 'ft', align: 'right' },
          { key: 'occPct', label: 'Occupancy %', type: 'pct', align: 'right', color: 'threshold' },
        ],
        rows: unitMixRows,
      });
      // Units by Customer Type — by Store: live-wired from /api/portfolio's per-site `customerType`
      // (lib/reportMap.js's rent_roll parser splits occupied units into business/residential by
      // bCorporate/bCommercial/sCompany). personal <- residential.units, business <- business.units,
      // rate <- s.rate (same Total Rate used in the Rates per ft² table). No region field on live data
      // (same gap as the other live tables), so that column is dropped for live rows.
      const liveCustTypeRows = liveSites ? liveSites.map((s) => {
        const ct = s.customerType || {};
        const personal = ct.residential?.units || 0, business = ct.business?.units || 0, tot = personal + business;
        return { name: s.name, personal, business, personalPct: tot ? +(personal / tot * 100).toFixed(1) : 0, rate: s.rate || 0 };
      }) : null;
      if (!liveCustTypeRows) console.warn('[portal-v2] Units by Customer Type table rendering with mock RAW_STORES data (no live sites available).');
      const custTypeRowsAll = liveCustTypeRows || fs.map((s) => {
        const business = Math.round(s.occupied * (0.14 + (s.total % 13) / 100));
        return { name: s.name, region: s.region, personal: s.occupied - business, business, personalPct: +(((s.occupied - business) / s.occupied) * 100).toFixed(1), rate: s.rate };
      });
      // Totals row: unit sums; % Personal re-derived from the summed units; rate = portfolio
      // weighted Total Rate (kpiT.rate, Σ rent ÷ Σ area × 12) on the live path.
      const custTypeTotals = (() => {
        const p = custTypeRowsAll.reduce((a, r) => a + (r.personal || 0), 0);
        const b = custTypeRowsAll.reduce((a, r) => a + (r.business || 0), 0);
        const occSum = custTypeRowsAll.reduce((a, r) => a + (r.personal || 0) + (r.business || 0), 0);
        const rate = kpiT ? (kpiT.rate ?? 0) : (occSum ? R2(custTypeRowsAll.reduce((a, r) => a + (r.rate || 0) * ((r.personal || 0) + (r.business || 0)), 0) / occSum) : 0);
        return { personal: p, business: b, personalPct: (p + b) ? +(p / (p + b) * 100).toFixed(1) : 0, rate };
      })();
      out.tables.push({
        title: 'Units by Customer Type — by Store', live: true, pageSize: 10, wide: true, totals: custTypeTotals, totalsLabel: 'Total',
        columns: liveCustTypeRows ? [
          { key: 'name', label: 'Location', type: 'text' },
          { key: 'personal', label: 'Personal Units', type: 'int', align: 'right' }, { key: 'business', label: 'Business Units', type: 'int', align: 'right' },
          { key: 'personalPct', label: '% Personal', type: 'pct', align: 'right' }, { key: 'rate', label: 'Rate £/ft²', type: 'money2', align: 'right' },
        ] : [
          { key: 'name', label: 'Location', type: 'text' }, { key: 'region', label: 'Region', type: 'text' },
          { key: 'personal', label: 'Personal Units', type: 'int', align: 'right' }, { key: 'business', label: 'Business Units', type: 'int', align: 'right' },
          { key: 'personalPct', label: '% Personal', type: 'pct', align: 'right' }, { key: 'rate', label: 'Rate £/ft²', type: 'money2', align: 'right' },
        ],
        rows: custTypeRowsAll,
      });
      // Offices Occupancy / Indoor Self Storage Occupancy — by store: live-wired per-store
      // breakdown, matching the legacy portal's own widgets of the same name (tooltip confirmed
      // 2 Jul 2026). occupied/total <- Occupancy Statistics unit-type counts (s.offices/s.ss),
      // rate <- Rent Roll's per-type rent/area (already fixed onto s.offices.rate/s.ss.rate in
      // lib/buildPayload.js's recordFor()). Sites with none of that unit type show 0/0, £0.00 —
      // matching the legacy screenshot (blank rows for stores without an Offices unit type).
      const liveOfficesRows = liveSites ? liveSites.map((s) => ({
        name: s.name, occupied: s.offices?.occ || 0, total: s.offices?.tot || 0, rate: s.offices?.rate || 0,
      })) : null;
      const liveSSRows = liveSites ? liveSites.map((s) => ({
        name: s.name, occupied: s.ss?.occ || 0, total: s.ss?.tot || 0, rate: s.ss?.rate || 0,
      })) : null;
      if (!liveOfficesRows || !liveSSRows) console.warn('[portal-v2] Offices/Indoor Self Storage Occupancy tables rendering with mock data (no live sites available).');
      const officeSSColumns = [
        { key: 'name', label: 'Location', type: 'text' },
        { key: 'occupied', label: 'Occupied', type: 'int', align: 'right' }, { key: 'total', label: 'Total', type: 'int', align: 'right' },
        { key: 'rate', label: 'Rate per ft²', type: 'money2', align: 'right' },
      ];
      // Totals rows (legacy parity: both tables end with summed occupancy + the portfolio's
      // weighted rate — kpiT.officesRate/ssRate are already Σ rent ÷ Σ area × 12 for that unit
      // type). Mock fallback: sums + occupied-weighted mean of the per-store mock rates.
      const occRateTotals = (rows, liveOcc, liveTot, liveRate) => {
        if (kpiT) return { occupied: liveOcc ?? 0, total: liveTot ?? 0, rate: liveRate ?? 0 };
        const occ = rows.reduce((a, r) => a + (r.occupied || 0), 0), tot = rows.reduce((a, r) => a + (r.total || 0), 0);
        return { occupied: occ, total: tot, rate: occ ? R2(rows.reduce((a, r) => a + (r.rate || 0) * (r.occupied || 0), 0) / occ) : 0 };
      };
      const officesRows = liveOfficesRows || fs.map((s) => ({ name: s.name, occupied: 0, total: 0, rate: 0 }));
      const ssRows = liveSSRows || fs.map((s) => ({ name: s.name, occupied: s.occupied, total: s.total, rate: s.rate }));
      out.tables.push({
        title: 'Offices Occupancy — by Store', live: true, pageSize: 10, wide: true,
        columns: officeSSColumns, rows: officesRows, totalsLabel: 'Total',
        totals: occRateTotals(officesRows, kpiT?.officesOcc, kpiT?.officesTot, kpiT?.officesRate),
      });
      out.tables.push({
        title: 'Indoor Self Storage Occupancy — by Store', live: true, pageSize: 10, wide: true,
        columns: officeSSColumns, rows: ssRows, totalsLabel: 'Total',
        totals: occRateTotals(ssRows, kpiT?.ssOcc, kpiT?.ssTot, kpiT?.ssRate),
      });
      // Occupied Area by % of CLA: live-wired from /api/portfolio's per-site array. area <- occA,
      // cla <- claA (Current Lettable Area, from lib/reportMap.js's occupancy parser), claPct <- areaPC
      // (same occA/claA-with-occA/totA-fallback rule used everywhere else, e.g. recordFor() in
      // lib/buildPayload.js). Same "no region field on live data" gap as the other live tables.
      const liveClaRows = liveSites ? liveSites.map((s) => ({
        name: s.name, area: s.occA || 0, cla: s.claA || 0, claPct: s.areaPC || 0,
      })) : null;
      if (!liveClaRows) console.warn('[portal-v2] Occupied Area by % of CLA table rendering with mock RAW_STORES data (no live sites available).');
      const claRowsAll = liveClaRows || fs.map((s) => ({ name: s.name, region: s.region, area: s.area, cla: Math.round(s.area / (s.claPct / 100)), claPct: s.claPct }));
      // Totals row: area sums; % of CLA re-derived from the sums (kpiT.claPC on the live path).
      const claTotals = (() => {
        const area = claRowsAll.reduce((a, r) => a + (r.area || 0), 0), cla = claRowsAll.reduce((a, r) => a + (r.cla || 0), 0);
        return { area, cla, claPct: kpiT ? (kpiT.claPC ?? 0) : (cla ? +(area / cla * 100).toFixed(1) : 0) };
      })();
      out.tables.push({
        title: 'Occupied Area by % of CLA — by Store', live: true, pageSize: 10, wide: true, totals: claTotals, totalsLabel: 'Total',
        columns: liveClaRows ? [
          { key: 'name', label: 'Location', type: 'text' },
          { key: 'area', label: 'Occupied Area', type: 'ft', align: 'right' }, { key: 'cla', label: 'CLA (ft²)', type: 'ft', align: 'right' },
          { key: 'claPct', label: '% of CLA', type: 'pct', align: 'right', color: 'threshold' },
        ] : [
          { key: 'name', label: 'Location', type: 'text' }, { key: 'region', label: 'Region', type: 'text' },
          { key: 'area', label: 'Occupied Area', type: 'ft', align: 'right' }, { key: 'cla', label: 'CLA (ft²)', type: 'ft', align: 'right' },
          { key: 'claPct', label: '% of CLA', type: 'pct', align: 'right', color: 'threshold' },
        ],
        rows: claRowsAll,
      });
    }

    else if (page === 'financials') {
      // Customer Insights (CORRECTED 3 Jul 2026 — confirmed via the legacy portal's own tooltip
      // screenshot, which was previously missing from this build): Avg customer value is a LIFETIME
      // value, not just monthly rent per unit —
      //   Avg Length of Stay = Total Days Occupied / Ledger Count Occupied
      //   Avg Customer Value = (Rent Roll / Occupied Units) * (Avg Length of Stay / 30.43)
      // 30.43 = average days/month (365.25/12), converting the day-count into a month-count so the
      // monthly rent-per-unit figure gets scaled up into an expected total-tenancy revenue figure.
      // The previous formula (Rent Roll / Occupied Units alone) was missing that multiplier
      // entirely, undershooting by roughly the average-months-of-stay factor (~13-16x here) — this
      // is almost certainly the "off by a significant margin" Michael flagged.
      const finT = liveSites ? computeTotals(liveSites) : null;
      let custInsights;
      if (finT) {
        const stayWeighted = liveSites.reduce((a, s) => a + (s.avgStayDays || 0) * (s.occ || 0), 0);
        const avgStay = finT.occ ? Math.round(stayWeighted / finT.occ) : 0;
        const avgCustValue = finT.occ ? R2((finT.rent / finT.occ) * (avgStay / 30.43)) : 0;
        custInsights = { title: 'Customer Insights', live: true, tiles: [{ value: money(avgCustValue), label: 'Avg customer value', delta: null, dir: null }, { value: avgStay + ' days', label: 'Avg length of stay', delta: null, dir: null }] };
      } else {
        console.warn('[portal-v2] Financials Customer Insights rendering with mock data (no live totals available).');
        custInsights = { title: 'Customer Insights', tiles: [{ value: money(3921), label: 'Avg customer value', delta: '£38', dir: 'down' }, { value: '721 days', label: 'Avg length of stay', delta: '2 days', dir: 'down' }] };
      }
      // Past Due Balances: totals.debtorTotal / debtorRentRollPct — same Debtor Levels source
      // already used on the Dashboard/KPIs (PastDueBalances, sum-then-divide). Tile label calls out
      // "(30+ days)" explicitly (widget name review, 2 Jul 2026) since debtorTotal is the
      // 30-days-overdue figure, not every positive balance — the same distinction that was a
      // confirmed bug on the Debtor Levels widget (see lib/buildPayload.js's `debtors` comment).
      const pastDue = finT
        ? { title: 'Past Due Balances', live: true, tiles: [{ value: money(finT.debtorTotal ?? 0), label: 'Total overdue (30+ days)', delta: null, dir: null }, { value: (finT.debtorRentRollPct ?? 0).toFixed(1) + '%', label: '% of rent roll', delta: null, dir: null }] }
        : { title: 'Past Due Balances', tiles: [{ value: money(2790 * f), label: 'Total overdue (30+ days)', delta: '£93', dir: 'up' }, { value: '0.6%', label: '% of rent roll', delta: '0%', dir: null }] };
      out.statCards = [custInsights, pastDue];
      // True Revenue — now live via CustomReportByReportID(781861) ("Financial \ True Revenue
      // Report - Daily Prorate", what Michael calls "Daily Pro Rate"). Confirmed 2 Jul 2026 via an
      // earlier version of this project's own scripts that this custom report IS reachable through
      // SiteLink's API (undocumented, but working) — see lib/sitelink.js's callCustomReport().
      // By ChargeDesc (Rent, StoreProtect, fees, etc.) and by UnitType — same raw rows, two
      // groupings, matching the legacy portal's two tables exactly.
      const mockRev = [
        ['Rent', 59090, 11818, -657, -11161, 49936, -45461, 2965, 318, 51331], ['StoreProtect', 6755, 1351, 157, -1194, 4745, -4449, 739, 48, 5672],
        ['Total Merchandise', 209, 42, 0, -42, 0, 0, 0, 0, 209], ['Insufficient Notice Fee', 210, 42, 6, -36, 0, 0, 30, 0, 180],
        ['Combi Padlock', 385, 77, 40, -37, 23, -12, 198, 0, 175], ['Rent Refund Dismissed', 40, 8, 0, -8, 0, 0, 0, 0, 40],
        ['Late Fee', 95, 19, 12, -7, 0, -10, 50, 0, 35], ['Electric Charge 150+', 33, 7, 0, -7, 23, -23, 0, 0, 34],
        ['Service Fee', 25, 5, 0, -5, 23, 7, 0, 0, 9], ['Waste (Full Bin)', 33, 7, 7, 0, 0, 0, 33, 0, 0],
      ].map((r) => ({ desc: r[0], invoiced: r[1] * f, taxInvoiced: r[2] * f, taxAdj: r[3] * f, netTax: r[4] * f, deferred: r[5] * f, deferredPrev: r[6] * f, adj: r[7] * f, adjPrev: r[8] * f, truePeriod: r[9] * f }));
      const mockRevByType = [
        ['Indoor Self Storage', 45803, 9161, 622, -7916, 37428, -36131, 2695, 416, 41395], ['Drive Up', 9309, 1862, 256, -1349, 6898, -6563, 1281, 0, 7693],
        ['Enterprise', 6097, 1219, -1219, -5352, 5375, 0, 0, 0, 6120], ['Office', 5650, 1130, 0, -1130, 5078, -1889, 0, 0, 2461], ['Mailbox', 62, 12, 0, -12, 24, -30, 0, 0, 69],
      ].map((r) => ({ desc: r[0], invoiced: r[1] * f, taxInvoiced: r[2] * f, taxAdj: r[3] * f, netTax: r[4] * f, deferred: r[5] * f, deferredPrev: r[6] * f, adj: r[7] * f, adjPrev: r[8] * f, truePeriod: r[9] * f }));
      // Coloring: legacy portal's True Revenue table shows every money column in red/green/black
      // (Michael's screenshot) — verified the rule is sign-based per cell (negative=red, positive=green,
      // zero=black), not a fixed color per column, so `color: 'delta'` is applied to all 9 money columns.
      const revCols = [
        { key: 'desc', label: 'Description', type: 'text' }, { key: 'invoiced', label: 'Invoiced', type: 'money', align: 'right', color: 'delta' }, { key: 'taxInvoiced', label: 'Tax Invoiced', type: 'money', align: 'right', color: 'delta' },
        { key: 'taxAdj', label: 'Tax Adj', type: 'money', align: 'right', color: 'delta' }, { key: 'netTax', label: 'Net Tax', type: 'money', align: 'right', color: 'delta' }, { key: 'deferred', label: 'Deferred Rev', type: 'money', align: 'right', color: 'delta' },
        { key: 'deferredPrev', label: 'Deferred Prev', type: 'money', align: 'right', color: 'delta' }, { key: 'adj', label: 'Adjustments', type: 'money', align: 'right', color: 'delta' }, { key: 'adjPrev', label: 'Adj Prev', type: 'money', align: 'right', color: 'delta' }, { key: 'truePeriod', label: 'True Period', type: 'money', align: 'right', color: 'delta' },
      ];
      if (!finT || !finT.trueRevenueByDesc?.length) console.warn('[portal-v2] True Revenue tables rendering with mock data (no live true_revenue data yet — run npm run pull after adding true_revenue to the pipeline).');
      // Totals rows (legacy parity: both True Revenue tables end with a totals row — the legacy
      // labels it with the month, ours with "Total" — summing every money column).
      const revTotals = (rows) => {
        const out2 = {};
        for (const c of revCols) if (c.key !== 'desc') out2[c.key] = R2(rows.reduce((a, r) => a + (+r[c.key] || 0), 0));
        return out2;
      };
      const revRows = finT?.trueRevenueByDesc?.length ? finT.trueRevenueByDesc : mockRev;
      const revTypeRows = finT?.trueRevenueByType?.length ? finT.trueRevenueByType : mockRevByType;
      out.tables = [
        // pageSize bumped 3 Jul 2026 (Michael: "many missing unit types on True Revenue") — rows
        // weren't actually missing, they were paginated (12/page on a ~50-row ChargeDesc table) and
        // the Unit Types table was additionally fragmenting near-duplicate labels like "Drive Up" /
        // "DriveUp" / "Drive up" into separate rows (fixed in lib/reportMap.js's groupBy). Bumped
        // pageSize so the (now-deduped, ~10-14 row) Unit Types table fits on one page, and the
        // ChargeDesc table shows more before needing Next.
        { title: 'True Revenue', live: true, pageSize: 25, wide: true, columns: revCols, rows: revRows, totals: revTotals(revRows), totalsLabel: 'Total' },
        { title: 'True Revenue — Unit Types', live: true, pageSize: 20, wide: true, columns: revCols, rows: revTypeRows, totals: revTotals(revTypeRows), totalsLabel: 'Total' },
      ];
    }

    else if (page === 'ancillaries') {
      // Insurance Roll: live-wired from /api/portfolio's totals (lib/buildPayload.js sums premium/
      // insured/rent/occ across sites first, then divides once — InsuranceRoll report, per-site
      // fields already existed as s.insurance.{premium,insured,penetration}).
      const ancT = liveSites ? computeTotals(liveSites) : null;   // recomputed client-side so the store filter applies
      if (!ancT) console.warn('[portal-v2] Ancillaries Insurance Roll stat card rendering with mock data (no live totals available).');
      // Every top-row stat card below is scoped to the SAME "last complete month" as Enquiries/
      // Move-ins & Move-outs. CORRECTED 3 Jul 2026: this comment previously claimed insuranceActivity
      // and merchandise were already covered by buildPayload.js's prevByCode override — they weren't
      // (only enquiries/moveIns/moveOuts/netArea/moveOutsYear were), so Insurance Conversion and
      // Merchandise Sales/Income were silently computing off the in-progress CURRENT month while
      // being divided against moveIns from the previous COMPLETE month. Now fixed (both the override
      // list and lib/pull.js's TWO_MONTH set for insurance_activity/merchandise/rent_roll) — requires
      // a fresh `npm run pull` to take effect (needs the previous month's insurance_activity/
      // merchandise/rent_roll actually pulled, not just re-read from what's already stored).
      const monthTag = (liveMonths && liveMonths.length >= 2) ? (() => { const [y, m] = liveMonths[liveMonths.length - 2].split('-'); return new Date(+y, +m - 1, 1).toLocaleString('en-GB', { month: 'short', year: 'numeric' }); })() : 'Jul 2026';
      const moveInsSum = liveSites ? liveSites.reduce((a, s) => a + (s.moveIns || 0), 0) : 0;
      // insNewSum/insNewCount MOVED UP 6 Jul 2026 — needed by Insurance Conversion below too, not
      // just Insurance Premiums (New Customers). See that widget's comment further down for the
      // full story on why this TenantID cross-reference replaced ManagementSummary/InsuranceActivity
      // as the source: Insurance Conversion was reading 873% (!) because `mg.insured_moveins`
      // (ManagementSummary's "Insurance" activity row) is NOT scoped to new move-ins specifically —
      // confirmed wrong after Michael reported the >100% figure, same unreliable-field class as
      // several others in this pipeline. insNewCount (this month's move-in TenantIDs ∩ InsuranceRoll's
      // insured tenants) is real, verified data instead.
      const insNewSum = (k) => liveSites ? liveSites.reduce((a, s) => a + ((s.insuredNewCustomers && s.insuredNewCustomers[k]) || 0), 0) : 0;
      const insNewCount = insNewSum('count'), insNewPremium = insNewSum('premiumSum'), insNewCoverage = insNewSum('coverageSum');
      // Switched to chargeFromFinancial (FinancialSummary's own "Merchandise" charge category) 6 Jul
      // 2026 — confirmed via the legacy portal's own tooltip that Merchandise Sales is sourced from
      // FinancialSummary, not MerchandiseSummary (s.merchandise.sales, kept for cost/margin only —
      // FinancialSummary has no cost/margin breakdown). This was the actual cause of Merchandise
      // Income per New Customer reading ~£8+ higher than the legacy portal (Michael, 6 Jul 2026).
      const merchSalesSum = liveSites ? liveSites.reduce((a, s) => a + ((s.merchandise && s.merchandise.chargeFromFinancial) || 0), 0) : 0;
      // Autobill Conversion: totals.autobillPC (RentRoll iAutoBillType in [1,2] ÷ all occupied
      // tenants, sum-then-divide) — audited 2 Jul 2026 (npm run audit): the [1,2]="on autobill"
      // assumption checks out cleanly against the live value distribution.
      const autobillCard = ancT
        // FIXED 7 Jul 2026 (exhaustive bug audit): was .toFixed(0) here vs .toFixed(1) on the
        // Dashboard/KPIs copy of this identical metric (line ~1119) — same source field
        // (totals.autobillPC, already rounded to 1dp in computeTotals()), just displayed with one
        // fewer decimal, so the same underlying number showed as e.g. "86%" here vs "86.4%" there.
        ? { title: 'Autobill Conversion', live: true, tiles: [{ value: (ancT.autobillPC ?? 0).toFixed(1) + '%', label: monthTag, delta: null, dir: null }], hasViz: true, el: <Donut pct={ancT.autobillPC ?? 0} color={C.blue} /> }
        : { title: 'Autobill Conversion', tiles: [{ value: '57%', label: 'Jul 2026', delta: '16%', dir: 'down' }], hasViz: true, el: <Donut pct={57} color={C.blue} /> };
      // Insurance Conversion: new insured customers (TenantID cross-reference, insNewCount above) ÷
      // new move-ins for the month — the standard "did the new customer take out insurance"
      // conversion rate. CORRECTED 6 Jul 2026: previously read 873% (!) using
      // mg.insured_moveins/ia.new_policies as the numerator — confirmed wrong (ManagementSummary's
      // "Insurance" activity row is not scoped to new move-ins specifically, it's some larger/
      // different count). insNewCount is real cross-referenced data, can never exceed moveInsSum.
      const insConvPct = liveSites && moveInsSum ? +(insNewCount / moveInsSum * 100).toFixed(0) : null;
      const insuranceConvCard = insConvPct != null
        ? { title: 'Insurance Conversion', live: true, tiles: [{ value: insConvPct + '%', label: monthTag, delta: null, dir: null }], hasViz: true, el: <Gauge pct={insConvPct} /> }
        : { title: 'Insurance Conversion', tiles: [{ value: '57%', label: 'Jul 2026', delta: '7%', dir: 'up' }], hasViz: true, el: <Gauge pct={57} /> };
      const insuranceRollCard = ancT
        ? { title: 'Insurance Roll', live: true, tiles: [{ value: money(ancT.insurancePremium ?? 0), label: 'Premiums', delta: null, dir: null }, { value: (ancT.insurancePctRoll ?? 0).toFixed(1) + '%', label: '% Rent Roll', delta: null, dir: null }, { value: (ancT.insurancePctInsured ?? 0).toFixed(1) + '%', label: '% Insured', delta: null, dir: null }] }
        // FIXED 7 Jul 2026 (exhaustive bug audit): this mock/fallback branch had `live: true` —
        // almost certainly copy-pasted from the live branch directly above — which made the app
        // show the green "LIVE" badge on fabricated placeholder numbers whenever ancT was
        // unavailable, with no visual tell at all that the data wasn't real (every other mock
        // fallback on this page correctly omits `live: true`, which is the ONE cue distinguishing
        // mock from live). Removed.
        : { title: 'Insurance Roll', tiles: [{ value: money(5145 * f), label: 'Premiums', delta: '£2', dir: 'down' }, { value: '10.1%', label: '% Rent Roll', delta: '0.2%', dir: 'down' }, { value: '75.3%', label: '% Insured', delta: '1.8%', dir: 'down' }] };
      // Insurance Premiums (New Customers) — REBUILT 6 Jul 2026: InsuranceActivity's `sNewPolicy`
      // flag (the previous source for both tiles) is confirmed unreliable — it read £0.00 even with
      // nonzero move-ins and a nonzero existing InsuranceRoll book. Replaced with a TenantID
      // cross-reference (this month's move-in TenantIDs ∩ InsuranceRoll's insured tenants — see
      // buildPayload.js's insuredNewCustomers, same pattern as Autobill Conversion), which is real
      // data instead of a flag and ALSO unlocks "Contents Avg" going live for the first time (no
      // report previously exposed new-customer-only coverage at all — it was mock-only before).
      // Weekly Premiums formula pulled verbatim from the legacy portal's own tooltip
      // (portal.cinchstorage.co.uk/ancillaries/): "(Total of Insurance Premiums for new Move-Ins /
      // Total Move-Ins) / 4" — denominator is ALL move-ins, not just the insured ones. (insNewSum/
      // insNewCount/insNewPremium/insNewCoverage now computed earlier, above — also used by
      // Insurance Conversion.)
      const avgNewPremiumPerMoveIn = moveInsSum ? insNewPremium / moveInsSum : 0;
      const insPremNewCard = (liveSites && insNewCount)
        ? { title: 'Insurance Premiums (New Customers)', live: true, tiles: [{ value: money(insNewCoverage / insNewCount), label: 'Contents avg', delta: null, dir: null }, { value: '£' + (avgNewPremiumPerMoveIn / 4).toFixed(2), label: 'Premiums weekly', delta: null, dir: null }] }
        : { title: 'Insurance Premiums (New Customers)', tiles: [{ value: money(8294 * f), label: 'Contents avg', delta: '£516', dir: 'up' }, { value: '£7.68', label: 'Premiums weekly', delta: '£0.09', dir: 'up' }] };
      // Merchandise Income per New Customer: merchandise sales ÷ move-ins this month (both
      // MerchandiseSummary/ManagementSummary, real reports, sum-then-divide).
      const merchPerNewCust = (liveSites && moveInsSum) ? { title: 'Merchandise Income per New Customer', live: true, tiles: [{ value: '£' + (merchSalesSum / moveInsSum).toFixed(2), label: 'Income per move-in', delta: null, dir: null }] }
        : { title: 'Merchandise Income per New Customer', tiles: [{ value: '£2.01', label: 'Income per move-in', delta: '£0.24', dir: 'down' }] };
      const merchSalesCard = liveSites
        ? { title: 'Merchandise Sales', live: true, tiles: [{ value: money(merchSalesSum), label: monthTag, delta: null, dir: null }] }
        : { title: 'Merchandise Sales', tiles: [{ value: money(209 * f), label: 'May 2026', delta: '£21', dir: 'up' }] };
      out.statCards = [autobillCard, insuranceConvCard, insuranceRollCard, insPremNewCard, merchPerNewCust, merchSalesCard];
      // Insurance Roll by Store: live-wired per-site comparison bars (same portfolio-comparison
      // pattern as the dashboard, per Michael 2 Jul 2026 — store-vs-store, not a trend line).
      const liveInsBars = liveSites ? liveSites.map((s) => ({ label: s.name, value: (s.insurance && s.insurance.penetration) || 0, disp: ((s.insurance && s.insurance.penetration) || 0).toFixed(1) + '%', color: ((s.insurance && s.insurance.penetration) || 0) >= 70 ? C.green : ((s.insurance && s.insurance.penetration) || 0) >= 50 ? C.amber : C.red })) : null;
      if (!liveInsBars) console.warn('[portal-v2] Insurance Roll chart rendering with mock data (no live sites available).');
      // Pinned "Average" bar (legacy parity): portfolio % insured = Σ insured units ÷ Σ occupied
      // units (ancT.insurancePctInsured, sum-then-divide) on the live path; mean of mock values otherwise.
      const insBarItems = liveInsBars || fs.map((s) => ({ label: s.name, value: +(68 + (s.occupied % 22)).toFixed(1), disp: (+(68 + (s.occupied % 22)).toFixed(1)) + '%', color: C.blue }));
      const avgInsured = ancT ? (ancT.insurancePctInsured ?? 0) : (insBarItems.length ? insBarItems.reduce((a, b) => a + b.value, 0) / insBarItems.length : 0);
      out.chartCards = [
        { title: 'Insurance % Insured by Store', el: <StoreBarChart items={insBarItems} opts={{ average: { value: avgInsured, disp: avgInsured.toFixed(1) + '%' } }} /> },
      ];
      // Insurance Roll (All Stores) table: live-wired from s.insurance (premium/insured/penetration)
      // and s.rent (already computed elsewhere) for the % Rent Roll column.
      const liveInsRows = liveSites ? liveSites.map((s) => {
        const ins = s.insurance || {};
        return { name: s.name, premiums: ins.premium || 0, pctRoll: s.rent ? +((ins.premium || 0) / s.rent * 100).toFixed(1) : 0, insured: ins.insured || 0, pctInsured: ins.penetration || 0 };
      }) : null;
      if (!liveInsRows) console.warn('[portal-v2] Insurance Roll table rendering with mock RAW_STORES data (no live sites available).');
      const insRowsAll = liveInsRows || fs.map((s) => {
        const pctInsured = +(68 + (s.occupied % 22)).toFixed(1);
        return { name: s.name, region: s.region, premiums: Math.round(s.rentRoll * 0.101), pctRoll: 10.1, insured: Math.round((s.occupied * pctInsured) / 100), pctInsured };
      });
      // Totals row (legacy parity: the legacy Insurance Roll table ends with a portfolio totals
      // row): premium/insured sums; %s re-derived sum-then-divide (ancT) on the live path.
      const insTotals = (() => {
        const premiums = insRowsAll.reduce((a, r) => a + (r.premiums || 0), 0);
        const insured = insRowsAll.reduce((a, r) => a + (r.insured || 0), 0);
        return {
          premiums, insured,
          pctRoll: ancT ? (ancT.insurancePctRoll ?? 0) : (insRowsAll.length ? +(insRowsAll.reduce((a, r) => a + (r.pctRoll || 0), 0) / insRowsAll.length).toFixed(1) : 0),
          pctInsured: ancT ? (ancT.insurancePctInsured ?? 0) : (insRowsAll.length ? +(insRowsAll.reduce((a, r) => a + (r.pctInsured || 0), 0) / insRowsAll.length).toFixed(1) : 0),
        };
      })();
      out.tables.push({
        title: 'Insurance Roll (All Stores)', live: true, pageSize: 12, wide: true, totals: insTotals, totalsLabel: 'Total',
        columns: liveInsRows ? [
          { key: 'name', label: 'Location', type: 'text' },
          { key: 'premiums', label: 'Premiums', type: 'money', align: 'right' }, { key: 'pctRoll', label: '% Rent Roll', type: 'pct', align: 'right' },
          { key: 'insured', label: 'Insured Units', type: 'int', align: 'right' }, { key: 'pctInsured', label: '% Insured', type: 'pct', align: 'right', color: 'threshold' },
        ] : [
          { key: 'name', label: 'Location', type: 'text' }, { key: 'region', label: 'Region', type: 'text' },
          { key: 'premiums', label: 'Premiums', type: 'money', align: 'right' }, { key: 'pctRoll', label: '% Rent Roll', type: 'pct', align: 'right' },
          { key: 'insured', label: 'Insured Units', type: 'int', align: 'right' }, { key: 'pctInsured', label: '% Insured', type: 'pct', align: 'right', color: 'threshold' },
        ],
        rows: insRowsAll,
      });
    }

    else if (page === 'marketing') {
      // Enquiries by Channel + Enquiry -> Reservation: same authoritative source as the dashboard
      // Enquiries card (lib/reportMap.js lead_funnel / InquiryTracking, sInquiryType field) — sum
      // across all live sites. Same "no region filter on live data" caveat as elsewhere.
      const enqSum = liveSites ? (k) => liveSites.reduce((a, s) => a + ((s.enquiries && s.enquiries[k]) || 0), 0) : null;
      let enquiriesByChannel, enquiryToReservation;
      if (enqSum) {
        enquiriesByChannel = { title: 'Enquiries by Channel', live: true, tiles: [
          { value: intFmt(enqSum('phone')), label: 'Phone', delta: null, dir: null },
          { value: intFmt(enqSum('walkin')), label: 'Walk-ins', delta: null, dir: null },
          { value: intFmt(enqSum('web')), label: 'Web', delta: null, dir: null },
          { value: intFmt(enqSum('total')), label: 'Total', delta: null, dir: null },
        ] };
        // CORRECTED 6 Jul 2026: was reading `conversions` (Enquiry -> Move-In, a different metric
        // entirely — see buildPayload.js) despite the "Reservation" title. Now uses
        // `reservationConversions`, the actual email-hash-matched Enquiry -> Reservation figure.
        const totalEnq = enqSum('total'), convPct = totalEnq ? +(enqSum('reservationConversions') / totalEnq * 100).toFixed(1) : 0;
        enquiryToReservation = { title: 'Enquiry → Reservation', tiles: [{ value: convPct + '%', label: 'Conversion rate', delta: null, dir: null }], hasViz: true, el: <Gauge pct={convPct} /> };
      } else {
        console.warn('[portal-v2] Marketing Enquiries widgets rendering with mock RAW_STORES data (no live sites available).');
        // FIXED 7 Jul 2026 (exhaustive bug audit): same copy-paste `live: true` bug as Insurance
        // Roll above — this mock branch was showing the green LIVE badge on fabricated numbers.
        // This block is an if/else rather than this file's usual ternary pattern, which is likely
        // why the copy-paste slipped through here specifically. Removed.
        enquiriesByChannel = { title: 'Enquiries by Channel', tiles: [{ value: intFmt(94 * f), label: 'Phone', delta: '2', dir: 'up' }, { value: intFmt(61 * f), label: 'Walk-ins', delta: '2', dir: 'down' }, { value: intFmt(1210 * f), label: 'Web', delta: '10', dir: 'up' }, { value: intFmt(1365 * f), label: 'Total', delta: '10', dir: 'up' }] };
        enquiryToReservation = { title: 'Enquiry → Reservation', tiles: [{ value: '38%', label: 'Conversion rate', delta: '2%', dir: 'up' }], hasViz: true, el: <Gauge pct={38} /> };
      }
      // Cost per Lead — REMOVED 3 Jul 2026 (Michael): needs a marketing-spend feed (AdWords or
      // similar) that doesn't exist anywhere in this pipeline, and SiteLink has no ad-spend data to
      // pull. It was mock-only with a fabricated spend figure — removed rather than show a fake number.
      out.statCards = [
        enquiriesByChannel,
        enquiryToReservation,
      ];
      // Web Enquiries by Store — REMOVED 6 Jul 2026 (Michael: redundant with Enquiries by Channel's
      // Web tile above / Leads by Store on the Marketing page already covering this by channel).
      // Reservations vs Move-ins: live portfolio sums (activeReservations from ReservationList,
      // moveIns from ManagementSummary — both already last-complete-month/current-scoped).
      const resVsMoveIns = liveSites ? { res: liveSites.reduce((a, s) => a + (s.activeReservations || 0), 0), mi: liveSites.reduce((a, s) => a + (s.moveIns || 0), 0) } : null;
      if (!resVsMoveIns) console.warn('[portal-v2] Reservations vs Move-ins chart rendering with mock data (no live sites available).');
      out.chartCards = [
        resVsMoveIns
          ? { title: 'Reservations vs Move-ins', el: <VBars items={[{ label: 'Reservations', value: resVsMoveIns.res, disp: intFmt(resVsMoveIns.res), color: C.blue }, { label: 'Move-ins', value: resVsMoveIns.mi, disp: intFmt(resVsMoveIns.mi), color: C.teal }]} opts={{ max: Math.max(resVsMoveIns.res, resVsMoveIns.mi) * 1.15 }} /> }
          : { title: 'Reservations vs Move-ins', el: <VBars items={[{ label: 'Reservations', value: 52 * f, disp: intFmt(52 * f), color: C.blue }, { label: 'Move-ins', value: 112 * f, disp: intFmt(112 * f), color: C.teal }]} opts={{ max: 130 * f }} /> },
      ];
      // Leads by Store: live-wired from each site's `enquiries` object — same authoritative source
      // (lib/reportMap.js's lead_funnel/InquiryTracking parser, locked spec Michael 1 Jul 2026) as
      // the Enquiries by Channel / Enquiry -> Reservation cards above, just per-store instead of
      // summed across the portfolio. No region field on live data (same gap as every other live
      // table on this page), so that column is dropped for live rows.
      const liveLeadRows = liveSites ? liveSites.map((s) => {
        const e = s.enquiries || {};
        const total = e.total || 0;
        return { name: s.name, phone: e.phone || 0, web: e.web || 0, walkin: e.walkin || 0, total, conv: total ? +((e.reservationConversions || 0) / total * 100).toFixed(1) : 0 };
      }) : null;
      if (!liveLeadRows) console.warn('[portal-v2] Leads by Store table rendering with mock RAW_STORES data (no live sites available).');
      const leadRowsAll = liveLeadRows || fs.map((s) => {
        const phone = Math.round(3 + (s.occupied % 6));
        const web = Math.round(38 + (s.total % 24));
        const walkin = Math.round(2 + (s.occupied % 4));
        const total = phone + web + walkin;
        return { name: s.name, region: s.region, phone, web, walkin, total, conv: +(30 + (s.occupied % 18)).toFixed(1) };
      });
      // Totals row (legacy parity, 3 Jul 2026 — this table was missing one): unit sums; conversion %
      // re-derived sum-then-divide from the same enqSum() the Enquiries by Channel/Enquiry ->
      // Reservation cards above already use, not an average of per-store conversion %s.
      const leadTotals = (() => {
        const phone = leadRowsAll.reduce((a, r) => a + (r.phone || 0), 0);
        const web = leadRowsAll.reduce((a, r) => a + (r.web || 0), 0);
        const walkin = leadRowsAll.reduce((a, r) => a + (r.walkin || 0), 0);
        const total = leadRowsAll.reduce((a, r) => a + (r.total || 0), 0);
        const conv = enqSum ? (enqSum('total') ? +(enqSum('reservationConversions') / enqSum('total') * 100).toFixed(1) : 0) : (total ? +(leadRowsAll.reduce((a, r) => a + (r.conv || 0) * (r.total || 0), 0) / total).toFixed(1) : 0);
        return { phone, web, walkin, total, conv };
      })();
      out.tables.push({
        title: 'Leads by Store (All Stores)', live: true, pageSize: 12, wide: true, totals: leadTotals, totalsLabel: 'Total',
        columns: liveLeadRows ? [
          { key: 'name', label: 'Location', type: 'text' },
          { key: 'phone', label: 'Phone', type: 'int', align: 'right' }, { key: 'web', label: 'Web', type: 'int', align: 'right' },
          { key: 'walkin', label: 'Walk-ins', type: 'int', align: 'right' }, { key: 'total', label: 'Total Leads', type: 'int', align: 'right' },
          { key: 'conv', label: 'Conversion %', type: 'pct', align: 'right', color: 'threshold' },
        ] : [
          { key: 'name', label: 'Location', type: 'text' }, { key: 'region', label: 'Region', type: 'text' },
          { key: 'phone', label: 'Phone', type: 'int', align: 'right' }, { key: 'web', label: 'Web', type: 'int', align: 'right' },
          { key: 'walkin', label: 'Walk-ins', type: 'int', align: 'right' }, { key: 'total', label: 'Total Leads', type: 'int', align: 'right' },
          { key: 'conv', label: 'Conversion %', type: 'pct', align: 'right', color: 'threshold' },
        ],
        rows: leadRowsAll,
      });
    }

    else if (page === 'mom') {
      const L = momLabels();
      // Month-on-Month is the one place trend-over-time charts belong (per Michael 2 Jul 2026: "if
      // trend analysis is required, it should be available... within a dedicated analytics page —
      // not on the main dashboard"). Wired from /api/portfolio's `history` (one point per stored
      // month, portfolio-wide sum-then-divide — see lib/buildPayload.js). The pipeline currently
      // only retains the CURRENT + PREVIOUS month per pull (no backfill run yet), so this will show
      // just 2 points until more months accumulate or `npm run backfill` is run intentionally —
      // still real data, just a short trend for now. Needs >=2 points (LineChart divides by n-1).
      // CHANGED 6 Jul 2026 (Michael): the global PERIOD selector (1M/3M/6M/12M/YTD/All + custom
      // FROM/TO) now scopes Month-on-Month's own trend charts too, instead of always showing every
      // stored month regardless of what's picked elsewhere on the portal.
      const selFromKey = monthKeyOf(monthFrom), selToKey = monthKeyOf(monthTo);
      const scopedHistory = liveHistory ? liveHistory.filter((h) => h.month >= selFromKey && h.month <= selToKey) : null;
      const liveHist = (scopedHistory && scopedHistory.length >= 2) ? scopedHistory : null;
      if (!liveHist) console.warn('[portal-v2] Month-on-Month charts rendering with mock data (need >=2 months of stored history within the selected period — widen the PERIOD selector, run npm run pull a few more times, or npm run backfill).');
      const hLabels = liveHist ? liveHist.map((h) => { const [y, m] = h.month.split('-'); return new Date(+y, +m - 1, 1).toLocaleString('en-GB', { month: 'short' }) + " '" + y.slice(2); }) : L;
      // NOTE (widget name review, 2 Jul 2026): this trend is named "Revenue Collected" (Charge minus
      // Credit, from the `financial`/ManagementSummary report), NOT "True Revenue" — that more
      // accurate tax/deferred-adjusted figure now lives on the Financials page's True Revenue
      // tables, sourced from the CustomReportByReportID "Daily Pro Rate" report, which is only
      // pulled for the current month (no per-month history retained yet), so it can't drive a
      // multi-month trend line until a historical backfill (Task #43) captures it going forward.
      // All six trend charts render full-width, one per row (Michael, 7 Jul 2026: "make them all
      // one row at a time like the top one so its easy to see all time regardless" — previously only
      // "Revenue Collected" had wide:true, so the other five were squeezed into a ~340px grid column
      // and their all-time labels overlapped/crowded, LOOKING like only ~1 year was shown even though
      // the underlying data/labels were already complete. Zooming is done via the date-range presets
      // (1M/3M/6M/12M/YTD/All) above, not by shrinking chart width.
      out.chartCards = liveHist ? [
        { title: 'Revenue Collected', el: <LineChart series={[{ name: 'Portfolio', color: C.blue, values: liveHist.map((h) => h.revenue || 0) }]} opts={{ labels: hLabels, zero: true }} />, wide: true },
        { title: 'Rent Roll', el: <LineChart series={[{ name: 'Portfolio', color: C.teal, values: liveHist.map((h) => h.rent || 0) }]} opts={{ labels: hLabels, zero: true }} />, wide: true },
        { title: 'Insurance Roll', el: <LineChart series={[{ name: 'Premiums', color: C.blue, values: liveHist.map((h) => h.insurancePremium || 0) }]} opts={{ labels: hLabels, zero: true }} />, wide: true },
        { title: 'Total Occupied Area', el: <LineChart series={[{ name: 'ft²', color: C.blue, values: liveHist.map((h) => h.occA || 0) }]} opts={{ labels: hLabels }} />, wide: true },
        { title: 'Self Storage Occupied Area', el: <LineChart series={[{ name: 'ft²', color: C.teal, values: liveHist.map((h) => h.ssOccA || 0) }]} opts={{ labels: hLabels }} />, wide: true },
        { title: 'Self Storage Rate per ft²', el: <LineChart series={[{ name: 'Rate', color: C.blue, values: liveHist.map((h) => h.ssRate || 0) }]} opts={{ labels: hLabels }} />, wide: true },
      ] : [
        { title: 'Revenue Collected', el: <LineChart series={[{ name: 'Portfolio', color: C.blue, values: seq(48000 * f, 900 * f, 2200 * f, 12) }]} opts={{ labels: L, zero: true }} />, wide: true },
        { title: 'Rent Roll', el: <LineChart series={[{ name: 'Portfolio', color: C.teal, values: seq(1200000 * f, 12000 * f, 24000 * f, 12) }]} opts={{ labels: L, zero: true }} />, wide: true },
        { title: 'Insurance Roll', el: <LineChart series={[{ name: 'Premiums', color: C.blue, values: seq(4200 * f, 90 * f, 260 * f, 12) }]} opts={{ labels: L, zero: true }} />, wide: true },
        { title: 'Total Occupied Area', el: <LineChart series={[{ name: 'ft²', color: C.blue, values: seq(600000 * f, 3400 * f, 9000 * f, 12) }]} opts={{ labels: L }} />, wide: true },
        { title: 'Self Storage Occupied Area', el: <LineChart series={[{ name: 'ft²', color: C.teal, values: seq(540000 * f, 3000 * f, 8000 * f, 12) }]} opts={{ labels: L }} />, wide: true },
        { title: 'Self Storage Rate per ft²', el: <LineChart series={[{ name: 'Rate', color: C.blue, values: seq(27.2, 0.22, 0.4, 12) }]} opts={{ labels: L }} />, wide: true },
      ];
    }

    else if (page === 'unitmix') {
      // Unit Mix Detail — new page (3 Jul 2026) built from the RentalActivity report Michael
      // uploaded (Grp_RentalActivity_*.xlsx), confirmed live-pullable for all 27 sites via
      // npm run probe:rental-activity-report. One row per (unit type, unit size) across the whole
      // portfolio (totals.rentalActivityByTypeSize, sum-then-divide rollup — see lib/buildPayload.js).
      const umT = liveSites ? computeTotals(liveSites) : null;
      const umRows = umT?.rentalActivityByTypeSize?.length ? umT.rentalActivityByTypeSize : null;
      if (!umRows) console.warn('[portal-v2] Unit Mix Detail page rendering with mock data (no live rental_activity data yet — run npm run pull after adding rental_activity to the pipeline).');
      const mockUM = [
        { type: 'Drive Up', unitSize: '8x20', area: 160, totalUnits: 29, occupied: 27, vacant: 2, standardRate: 295, occupiedRent: 7100, movedIn: 3, movedOut: 5, transfers: 1, netTransferred: 0, net: -2, occPct: 93.1, vacPct: 6.9, totalDollarPerArea: 22.13, occupiedDollarPerArea: 19.73, grossPotential: 8555, vacantArea: 320, netArea: -320 },
        { type: 'Indoor Self Storage', unitSize: '5x5', area: 25, totalUnits: 19, occupied: 18, vacant: 1, standardRate: 85, occupiedRent: 1397, movedIn: 2, movedOut: 2, transfers: 1, netTransferred: -1, net: 0, occPct: 94.7, vacPct: 5.3, totalDollarPerArea: 40.8, occupiedDollarPerArea: 37.25, grossPotential: 1615, vacantArea: 25, netArea: -25 },
        { type: 'Indoor Self Storage', unitSize: '3x3', area: 9, totalUnits: 4, occupied: 3, vacant: 1, standardRate: 41, occupiedRent: 91, movedIn: 1, movedOut: 0, transfers: 0, netTransferred: 0, net: 1, occPct: 75, vacPct: 25, totalDollarPerArea: 54.7, occupiedDollarPerArea: 40.4, grossPotential: 164, vacantArea: 9, netArea: 9 },
        { type: 'Enterprise', unitSize: '20x20', area: 400, totalUnits: 2, occupied: 2, vacant: 0, standardRate: 697, occupiedRent: 1394, movedIn: 0, movedOut: 0, transfers: 0, netTransferred: 0, net: 0, occPct: 100, vacPct: 0, totalDollarPerArea: 20.9, occupiedDollarPerArea: 20.9, grossPotential: 1394, vacantArea: 0, netArea: 0 },
        { type: 'Office', unitSize: '10x10', area: 100, totalUnits: 6, occupied: 5, vacant: 1, standardRate: 210, occupiedRent: 950, movedIn: 1, movedOut: 1, transfers: 0, netTransferred: 0, net: 0, occPct: 83.3, vacPct: 16.7, totalDollarPerArea: 25.2, occupiedDollarPerArea: 22.8, grossPotential: 1260, vacantArea: 100, netArea: 0 },
      ];
      // Collapsed to ONE ROW PER UNIT TYPE (6 Jul 2026, Michael: "you have every piece of unit
      // showing... change that so it only shows one mail box, one indoor self storage... as a
      // total" — the report's natural grain is per (type, unit SIZE), giving 50+ rows; this page
      // should show the type-level total instead). Sum-then-recompute, same rule as every other
      // rollup in this file — rates/percentages are never averaged from already-divided per-size
      // figures.
      const byTypeSize = umRows || mockUM;
      const rows = (() => {
        const g = {};
        for (const r of byTypeSize) {
          const o = (g[r.type] ??= { type: r.type, totalUnits: 0, occupied: 0, vacant: 0, occupiedRent: 0, movedIn: 0, movedOut: 0, netTransferred: 0, transfers: 0, net: 0, totalArea: r.totalArea != null ? 0 : undefined, occupiedArea: r.occupiedArea != null ? 0 : undefined, vacantArea: 0, netArea: 0, grossPotential: 0 });
          o.totalUnits += r.totalUnits; o.occupied += r.occupied; o.vacant += r.vacant; o.occupiedRent += r.occupiedRent;
          o.movedIn += r.movedIn; o.movedOut += r.movedOut; o.netTransferred += r.netTransferred; o.transfers += r.transfers; o.net += r.net;
          if (r.totalArea != null) o.totalArea += r.totalArea; if (r.occupiedArea != null) o.occupiedArea += r.occupiedArea;
          o.vacantArea += (r.vacantArea || 0); o.netArea += (r.netArea || 0); o.grossPotential += r.grossPotential;
        }
        return Object.values(g).map((o) => ({
          ...o,
          occPct: o.totalUnits ? +(o.occupied / o.totalUnits * 100).toFixed(1) : 0,
          vacPct: o.totalUnits ? +(o.vacant / o.totalUnits * 100).toFixed(1) : 0,
          standardRate: o.totalUnits ? R2(o.grossPotential / o.totalUnits) : 0, // avg list £/mo per unit, this type
          totalDollarPerArea: o.totalArea ? R2(o.grossPotential / o.totalArea * 12) : 0,
          occupiedDollarPerArea: o.occupiedArea ? R2(o.occupiedRent / o.occupiedArea * 12) : 0,
          occupiedRent: R2(o.occupiedRent), grossPotential: R2(o.grossPotential),
        })).sort((a, b) => b.totalUnits - a.totalUnits);
      })();

      // 1. Unit Size Breakdown table (direct match for a widget in Michael's KPI reference doc we
      // didn't have anywhere yet — Occupancy Statistics doesn't carry a standalone rate column at
      // this grain; RentalActivity does).
      const breakdownCols = [
        { key: 'type', label: 'Type', type: 'text' },
        { key: 'totalUnits', label: 'Total', type: 'int', align: 'right' }, { key: 'occupied', label: 'Occupied', type: 'int', align: 'right' },
        { key: 'vacant', label: 'Vacant', type: 'int', align: 'right' }, { key: 'occPct', label: 'Occupancy %', type: 'pct', align: 'right', color: 'threshold' },
        { key: 'standardRate', label: 'Avg List Rate', type: 'money', align: 'right' }, { key: 'occupiedDollarPerArea', label: 'Actual £/ft²', type: 'money2', align: 'right' },
      ];
      const breakdownTotals = { totalUnits: rows.reduce((a, r) => a + r.totalUnits, 0), occupied: rows.reduce((a, r) => a + r.occupied, 0), vacant: rows.reduce((a, r) => a + r.vacant, 0) };

      // 3. Rate Realization Gap — list vs actual achieved £/ft², both already annualised, so this
      // compares cleanly at ANY grain (type-level here) without needing a single unit's raw area.
      const gapRows = rows.map((r) => ({ ...r, gapPct: r.totalDollarPerArea ? R2((r.occupiedDollarPerArea - r.totalDollarPerArea) / r.totalDollarPerArea * 100) : 0 }));
      const gapCols = [
        { key: 'type', label: 'Type', type: 'text' },
        { key: 'totalDollarPerArea', label: 'List £/ft²/yr', type: 'money2', align: 'right' },
        { key: 'occupiedDollarPerArea', label: 'Actual £/ft²/yr', type: 'money2', align: 'right' },
        { key: 'gapPct', label: 'Gap %', type: 'pct', align: 'right', color: 'delta' },
      ];

      // 4. Turnover by Unit Type — moved-in/out/net by type (not available anywhere else; Move-ins
      // & Move-outs on the KPIs page is portfolio-wide only).
      const turnoverCols = [
        { key: 'type', label: 'Type', type: 'text' },
        { key: 'movedIn', label: 'Moved In', type: 'int', align: 'right' }, { key: 'movedOut', label: 'Moved Out', type: 'int', align: 'right' },
        { key: 'net', label: 'Net', type: 'int', align: 'right', color: 'delta' },
      ];
      const turnoverTotals = { movedIn: rows.reduce((a, r) => a + r.movedIn, 0), movedOut: rows.reduce((a, r) => a + r.movedOut, 0), net: rows.reduce((a, r) => a + r.net, 0) };

      // 5. Gross Potential vs Actual Revenue — the upside sitting in vacant units at list rate.
      const captureRows = rows.map((r) => ({ ...r, capturePct: r.grossPotential ? R2(r.occupiedRent / r.grossPotential * 100) : 0 }));
      const captureCols = [
        { key: 'type', label: 'Type', type: 'text' },
        { key: 'grossPotential', label: 'Gross Potential', type: 'money', align: 'right' }, { key: 'occupiedRent', label: 'Actual Revenue', type: 'money', align: 'right' },
        { key: 'capturePct', label: 'Capture %', type: 'pct', align: 'right', color: 'threshold' },
      ];

      // Vacant Units by Size chart + Transfer Flow table — REMOVED 6 Jul 2026 (Michael).
      out.statCards = [];
      out.chartCards = [];
      out.tables = [
        { title: 'Unit Size Breakdown', live: !!umRows, pageSize: 20, wide: true, columns: breakdownCols, rows, totals: breakdownTotals, totalsLabel: 'Total' },
        { title: 'Rate Realization Gap', live: !!umRows, pageSize: 20, wide: true, columns: gapCols, rows: gapRows },
        { title: 'Turnover by Unit Size', live: !!umRows, pageSize: 20, wide: true, columns: turnoverCols, rows, totals: turnoverTotals, totalsLabel: 'Total' },
        { title: 'Gross Potential vs Actual Revenue', live: !!umRows, pageSize: 20, wide: true, columns: captureCols, rows: captureRows },
      ];
    }

    return out;
  }

  const pageData = buildPage();

  // ---------- export (Excel) ----------
  const exportItemsRef = useRef([]);
  function withPage(pk) {
    const prev = page;
    // buildPage() closes over `page` state via closure — to preview another
    // page's data without a full state change we temporarily can't mutate React
    // state synchronously, so we recompute using a tiny local re-implementation
    // guard: since buildPage reads `page` from the outer scope, we call it only
    // for the current page in practice (all pages funnel through export below
    // using pageData for the active page, matching original behaviour for the
    // common case of exporting from the page currently in view).
    void prev;
    return pageData;
  }
  function buildExportGroups() {
    const sel = exportSel;
    const tableIcon = (
      <svg width={15} height={15} viewBox="0 0 24 24" fill="none"><rect x={3} y={4} width={18} height={16} rx={2} stroke="#98A2B3" strokeWidth={2} /><path d="M3 9h18M9 4v16" stroke="#98A2B3" strokeWidth={2} /></svg>
    );
    const chartIcon = (
      <svg width={15} height={15} viewBox="0 0 24 24" fill="none"><path d="M4 19V5M4 19h16M8 15v-4M12 15V9M16 15v-7" stroke="#98A2B3" strokeWidth={2} strokeLinecap="round" /></svg>
    );
    const items = [];
    items.push({
      id: 'kpi_summary', page: 'Dashboard', label: 'KPI Summary', icon: chartIcon,
      aoa: () => {
        const d = page === 'dashboard' ? pageData : withPage('dashboard');
        return [['KPI', 'Value', 'Change'], ...d.kpiRow.map((k) => [k.label, k.value, k.delta ? (k.dir === 'up' ? '+' : '-') + k.delta : ''])];
      },
    });
    const pages = { dashboard: 'Dashboard', kpis: 'KPIs', financials: 'Financials', ancillaries: 'Ancillaries', marketing: 'Marketing', mom: 'Month on Month', unitmix: 'Unit Mix Detail' };
    Object.keys(pages).forEach((pk) => {
      const d = pk === page ? pageData : withPage(pk);
      d.tables.forEach((t, i) => items.push({
        id: pk + '_t' + i, page: pages[pk], label: t.title, icon: tableIcon,
        aoa: () => [
          t.columns.map((c) => c.label),
          ...t.rows.map((r) => t.columns.map((c) => { const v = r[c.key]; return c.type && c.type !== 'text' ? (isNaN(+v) ? v : +v) : v; })),
          // Totals/average footer row (when the table has one) — same pinned row DataTable renders.
          ...(t.totals ? [t.columns.map((c, ci) => ci === 0 ? (t.totalsLabel || 'Total') : (t.totals[c.key] ?? ''))] : []),
        ],
      }));
      d.statCards.forEach((c, i) => items.push({
        id: pk + '_s' + i, page: pages[pk], label: c.title, icon: chartIcon,
        aoa: () => [['Metric', 'Value', 'Change'], ...c.tiles.map((t) => [t.label, t.value, t.delta ? (t.dir === 'up' ? '+' : t.dir === 'down' ? '-' : '') + t.delta : ''])],
      }));
    });
    const groups = {};
    items.forEach((it) => {
      it.checked = !!sel[it.id];
      it.onToggle = () => setExportSel((s) => ({ ...s, [it.id]: !s[it.id] }));
      it.typeIcon = it.icon;
      (groups[it.page] = groups[it.page] || []).push(it);
    });
    exportItemsRef.current = items;
    return Object.keys(groups).map((pg) => ({ page: pg, items: groups[pg] }));
  }

  const exportGroups = buildExportGroups();
  const exportCount = exportItemsRef.current.filter((i) => exportSel[i.id]).length;

  // Excel export: dynamically imports the `xlsx` npm package if present.
  // Kept as a clean no-op with a console warning if the package isn't
  // installed, so the button never crashes the page.
  async function runExport() {
    const chosen = exportItemsRef.current.filter((i) => exportSel[i.id]);
    if (!chosen.length) { alert('Select at least one widget to export.'); return; }
    let XLSX;
    try {
      XLSX = await import('xlsx');
    } catch (err) {
      console.warn('[portal-v2] xlsx package not available — export is a no-op. Run `npm install xlsx` to enable it.', err);
      alert('Excel export is unavailable in this build (xlsx package not installed).');
      return;
    }
    const wb = XLSX.utils.book_new();
    const used = {};
    chosen.forEach((it) => {
      let name = it.label.replace(/[^\w ]/g, '').slice(0, 28) || 'Sheet';
      if (used[name]) name = (name + ' ' + ++used[name]).slice(0, 31);
      else used[name] = 1;
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(it.aoa()), name);
    });
    // Filename reflects whatever month/range is currently selected via the PERIOD selector (Michael,
    // 6 Jul 2026) — sanitized since rangeLabel can contain "→" and spaces for a multi-month range.
    const safeRange = rangeLabel.replace(/\s*→\s*/g, ' to ').replace(/[^\w -]/g, '');
    XLSX.writeFile(wb, `Cinch Portal Export - ${safeRange}.xlsx`);
    setExportOpen(false);
  }

  // ---------- derived render values ----------
  const fs = filteredStores();
  const anySel = Object.values(selected).some(Boolean);
  const storeSummary = region !== 'All' ? region : anySel ? Object.values(selected).filter(Boolean).length + ' stores' : 'All stores';
  // FIXED 7 Jul 2026 (Michael: "the date picker only lets me see up to Jan 2025"): this used to look
  // labels up in the fixed 24-entry MONTHS placeholder array (buildMonths(), Jan 2025 -> Dec 2026
  // only), so any real stored month outside that window — real history goes back to 2016-06 — got an
  // out-of-bounds array index and silently rendered as a blank label, making those months impossible
  // to read/select in the FROM/TO dropdowns even though the server has the data (liveMonths already
  // included them). monthKeyOf()/indexOfMonthKey() are pure linear math valid for ANY year, not just
  // the 2025-2026 window, so compute the label directly instead of indexing into the placeholder array.
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLbl = (i) => { const [y, m] = monthKeyOf(i).split('-').map(Number); return `${MONTH_NAMES[m - 1]} ${y}`; };
  const rangeLabel = monthFrom === monthTo ? monthLbl(monthTo) : monthLbl(monthFrom) + ' → ' + monthLbl(monthTo);
  // FIXED 8 Jul 2026: fs.length was always the mock STORES count (27), even in live mode — with 29
  // real sites now configured, the subtitle would keep showing the stale "27" regardless. Can't
  // reuse buildPage()'s own `liveSites` const here — this block is a SEPARATE, outer scope (that
  // ReferenceError is exactly why the first version of this fix broke the page) — so the same
  // liveSitesRaw+selected filter logic is inlined here instead.
  const liveSiteCount = liveSitesRaw ? (anySel ? liveSitesRaw.filter((s) => selected[s.name]).length : liveSitesRaw.length) : null;
  const subtitle = storeSummary + ' · portfolio (' + (liveSiteCount ?? fs.length) + ') · ' + rangeLabel + (viewLive ? '' : ' (viewing)');
  // Restrict the FROM/TO dropdowns to months that actually have data once it's loaded, instead of
  // the full static 24-month placeholder list (which includes months nobody has pulled yet).
  const AVAILABLE_MONTHS = liveMonths && liveMonths.length ? liveMonths.map((mk) => ({ value: indexOfMonthKey(mk), label: monthLbl(indexOfMonthKey(mk)) })) : MONTHS;
  const titles = { dashboard: 'Dashboard', kpis: 'KPIs', financials: 'Financials', ancillaries: 'Ancillaries', marketing: 'Marketing', mom: 'Month on Month', unitmix: 'Unit Mix Detail' };

  const kpiRow = pageData.kpiRow.map((k) => ({ ...k, hasDelta: !!k.delta, ...chip(k.delta, k.dir) }));
  const statCards = pageData.statCards.map((c) => ({
    title: c.title, live: !!c.live, dotColor: c.dotColor || (c.live ? C.teal : C.blue),
    hasViz: !!c.hasViz, el: c.el, hasNote: !!c.note, note: c.note,
    tiles: c.tiles.map((t) => ({
      value: t.value, label: t.label, delta: t.delta, hasDelta: t.delta != null,
      valueStyle: { fontSize: c.hasViz ? '28px' : '24px', fontWeight: 700, letterSpacing: '-.02em', color: '#0C1425', fontVariantNumeric: 'tabular-nums', lineHeight: 1 },
      ...chip(t.delta, t.dir),
    })),
  }));
  const chartCards = pageData.chartCards.map((c) => ({
    title: c.title, dotColor: c.dotColor || C.blue, el: c.el, removable: !!c.removable, onRemove: c.onRemove,
    wide: !!c.wide,
  }));
  const tables = pageData.tables;

  // FIXED 8 Jul 2026 (Michael: "the store filter names are all messed up"): storeOptions always
  // listed the stale mock STORES names (27 entries carried over from the original decoded-artifact
  // prototype) — several don't exist in the real portfolio at all (Reading, Guildford, Basildon,
  // Chelmsford, Maidstone, Luton, Milton Keynes, Croydon, Ipswich), while 11 real sites were missing
  // entirely (Chippenham, Enfield, Seaford, Dunstable, Swindon, Wisbech, Shoreham-By-Sea, Paulton,
  // Exeter, plus the just-added Edmonton/Abingdon) — so real sites could never be selected at all,
  // and mock-name checkboxes matched zero real sites when toggled. Now lists the REAL site names
  // from liveSitesRaw when available (matches liveSites' own name-based selection filter above),
  // falling back to the original mock STORES behavior only when live data isn't configured/available.
  // Region grouping has no live equivalent (no region field anywhere in the real data model — see
  // liveSites' own comment above), so live mode lists names flat with no region chip beyond "All".
  const storeOptions = liveSitesRaw
    ? liveSitesRaw.map((s) => ({
        name: s.name, region: null, checked: !!selected[s.name],
        onToggle: () => { setSelected((p) => ({ ...p, [s.name]: !p[s.name] })); reload(); },
      }))
    : STORES.filter((st) => region === 'All' || st.region === region).map((st) => ({
        name: st.name, region: st.region, checked: !!selected[st.name],
        onToggle: () => { setSelected((p) => ({ ...p, [st.name]: !p[st.name] })); reload(); },
      }));
  const regionChips = (liveSitesRaw ? ['All'] : ['All', ...REGIONS]).map((r) => ({
    label: r,
    onClick: () => { setRegion(r); setSelected({}); reload(); },
    active: region === r,
  }));
  const presets = ['1M', '3M', '6M', '12M', 'YTD', 'All'].map((pl) => ({ label: pl, active: period === pl, onClick: () => applyPreset(pl) }));

  const builderSigns = [{ value: '/', label: '÷' }, { value: '*', label: '×' }, { value: '+', label: '+' }, { value: '-', label: '−' }];

  const navGroups = [
    { label: 'Overview', items: [{ id: 'dashboard', label: 'Dashboard' }] },
    { label: 'Performance', items: [{ id: 'kpis', label: 'KPIs' }, { id: 'financials', label: 'Financials' }, { id: 'ancillaries', label: 'Ancillaries' }, { id: 'unitmix', label: 'Unit Mix Detail' }] },
    { label: 'Growth', items: [{ id: 'marketing', label: 'Marketing' }] },
    { label: 'Trends', items: [{ id: 'mom', label: 'Month on Month' }] },
  ];

  const createWidget = () => {
    const autoName = builderFields.map((f, i) => (i === 0 ? '' : ' ' + OP_SYMBOL[builderOps[i - 1]] + ' ') + fieldLabel(f)).join('');
    const name = builderName.trim() || autoName;
    setCustomWidgets((p) => [...p, { id: Date.now(), name, fields: builderFields, ops: builderOps }]);
    setBuilderOpen(false);
    setBuilderName('');
    setBuilderFields(['rent', 'occA']);
    setBuilderOps(['/']);
  };
  const addBuilderColumn = () => {
    if (builderFields.length >= 4) return;
    setBuilderFields((f) => [...f, 'occ']);
    setBuilderOps((o) => [...o, '/']);
  };
  const removeBuilderColumn = (idx) => {
    if (builderFields.length <= 2) return;
    setBuilderFields((f) => f.filter((_, i) => i !== idx));
    setBuilderOps((o) => o.filter((_, i) => i !== Math.max(0, idx - 1)));
  };
  const setBuilderField = (idx, value) => setBuilderFields((f) => f.map((x, i) => i === idx ? value : x));
  const setBuilderOp = (idx, value) => setBuilderOps((o) => o.map((x, i) => i === idx ? value : x));

  const skel6 = [0, 1, 2, 3, 4, 5];

  return (
    <>
      {/* Fonts: original used self-hosted @font-face declarations for IBM Plex
          Mono/Sans across many unicode-range subsets. We replicate the same
          effect (and origin: Google Fonts) via the standard Google Fonts CSS
          link, which is simpler and equivalent for our purposes. */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 10px; height: 10px; }
        ::-webkit-scrollbar-thumb { background: #D0D5DD; border-radius: 8px; border: 2px solid transparent; background-clip: content-box; }
        ::-webkit-scrollbar-thumb:hover { background: #98A2B3; background-clip: content-box; }
        @keyframes shim { 0% { background-position: -500px 0; } 100% { background-position: 500px 0; } }
        @keyframes cardIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      <div style={{ display: 'flex', height: '100vh', width: '100%', overflow: 'hidden', background: '#F6F7F9', fontFamily: "'IBM Plex Sans',system-ui,-apple-system,sans-serif", color: '#101828', WebkitFontSmoothing: 'antialiased' }}>

        {/* Sidebar */}
        <aside style={{ flex: 'none', width: sidebarOpen ? '236px' : '70px', background: '#fff', borderRight: '1px solid #EAECF0', display: 'flex', flexDirection: 'column', transition: 'width .22s cubic-bezier(.2,.8,.2,1)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '20px 18px 18px', overflow: 'hidden' }}>
            <div style={{ width: 30, height: 30, borderRadius: '8px', background: '#2757E8', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width={17} height={17} viewBox="0 0 24 24" fill="none"><rect x={3} y={3} width={8} height={8} rx={2} fill="#fff" /><rect x={13} y={13} width={8} height={8} rx={2} fill="#fff" opacity={0.7} /><rect x={13} y={3} width={8} height={8} rx={2} fill="#fff" opacity={0.45} /></svg>
            </div>
            {sidebarOpen && (
              <div style={{ lineHeight: 1, whiteSpace: 'nowrap' }}>
                <div style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '-.01em', color: '#0C1425' }}>CINCH</div>
                <div style={{ fontSize: '9.5px', fontWeight: 600, letterSpacing: '.16em', color: '#98A2B3', marginTop: '3px' }}>SELF STORAGE</div>
              </div>
            )}
          </div>

          <nav style={{ flex: 1, overflowY: 'auto', padding: '6px 10px' }}>
            {navGroups.map((g, gi) => (
              <div key={gi} style={{ marginBottom: '14px' }}>
                {sidebarOpen && <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: '#98A2B3', padding: '6px 10px 4px', whiteSpace: 'nowrap' }}>{g.label}</div>}
                {g.items.map((it) => {
                  const active = page === it.id;
                  return (
                    <button
                      key={it.id}
                      onClick={() => { setPage(it.id); reload(); }}
                      title={it.label}
                      style={{ display: 'flex', alignItems: 'center', gap: '11px', width: '100%', padding: '9px 10px', border: 'none', borderRadius: '10px', cursor: 'pointer', background: active ? '#EEF3FF' : 'transparent', textAlign: 'left', marginBottom: '2px', fontFamily: 'inherit' }}
                    >
                      <span style={{ display: 'flex', width: '20px', justifyContent: 'center', color: active ? '#2757E8' : '#8A94A6', flex: 'none' }}><NavIcon id={it.id} /></span>
                      {sidebarOpen && <span style={{ fontSize: '14px', fontWeight: active ? 600 : 500, color: active ? '#0C1425' : '#475467', whiteSpace: 'nowrap' }}>{it.label}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>

          <div style={{ borderTop: '1px solid #EAECF0', padding: '10px' }}>
            <button onClick={() => setSidebarOpen((p) => !p)} style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', padding: '9px 10px', border: 'none', background: 'transparent', borderRadius: '9px', cursor: 'pointer', color: '#667085', fontFamily: 'inherit', fontSize: '13px' }}>
              <span style={{ width: 20, display: 'flex', justifyContent: 'center' }}>
                <svg width={18} height={18} viewBox="0 0 24 24" fill="none"><path d={sidebarOpen ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} stroke="#98A2B3" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
              </span>
              {sidebarOpen && <span style={{ whiteSpace: 'nowrap' }}>Collapse</span>}
            </button>
          </div>
        </aside>

        {/* Main column */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

          <header style={{ flex: 'none', background: '#fff', borderBottom: '1px solid #EAECF0', zIndex: 30, position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '11px 22px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '.06em', color: '#98A2B3' }}>STORES</span>
                <div style={{ position: 'relative' }}>
                  <button onClick={(e) => { e.stopPropagation(); setStorePopOpen((p) => !p); setPeriodPopOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontFamily: 'inherit', fontSize: '13px', fontWeight: 500, color: '#101828', background: '#fff', border: '1px solid #E4E7EC', borderRadius: '9px', padding: '8px 11px', cursor: 'pointer' }}>
                    {storeSummary}
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" style={{ marginLeft: '2px' }}><path d="m6 9 6 6 6-6" stroke="#667085" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                  {storePopOpen && (
                    <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', left: 0, top: 'calc(100% + 8px)', zIndex: 50, background: '#fff', border: '1px solid #E4E7EC', borderRadius: '12px', boxShadow: '0 12px 32px rgba(16,24,40,.14)', width: '300px', padding: '12px' }}>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
                        {regionChips.map((rc) => (
                          <button key={rc.label} onClick={rc.onClick} style={{ fontFamily: 'inherit', fontSize: '11.5px', fontWeight: 500, padding: '5px 10px', borderRadius: '999px', cursor: 'pointer', border: '1px solid ' + (rc.active ? '#2757E8' : '#E4E7EC'), background: rc.active ? '#EEF3FF' : '#fff', color: rc.active ? '#2757E8' : '#475467' }}>{rc.label}</button>
                        ))}
                      </div>
                      <div style={{ maxHeight: '230px', overflowY: 'auto', margin: '0 -4px' }}>
                        {storeOptions.map((so) => (
                          <label key={so.name} style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '7px 8px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', color: '#344054' }}>
                            <input type="checkbox" checked={so.checked} onChange={so.onToggle} style={{ accentColor: '#2757E8', width: 15, height: 15 }} />
                            <span style={{ flex: 1 }}>{so.name}</span>
                            <span style={{ fontSize: '11px', color: '#98A2B3' }}>{so.region}</span>
                          </label>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: '8px', justifyContent: 'space-between', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #F2F4F7' }}>
                        <button onClick={() => { const sel = {}; storeOptions.forEach((o) => (sel[o.name] = true)); setSelected(sel); reload(); }} style={{ fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 500, color: '#2757E8', background: 'none', border: 'none', cursor: 'pointer' }}>Select all</button>
                        <button onClick={() => { setSelected({}); reload(); }} style={{ fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 500, color: '#667085', background: 'none', border: 'none', cursor: 'pointer' }}>Clear</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '.06em', color: '#98A2B3' }}>PERIOD</span>
                <div style={{ display: 'flex', background: '#F2F4F7', borderRadius: '9px', padding: '3px', gap: '2px' }}>
                  {presets.map((p) => (
                    <button key={p.label} onClick={p.onClick} style={{ fontFamily: 'inherit', fontSize: '12px', fontWeight: 600, padding: '6px 11px', borderRadius: '7px', border: 'none', cursor: 'pointer', background: p.active ? '#fff' : 'transparent', color: p.active ? '#2757E8' : '#667085', boxShadow: p.active ? '0 1px 2px rgba(16,24,40,.08)' : 'none' }}>{p.label}</button>
                  ))}
                </div>
                <div style={{ position: 'relative' }}>
                  <button onClick={(e) => { e.stopPropagation(); setPeriodPopOpen((p) => !p); setStorePopOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 500, color: '#344054', background: '#fff', border: '1px solid #E4E7EC', borderRadius: '9px', padding: '8px 11px', cursor: 'pointer' }}>
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" style={{ marginRight: '2px' }}><rect x={3} y={5} width={18} height={16} rx={2} stroke="#667085" strokeWidth={2} /><path d="M3 9h18M8 3v4M16 3v4" stroke="#667085" strokeWidth={2} strokeLinecap="round" /></svg>
                    {rangeLabel}
                  </button>
                  {periodPopOpen && (
                    <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', left: 0, top: 'calc(100% + 8px)', zIndex: 50, background: '#fff', border: '1px solid #E4E7EC', borderRadius: '12px', boxShadow: '0 12px 32px rgba(16,24,40,.14)', width: '260px', padding: '14px' }}>
                      <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '.05em', color: '#98A2B3', marginBottom: '6px' }}>FROM</div>
                      <select value={monthFrom} onChange={(e) => { setPeriod('custom'); selectRange(+e.target.value, monthTo); }} style={{ width: '100%', fontFamily: 'inherit', fontSize: '13px', padding: '9px 10px', border: '1px solid #E4E7EC', borderRadius: '9px', color: '#101828', background: '#fff', marginBottom: '12px' }}>
                        {AVAILABLE_MONTHS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                      <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '.05em', color: '#98A2B3', marginBottom: '6px' }}>TO</div>
                      <select value={monthTo} onChange={(e) => { setPeriod('custom'); selectRange(monthFrom, +e.target.value); }} style={{ width: '100%', fontFamily: 'inherit', fontSize: '13px', padding: '9px 10px', border: '1px solid #E4E7EC', borderRadius: '9px', color: '#101828', background: '#fff' }}>
                        {AVAILABLE_MONTHS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </div>
                  )}
                </div>
              </div>

              <div style={{ flex: 1 }} />

              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: '#08875D', background: '#E7F6EF', borderRadius: '8px', padding: '6px 10px', fontWeight: 600 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#08875D' }} />Live data
              </div>
              <span style={{ fontSize: '12px', color: '#98A2B3', whiteSpace: 'nowrap' }}>Updated {updated}</span>
              <button onClick={() => { setSpin(true); setUpdated('just now'); reload(); setTimeout(() => setSpin(false), 650); }} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 500, color: '#344054', background: '#fff', border: '1px solid #E4E7EC', borderRadius: '9px', padding: '8px 11px', cursor: 'pointer' }}>
                <span style={{ display: 'flex', animation: spin ? 'spin .65s linear' : 'none' }}>
                  <svg width={15} height={15} viewBox="0 0 24 24" fill="none"><path d="M20 11a8 8 0 1 0-.6 3" stroke="#667085" strokeWidth={2} strokeLinecap="round" /><path d="M20 4v5h-5" stroke="#667085" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>
                Refresh
              </button>
              <button onClick={() => setExportOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 600, color: '#fff', background: '#2757E8', border: 'none', borderRadius: '9px', padding: '9px 13px', cursor: 'pointer', boxShadow: '0 1px 2px rgba(39,87,232,.3)' }}>
                <svg width={15} height={15} viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
                Export
              </button>
            </div>
          </header>

          <div style={{ flex: 'none', background: '#fff', borderBottom: '1px solid #EAECF0', padding: '14px 24px', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: '#98A2B3', marginBottom: '5px' }}>
                <span>Portal</span>
                <svg width={12} height={12} viewBox="0 0 24 24" fill="none"><path d="m9 6 6 6-6 6" stroke="#CBD2DC" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
                <span style={{ color: '#475467', fontWeight: 500 }}>{titles[page]}</span>
              </div>
              <h1 style={{ margin: 0, fontSize: '23px', fontWeight: 700, letterSpacing: '-.02em', color: '#0C1425' }}>{titles[page]}</h1>
              <div style={{ fontSize: '13px', color: '#667085', marginTop: '3px' }}>{subtitle}</div>
            </div>
            {page === 'dashboard' && (
              <button onClick={() => setBuilderOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600, color: '#2757E8', background: '#EEF3FF', border: '1px solid #DCE6FF', borderRadius: '9px', padding: '9px 13px', cursor: 'pointer' }}>
                <svg width={15} height={15} viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="#2757E8" strokeWidth={2} strokeLinecap="round" /></svg>
                Build a widget
              </button>
            )}
          </div>

          <main style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
            {loading && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: '16px', marginBottom: '20px' }}>
                  {skel6.map((s) => (
                    <div key={s} style={{ height: '104px', borderRadius: '16px', background: 'linear-gradient(90deg,#EFF1F4 25%,#F7F8FA 37%,#EFF1F4 63%)', backgroundSize: '900px 100%', animation: 'shim 1.4s infinite linear' }} />
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '16px' }}>
                  <div style={{ height: '360px', borderRadius: '16px', background: 'linear-gradient(90deg,#EFF1F4 25%,#F7F8FA 37%,#EFF1F4 63%)', backgroundSize: '900px 100%', animation: 'shim 1.4s infinite linear' }} />
                  <div style={{ height: '360px', borderRadius: '16px', background: 'linear-gradient(90deg,#EFF1F4 25%,#F7F8FA 37%,#EFF1F4 63%)', backgroundSize: '900px 100%', animation: 'shim 1.4s infinite linear' }} />
                </div>
              </>
            )}

            {!loading && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>

                {kpiRow.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: '14px' }}>
                    {kpiRow.map((k, ki) => (
                      <div key={ki} style={{ background: '#fff', border: '1px solid #EAECF0', borderRadius: '16px', boxShadow: '0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06)', padding: '16px 18px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#98A2B3' }}>{k.label}</div>
                        <div style={{ fontSize: '26px', fontWeight: 700, letterSpacing: '-.02em', color: '#0C1425', marginTop: '8px', fontVariantNumeric: 'tabular-nums' }}>{k.value}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                          {k.hasDelta && <span style={k.deltaStyle}>{k.deltaArrow} {k.delta}</span>}
                          <span style={{ fontSize: '12px', color: '#98A2B3' }}>{k.sub}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {statCards.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: '16px' }}>
                    {statCards.map((c, ci) => (
                      <div key={ci} style={{ background: '#fff', border: '1px solid #EAECF0', borderRadius: '16px', boxShadow: '0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06)', overflow: 'hidden' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '14px 18px', borderBottom: '1px solid #F2F4F7' }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.dotColor }} />
                          <span style={{ fontSize: '12.5px', fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: '#475467' }}>{c.title}</span>
                          {c.live && <span style={{ fontSize: '9.5px', fontWeight: 700, letterSpacing: '.08em', color: '#08875D', background: '#E7F6EF', borderRadius: '5px', padding: '2px 6px' }}>LIVE</span>}
                        </div>
                        <div style={{ padding: '18px', display: 'flex', alignItems: 'center', gap: '18px' }}>
                          <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: '20px 26px' }}>
                            {c.tiles.map((t, ti) => (
                              <div key={ti}>
                                <div style={t.valueStyle}>{t.value}</div>
                                <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#98A2B3', marginTop: '5px' }}>{t.label}</div>
                                {t.hasDelta && <span style={t.deltaStyle}>{t.deltaArrow} {t.delta}</span>}
                              </div>
                            ))}
                          </div>
                          {c.hasViz && <div style={{ flex: 'none' }}>{c.el}</div>}
                        </div>
                        {c.hasNote && <div style={{ padding: '0 18px 14px', fontSize: '12px', color: '#98A2B3' }}>{c.note}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {tables.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {tables.map((t, ti) => (
                      <DataTable key={ti} title={t.title} columns={t.columns} rows={t.rows} live={t.live} pageSize={t.pageSize || 12} totals={t.totals} totalsLabel={t.totalsLabel} />
                    ))}
                  </div>
                )}

                {chartCards.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: '16px' }}>
                    {chartCards.map((c, ci) => (
                      <div key={ci} style={{ background: '#fff', border: '1px solid #EAECF0', borderRadius: '16px', boxShadow: '0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06)', overflow: 'hidden', gridColumn: c.wide ? '1/-1' : undefined }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '14px 18px', borderBottom: '1px solid #F2F4F7' }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.dotColor }} />
                          <span style={{ fontSize: '12.5px', fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: '#475467', flex: 1 }}>{c.title}</span>
                          {c.removable && (
                            <button onClick={c.onRemove} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#98A2B3', display: 'flex', padding: '2px' }}>
                              <svg width={15} height={15} viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="#98A2B3" strokeWidth={2} strokeLinecap="round" /></svg>
                            </button>
                          )}
                        </div>
                        <div style={{ padding: '18px' }}>{c.el}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Unit Mix table: preserved as dead code in the original —
                    buildPage() never populates out.unitMix, so this section
                    never renders (hasUnitMix is always false). Kept faithful. */}
                {pageData.unitMix.length > 0 && (
                  <div style={{ background: '#fff', border: '1px solid #EAECF0', borderRadius: '16px', boxShadow: '0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06)', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '14px 18px', borderBottom: '1px solid #F2F4F7' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#2757E8' }} />
                      <span style={{ fontSize: '12.5px', fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: '#475467' }}>Unit Mix Occupancy</span>
                    </div>
                  </div>
                )}

                {page === 'marketing' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#B54708', background: '#FFFAEB', border: '1px solid #FEDF89', borderRadius: '10px', padding: '10px 14px' }}>
                    <svg width={15} height={15} viewBox="0 0 24 24" fill="none"><path d="M12 8v5m0 3h.01M12 3l9 16H3l9-16Z" stroke="#B54708" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
                    Marketing widgets are inferred — no reference screenshot was supplied. Share the live page and I&apos;ll match its exact widgets.
                  </div>
                )}

              </div>
            )}
          </main>
        </div>

        {/* Export modal */}
        {exportOpen && (
          <div onClick={() => setExportOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,37,.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: '18px', width: '560px', maxWidth: '100%', maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(16,24,40,.28)', overflow: 'hidden' }}>
              <div style={{ padding: '20px 22px', borderBottom: '1px solid #F2F4F7', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: '17px', fontWeight: 700, color: '#0C1425' }}>Export to Excel</div>
                  <div style={{ fontSize: '13px', color: '#667085', marginTop: '3px' }}>Choose the widgets and tables to include. Each becomes its own sheet.</div>
                </div>
                <button onClick={() => setExportOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#98A2B3', padding: '4px' }}>
                  <svg width={20} height={20} viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="#98A2B3" strokeWidth={2} strokeLinecap="round" /></svg>
                </button>
              </div>
              <div style={{ display: 'flex', gap: '10px', padding: '12px 22px', borderBottom: '1px solid #F2F4F7' }}>
                <button onClick={() => { const sel = {}; exportItemsRef.current.forEach((i) => (sel[i.id] = true)); setExportSel(sel); }} style={{ fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 500, color: '#2757E8', background: '#EEF3FF', border: '1px solid #DCE6FF', borderRadius: '8px', padding: '6px 11px', cursor: 'pointer' }}>Select all</button>
                <button onClick={() => setExportSel({})} style={{ fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 500, color: '#667085', background: '#F2F4F7', border: 'none', borderRadius: '8px', padding: '6px 11px', cursor: 'pointer' }}>Clear</button>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: '12.5px', color: '#98A2B3', alignSelf: 'center' }}>{exportCount} selected</span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '8px 22px 16px' }}>
                {exportGroups.map((g) => (
                  <div key={g.page} style={{ marginTop: '14px' }}>
                    <div style={{ fontSize: '10.5px', fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase', color: '#98A2B3', marginBottom: '4px' }}>{g.page}</div>
                    {g.items.map((it) => (
                      <label key={it.id} style={{ display: 'flex', alignItems: 'center', gap: '11px', padding: '9px 8px', borderRadius: '9px', cursor: 'pointer', fontSize: '13.5px', color: '#344054' }}>
                        <input type="checkbox" checked={it.checked} onChange={it.onToggle} style={{ accentColor: '#2757E8', width: 16, height: 16 }} />
                        <span style={{ display: 'flex', flex: 'none' }}>{it.typeIcon}</span>
                        <span style={{ flex: 1 }}>{it.label}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
              <div style={{ padding: '16px 22px', borderTop: '1px solid #F2F4F7', display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button onClick={() => setExportOpen(false)} style={{ fontFamily: 'inherit', fontSize: '13.5px', fontWeight: 500, color: '#344054', background: '#fff', border: '1px solid #E4E7EC', borderRadius: '10px', padding: '10px 16px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={runExport} style={{ fontFamily: 'inherit', fontSize: '13.5px', fontWeight: 600, color: '#fff', background: '#2757E8', border: 'none', borderRadius: '10px', padding: '10px 18px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '7px' }}>
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
                  Export{exportCount ? ` (${exportCount})` : ''}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Builder modal */}
        {builderOpen && (
          <div onClick={() => setBuilderOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,37,.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: '18px', width: '460px', maxWidth: '100%', boxShadow: '0 24px 64px rgba(16,24,40,.28)', overflow: 'hidden' }}>
              <div style={{ padding: '20px 22px', borderBottom: '1px solid #F2F4F7' }}>
                <div style={{ fontSize: '17px', fontWeight: 700, color: '#0C1425' }}>Build a widget</div>
                <div style={{ fontSize: '13px', color: '#667085', marginTop: '3px' }}>Combine 2-4 fields into a per-store chart for the period in view. Runs against live data when a pull is loaded.</div>
              </div>
              <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '52vh', overflowY: 'auto' }}>
                {builderFields.map((fieldVal, idx) => (
                  <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {idx > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'center' }}>
                        <select value={builderOps[idx - 1]} onChange={(e) => setBuilderOp(idx - 1, e.target.value)} style={{ fontFamily: 'inherit', fontSize: '14px', padding: '6px 10px', border: '1px solid #E4E7EC', borderRadius: '8px', background: '#F9FAFB', color: '#101828', textAlign: 'center' }}>
                          {builderSigns.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                        </select>
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'end' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#98A2B3', marginBottom: '5px' }}>Field {String.fromCharCode(65 + idx)}</div>
                        <select value={fieldVal} onChange={(e) => setBuilderField(idx, e.target.value)} style={{ width: '100%', fontFamily: 'inherit', fontSize: '13px', padding: '9px 10px', border: '1px solid #E4E7EC', borderRadius: '9px', background: '#fff', color: '#101828' }}>
                          {FIELD_CATALOG.map((g) => (
                            <optgroup key={g.group} label={g.group}>
                              {g.items.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                            </optgroup>
                          ))}
                        </select>
                      </div>
                      {builderFields.length > 2 && (
                        <button onClick={() => removeBuilderColumn(idx)} title="Remove field" style={{ flexShrink: 0, width: '34px', height: '34px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', border: '1px solid #E4E7EC', borderRadius: '9px', color: '#98A2B3', cursor: 'pointer' }}>
                          <svg width={14} height={14} viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" /></svg>
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {builderFields.length < 4 && (
                  <button onClick={addBuilderColumn} style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 600, color: '#2757E8', background: '#EFF4FF', border: 'none', borderRadius: '8px', padding: '7px 12px', cursor: 'pointer' }}>
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" /></svg>
                    Add field ({builderFields.length}/4)
                  </button>
                )}
                <div>
                  <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#98A2B3', marginBottom: '5px' }}>Widget name</div>
                  <input value={builderName} onChange={(e) => setBuilderName(e.target.value)} placeholder="e.g. Rent Roll per Unit" style={{ width: '100%', fontFamily: 'inherit', fontSize: '13.5px', padding: '9px 11px', border: '1px solid #E4E7EC', borderRadius: '9px', color: '#101828', outline: 'none' }} />
                </div>
              </div>
              <div style={{ padding: '16px 22px', borderTop: '1px solid #F2F4F7', display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button onClick={() => setBuilderOpen(false)} style={{ fontFamily: 'inherit', fontSize: '13.5px', fontWeight: 500, color: '#344054', background: '#fff', border: '1px solid #E4E7EC', borderRadius: '10px', padding: '10px 16px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={createWidget} style={{ fontFamily: 'inherit', fontSize: '13.5px', fontWeight: 600, color: '#fff', background: '#2757E8', border: 'none', borderRadius: '10px', padding: '10px 18px', cursor: 'pointer' }}>Create widget</button>
              </div>
            </div>
          </div>
        )}

      </div>
    </>
  );
}
