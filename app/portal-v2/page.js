'use client';

// Faithful React port of the decoded Cinch portal artifact bundle.
// The original was a two-part system: a `DCLogic`-based class (this component's
// logic: state, setState, render-value builder) rendered against a declarative
// HTML template (`<x-dc>...</x-dc>`) using `{{ }}` interpolation, `sc-if`, and
// `sc-for` bindings. `h(...)` in the original mapped 1:1 to `React.createElement`.
// This file collapses both halves into one idiomatic React function component
// using hooks, preserving all state, derived values, and markup 1:1.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '../../lib/supabaseBrowser.js';
import { BG_IMG } from '../../lib/uiAssets.js';

const C = { blue: '#2757E8', blue2: '#7CA0F4', teal: '#12B5A5', slate: '#94A3B8', green: '#08875D', red: '#D92D20', amber: '#F79009', track: '#EEF1F5' };
const SITE_NAME_BY_CODE = {
  L001: 'Bicester', L002: 'Leighton Buzzard', L003: 'Letchworth', L004: 'Chippenham', L005: 'Brighton',
  L006: 'Huntingdon', L007: 'Newmarket', L008: 'Enfield', L009: 'Newbury', L010: 'Mitcham',
  L011: 'Sittingbourne', L012: 'Gillingham', L013: 'Brentwood', L014: 'Earlsfield', L015: 'Watford',
  L016: 'Seaford', L017: 'Southend', L018: 'Woking', L019: 'Sidcup', L020: 'Dunstable',
  L021: 'Bedford', L022: 'Swindon', L023: 'Wisbech', L024: 'Newcastle', L025: 'Shoreham-By-Sea',
  L026: 'Paulton', L027: 'Exeter', L028: 'Edmonton', L029: 'Abingdon',
};
const debugWarn = (...args) => {
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.warn(...args);
  }
};

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
    n: sites.length, occ, tot, occA, claA, totA, rent, gpot: sum('gpot'), grossOcc: sum('grossOcc'), occActualRent: sum('occActualRent'),
    occPC: tot ? +(occ / tot * 100).toFixed(1) : 0,
    // Mirror lib/buildPayload.js exactly: `areaPC` is the CLA-basis occupancy figure, with
    // `areaPCmla`/`claPC` covering the MLA and explicit aggregate variants separately.
    areaPC: claA ? +(occA / claA * 100).toFixed(1) : (totA ? +(occA / totA * 100).toFixed(1) : 0),
    areaPCmla: totA ? +(occA / totA * 100).toFixed(1) : 0,
    // Economic Occupancy (task #356) — mirrors lib/buildPayload.js's aggregateTotals() exactly, same
    // sum-then-divide-once rule as every other rollup here.
    economicOccPct: sum('gpot') ? +(sum('occActualRent') / sum('gpot') * 100).toFixed(1) : 0,
    claPC: claA ? +(occA / claA * 100).toFixed(1) : (totA ? +(occA / totA * 100).toFixed(1) : 0),
    // Rate: FIXED 23 Jul 2026 (task #308 follow-up) — this client-side recompute (needed so the store
    // filter can re-derive totals without a server round-trip) was still reading stdRentSum/
    // ssStdRentSum (the pre-billing-adjustment dcStdRate-based fields), even after task #401 swapped
    // lib/buildPayload.js's OWN aggregateTotals()/buildHistory()/range-merge over to adjRentSum/
    // ssAdjRentSum on 22 Jul. Caught by comparing this page's own KPI tile (£31.20, this stale path)
    // against the Units-by-Customer-Type table's per-site row (£28.44, reading site.rate directly —
    // already on the new formula) for Bicester/Jun 2026 — same site, same month, two different numbers.
    // adjRentSum/ssAdjRentSum are already present on every site record (buildPayload.js line ~181),
    // this was just never updated to read them. Real Rate: REPLACED 8 Jul 2026 to mirror
    // lib/buildPayload.js's aggregateTotals() exactly — True Revenue-based (Σ(TruePeriod−adj)),
    // divided by TOTAL area (areaTotalAll, incl. vacant units), NOT areaSum (occupied-only, still
    // correct for Rate). Keep this in sync with lib/buildPayload.js if that file changes.
    // realRate SWITCHED 24 Jul 2026 (task #308/#404/#405) from trueRevenueNumerator/areaTotalAll to
    // rentTruePeriod/realRateArea, mirroring lib/buildPayload.js's aggregateTotals() exactly — see
    // that function's comment for the full root-cause/validation (Rent-only True Revenue ÷ rewound-
    // or-frozen occupied area). Both new fields are always populated on every site record (each falls
    // back to the pre-24-Jul figures whenever the newer inputs aren't available), so this stays
    // correct for a store-filtered subset exactly like the unfiltered server-side total does.
    rate: sum('areaSum') ? R2(sum('adjRentSum') / sum('areaSum') * 12) : 0,
    realRate: sum('realRateArea') ? R2(sum('rentTruePeriod') / sum('realRateArea') * 12) : 0,
    ssRate: sum('ssAreaSum') ? R2(sum('ssAdjRentSum') / sum('ssAreaSum') * 12) : 0,
    // ssReal SWITCHED 24 Jul 2026 (task #308 follow-up, Michael: "self storage is the same rate but
    // you [need to] put a filter on the type to only be self storage not everything") from
    // ssTrueRevenueNumerator/ssAreaTotalAll to ssRentTruePeriod/ssRealArea, mirroring
    // lib/buildPayload.js's aggregateTotals() exactly — see recordFor()'s ssReal comment for the
    // full explanation (Self-Storage-scoped Rent-only ÷ Self Storage's occupied area — NOT rewound,
    // unlike Total realRate above, since move_ins_outs doesn't split moves by unit type).
    ssReal: sum('ssRealArea') ? R2(sum('ssRentTruePeriod') / sum('ssRealArea') * 12) : 0,
    ssOcc: sites.reduce((a, s) => a + (s.ss ? s.ss.occ : 0), 0), ssTot: sites.reduce((a, s) => a + (s.ss ? s.ss.tot : 0), 0),
    officesOcc: sites.reduce((a, s) => a + (s.offices ? s.offices.occ : 0), 0), officesTot: sites.reduce((a, s) => a + (s.offices ? s.offices.tot : 0), 0),
    officesRate: sum('officesAreaSum') ? R2(sum('officesRentSum') / sum('officesAreaSum') * 12) : 0,
  };
  t.ssOccPC = t.ssTot ? +(t.ssOcc / t.ssTot * 100).toFixed(1) : 0;
  t.officesOccPC = t.officesTot ? +(t.officesOcc / t.officesTot * 100).toFixed(1) : 0;
  const debtAccounts = sites.reduce((a, s) => a + (s.debtors ? s.debtors.accounts : 0), 0);
  // Keep the client-side store-filter recompute on the same explicit 30+ day bucket that the server
  // totals, per-store rows, and widget labels use. `allOverdue` remains available as a raw field for
  // the custom widget builder, but the standard debtor KPI cards/tables should not silently widen.
  const debtTotal = sites.reduce((a, s) => a + (s.debtors ? s.debtors.total : 0), 0);
  const occActualRentSum = sum('occActualRent');
  t.debtorTenantPct = t.occ ? +(debtAccounts / t.occ * 100).toFixed(1) : 0;
  t.debtorRentRollPct = occActualRentSum ? +(debtTotal / occActualRentSum * 100).toFixed(1) : 0;
  t.debtorTotal = debtTotal;
  // Autobill Conversion = new autobilled customers / total new customers this month (legacy
  // tooltip, confirmed 2 Jul 2026) — mirrors lib/buildPayload.js exactly.
  const autobillNewCountSum = sum('autobillNewCount');
  const autobillNewCountExactSum = sites.reduce((a, s) => a + ((s.autobillNewCountExact ?? s.autobillNewCount) || 0), 0);
  const autobillNewTotalSum = sum('autobillNewTotal');
  t.autobillNewCount = Math.round(autobillNewCountExactSum);
  t.autobillNewCountExact = autobillNewCountExactSum;
  t.autobillNewTotal = autobillNewTotalSum;
  t.autobillPC = autobillNewTotalSum ? +(autobillNewCountExactSum / autobillNewTotalSum * 100).toFixed(1) : 0;
  t.stayDaysSum = sites.reduce((a, s) => a + ((s.stayDaysSum ?? (((s.avgStayDays > 0) && (s.occ || 0) > 0) ? s.avgStayDays * s.occ : 0)) || 0), 0);
  t.stayCount = sites.reduce((a, s) => a + ((s.stayCount ?? (((s.avgStayDays > 0) && (s.occ || 0) > 0) ? s.occ : 0)) || 0), 0);
  t.stayRentSum = sites.reduce((a, s) => a + ((s.stayRentSum ?? (((s.avgStayDays > 0) && (s.occ || 0) > 0) ? s.rent : 0)) || 0), 0);
  t.avgStayDays = t.stayCount ? Math.round(t.stayDaysSum / t.stayCount) : 0;
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
  // Discount Summary + Move-in Variance vs Standard Rate (added 9 Jul 2026) — mirrors
  // lib/buildPayload.js's aggregateTotals() exactly, so the store filter recomputes these
  // client-side the same way it does for every other rollup here.
  const discountPlans = (() => {
    const g = {};
    for (const s of sites) for (const row of (s.discountPlans || [])) {
      const o = (g[row.plan] ??= { plan: row.plan, units: 0, discount: 0 });
      o.units += row.units; o.discount += row.discount;
    }
    return Object.values(g).map((o) => ({ ...o, discount: R2(o.discount) })).sort((a, b) => b.units - a.units);
  })();
  t.discountPlans = discountPlans;
  // FIXED 21 Jul 2026 (task #396, mirrors lib/buildPayload.js's aggregateTotals() exactly) — true
  // distinct-unit count across every plan, straight-summed from each site's own already-deduped
  // discountUnitsTotal (safe cross-site, a unit belongs to exactly one site). NOT a sum of
  // discountPlans' per-plan units above — that double-counts any unit on more than one plan.
  t.discountUnitsOnPlan = sites.reduce((a, s) => a + (s.discountUnitsTotal || 0), 0);
  t.moveInVarianceCount = sum('moveInVarianceCount');
  const moveInVarianceSumTotal = sum('moveInVarianceSum');
  const moveInStdRateSumTotal = sum('moveInStdRateSum');
  t.moveInVarianceSum = moveInVarianceSumTotal;
  t.moveInStdRateSum = moveInStdRateSumTotal;
  t.moveInVarStdRatePct = moveInStdRateSumTotal ? R2(moveInVarianceSumTotal / moveInStdRateSumTotal * 100) : 0;
  t.moveInVarStdRateActualPct = t.moveInVarianceCount ? R2(t.moveInVarStdRatePct - 8.33) : null;
  const varFromStdRate = (() => {
    const g = {};
    for (const s of sites) for (const b of (s.varFromStdRate || [])) {
      const o = (g[b.bucket] ??= { bucket: b.bucket, count: 0, sortId: b.sortId });
      o.count += b.count || 0;
    }
    return Object.values(g).sort((a, b) => a.sortId - b.sortId);
  })();
  t.varFromStdRate = varFromStdRate;
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
// `invert` (added 13 Jul 2026, pre-go-live re-audit): chip()'s up=green/down=red convention assumes
// "up is good" — true for occupancy/revenue/move-ins, but backwards for metrics where a rise is BAD
// news (overdue debt, move-outs). Found via independent re-audit: Debtor Levels and the Move-outs
// count tile were showing a GREEN UP arrow when debt/move-outs INCREASED — the underlying number was
// always correct, only the colour/arrow sentiment was misleading. Pass `true` for those metrics to
// flip both the arrow and colour together (a rise still shows as a rise, just correctly flagged red).
// "Sqft Out" alongside these already got this right, coincidentally, by negating the raw values
// themselves before calling this (also flips its DISPLAYED figure negative, which is intentional
// there for the Net ft² = Sqft In + Sqft Out arithmetic) — left as-is, not touched by this change.
function deltaTick(cur, prev, kind, invert) {
  if (cur == null || prev == null || !isFinite(cur) || !isFinite(prev)) return { delta: null, dir: null };
  const diff = cur - prev;
  const eps = kind === 'money' || kind === 'moneyWhole' ? 0.005 : kind === 'count' || kind === 'ft' ? 0.5 : 0.05;
  if (Math.abs(diff) < eps) return { delta: null, dir: null };
  const abs = Math.abs(diff);
  // 'ft' ADDED 8 Jul 2026 alongside DataTable's totals-row deltas (see DELTA_KIND_FOR_TYPE below) —
  // same whole-number rounding as 'count', suffixed to match formatCell's 'ft' column type.
  const delta = kind === 'money' ? `£${abs.toFixed(2)}` : kind === 'moneyWhole' ? money(abs) : kind === 'count' ? intFmt(Math.round(abs)) : kind === 'ft' ? intFmt(Math.round(abs)) + ' ft²' : `${abs.toFixed(1)}%`;
  const rose = diff > 0;
  return { delta, dir: (invert ? !rose : rose) ? 'up' : 'down' };
}

// Maps a DataTable column's `type` to the `kind` deltaTick() expects — lets DataTable's totals-row
// "vs last month" indicators (added 8 Jul 2026, Michael: "add an arrow up or down and the net change
// by each total compared to last month at the bottom totals bar... across the dashboard and every
// widget that it is appropriate for") format each column's delta the same way the column itself is
// formatted, without every call site needing to know or repeat that mapping.
const DELTA_KIND_FOR_TYPE = { money: 'moneyWhole', money2: 'money', int: 'count', ft: 'ft' };

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
    { value: 'moveOutsYear', label: 'Move-outs (year to date, period-end snapshot)', live: (s) => s.moveOutsYear || 0, mock: () => 0 },
    { value: 'scheduledOuts', label: 'Scheduled Move-outs (stored backlog snapshot)', live: (s) => s.scheduledOuts || 0, mock: () => 0 },
    { value: 'reservations', label: 'Reservations (InquiryTracking)', live: (s) => s.reservations || 0, mock: () => 0 },
    { value: 'activeReservations', label: 'Active Reservations (stored open-reservation snapshot)', live: (s) => s.activeReservations || 0, mock: () => 0 },
  ]},
  { group: 'Debtors', items: [
    { value: 'debtors.total', label: 'Debtors: Total Overdue (£, 30+ days)', live: (s) => (s.debtors && s.debtors.total) || 0, mock: () => 0 },
    { value: 'debtors.accounts', label: 'Debtors: Accounts Overdue (30+ days)', live: (s) => (s.debtors && s.debtors.accounts) || 0, mock: () => 0 },
    { value: 'debtors.allOverdue', label: 'Debtors: All Overdue (£, any age)', live: (s) => (s.debtors && s.debtors.allOverdue) || 0, mock: () => 0 },
    { value: 'debtors.tenantPct', label: 'Debtor Levels: % Tenants', live: (s) => (s.debtors && s.debtors.tenantPct) || 0, mock: () => 0 },
    { value: 'debtors.rentRollPct', label: 'Debtor Levels: % Rent Roll', live: (s) => s.occActualRent ? ((s.debtors && s.debtors.rentRollPct) || 0) : null, mock: () => 0 },
  ]},
  { group: 'Insurance', items: [
    { value: 'insurance.insured', label: 'Insurance: Insured Units (stored book snapshot)', live: (s) => (s.insurance && s.insurance.insured) || 0, mock: () => 0 },
    { value: 'insurance.premium', label: 'Insurance: Monthly Premium (£, stored book snapshot)', live: (s) => (s.insurance && s.insurance.premium) || 0, mock: () => 0 },
    { value: 'insurance.penetration', label: 'Insurance: Penetration %', live: (s) => s.occ ? ((s.insurance && s.insurance.penetration) || 0) : null, mock: () => 0 },
    { value: 'insuranceActivity.newPolicies', label: 'Insurance: New Policy Activity (raw)', live: (s) => (s.insuranceActivity && s.insuranceActivity.newPolicies) || 0, mock: () => 0 },
    { value: 'insuranceActivity.newPremium', label: 'Insurance: New Policy Premium (£, raw)', live: (s) => (s.insuranceActivity && s.insuranceActivity.newPremium) || 0, mock: () => 0 },
    { value: 'insuranceActivity.cancellations', label: 'Insurance: Cancellations', live: (s) => (s.insuranceActivity && s.insuranceActivity.cancellations) || 0, mock: () => 0 },
  ]},
  { group: 'Enquiries', items: [
    { value: 'enquiries.total', label: 'Enquiries: Visible Total (Phone + Walk-ins + Web)', live: (s) => ((s.enquiries && ((s.enquiries.phone || 0) + (s.enquiries.walkin || 0) + ((s.enquiries.webOnly ?? s.enquiries.web) || 0))) || 0), mock: () => 0 },
    { value: 'enquiries.conversions', label: 'Enquiries: Conversions', live: (s) => (s.enquiries && s.enquiries.conversions) || 0, mock: () => 0 },
    { value: 'enquiries.phone', label: 'Enquiries: Phone', live: (s) => (s.enquiries && s.enquiries.phone) || 0, mock: () => 0 },
    { value: 'enquiries.walkin', label: 'Enquiries: Walk-ins', live: (s) => (s.enquiries && s.enquiries.walkin) || 0, mock: () => 0 },
    { value: 'enquiries.web', label: 'Enquiries: Web', live: (s) => (s.enquiries && (s.enquiries.webOnly ?? s.enquiries.web)) || 0, mock: () => 0 },
    { value: 'enquiries.webOnly', label: 'Enquiries: Web only', live: (s) => (s.enquiries && s.enquiries.webOnly) || 0, mock: () => 0 },
    { value: 'enquiries.email', label: 'Enquiries: Email only', live: (s) => (s.enquiries && s.enquiries.email) || 0, mock: () => 0 },
  ]},
  { group: 'Merchandise & Revenue', items: [
    // Keep both merchandise sources visible in the custom widget builder, but label them honestly:
    // `sales` is MerchandiseSummary's own total, while the audited portal-wide "Merchandise Sales"
    // metric reads FinancialSummary POS charges (`chargeFromFinancial`).
    { value: 'merchandise.chargeFromFinancial', label: 'Merchandise: Sales (£, Financial Summary POS)', live: (s) => (s.merchandise && s.merchandise.chargeFromFinancial) || 0, mock: () => 0 },
    { value: 'merchandise.sales', label: 'Merchandise: Sales (£, Merchandise Summary)', live: (s) => (s.merchandise && s.merchandise.sales) || 0, mock: () => 0 },
    { value: 'merchandise.cost', label: 'Merchandise: Cost (£)', live: (s) => (s.merchandise && s.merchandise.cost) || 0, mock: () => 0 },
    { value: 'merchandise.margin', label: 'Merchandise: Margin (£)', live: (s) => (s.merchandise && s.merchandise.margin) || 0, mock: () => 0 },
    { value: 'revenue.collected', label: 'Revenue: Collected (£)', live: (s) => (s.revenue && s.revenue.collected) || 0, mock: () => 0 },
    { value: 'revenue.charge', label: 'Revenue: Charged (£)', live: (s) => (s.revenue && s.revenue.charge) || 0, mock: () => 0 },
    { value: 'revenue.credit', label: 'Revenue: Credits (£)', live: (s) => (s.revenue && s.revenue.credit) || 0, mock: () => 0 },
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
    { value: 'autobillRate', label: 'Autobill Rate % (whole book snapshot)', live: (s) => s.autobillRate || 0, mock: () => 0 },
    { value: 'autobillCount', label: 'Autobill Tenants (whole book snapshot)', live: (s) => s.autobillCount || 0, mock: () => 0 },
    { value: 'tenantsCount', label: 'Total Tenants (whole book snapshot)', live: (s) => s.tenantsCount || 0, mock: () => 0 },
    { value: 'autobillNewCount', label: 'Autobill: Avg New Autobilled Tenants (selected period, est.)', live: (s) => s.autobillNewCount || 0, mock: () => 0 },
    { value: 'autobillNewTotal', label: 'Autobill: New Tenants (selected period)', live: (s) => s.autobillNewTotal || 0, mock: () => 0 },
    { value: 'avgStayDays', label: 'Average Length of Stay (days, valid lease dates only)', live: (s) => ((s.stayCount || 0) > 0 && (s.avgStayDays > 0)) ? s.avgStayDays : null, mock: () => 0 },
  ]},
];
const FIELD_INDEX = Object.fromEntries(FIELD_CATALOG.flatMap((g) => g.items).map((f) => [f.value, f]));
const fieldLabel = (v) => (FIELD_INDEX[v] ? FIELD_INDEX[v].label : v);
const fieldValue = (s, v, isLive) => {
  const f = FIELD_INDEX[v];
  if (!f) return null;
  const n = isLive ? f.live(s) : f.mock(s);
  return Number.isFinite(n) ? n : null;
};
const OP_SYMBOL = { '/': '÷', '*': '×', '+': '+', '-': '−' };
const applyOp = (a, op, b) => {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (op === '/') return b ? a / b : null;
  if (op === '*') return a * b;
  if (op === '+') return a + b;
  return a - b;
};
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
        <div key={i} title={it.label + ': ' + it.disp} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', height: '100%', justifyContent: 'flex-end' }}>
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
      {/* Values hidden 22 Jul 2026 (Michael): keep the store/location labels visible, but move the
          per-bar number to a hover tooltip instead of always rendering it above the bar. */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '7px', height: '236px', padding: '6px 2px 0', overflowX: 'auto' }}>
        {shown.map((it, i) => (
          <div key={i} title={it.label + ': ' + it.disp} style={{ flex: '0 0 auto', width: '38px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', height: '100%', justifyContent: 'flex-end' }}>
            <div style={{ width: '100%', maxWidth: '26px', height: Math.max(4, ((it.value - min) / range) * BAR_H) + 'px', borderRadius: '4px 4px 2px 2px', background: it.color || C.blue, transition: 'height .6s cubic-bezier(.2,.8,.2,1)' }} />
            <div style={{ fontSize: '10.5px', color: '#667085', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', width: '100%', writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: '66px' }}>{it.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// LineChart — EXTENDED 17 Jul 2026 (Michael: "make it so I can put my mouse on the line and it will
// show me the value of that point in time, and add the ability to overlay charts to compare, any
// chart on the portal to any chart on the portal"). Two additions, both backward-compatible with
// every existing caller (all 9 call sites across Marketing/Month-on-Month/District Manager keep
// working unchanged — `series`/`opts.labels`/`opts.zero` behave exactly as before):
//   1. Hover crosshair + tooltip. Hover state (`hoverFrac`) is LOCAL to this component (not lifted to
//      the page-level component) so mousemove only re-renders this one chart, not the whole ~3000-
//      line page component tree on every pixel of mouse movement.
//   2. Per-series `axis: 'right'` support, for the new chart-overlay feature (see ChartComparePicker
//      below): an overlaid series can carry wildly different units (£ vs ft² vs %) than the host
//      chart, so right-axis series get their OWN independent min/max scaling instead of sharing the
//      host's y-range. Per-series `xFor()` (rather than one shared `x()`) also means an overlaid
//      series with a DIFFERENT number of points than the host (e.g. overlaying a 12-point monthly
//      chart onto a ~17-point daily one) still stretches proportionally across the same width —
//      aligned by RELATIVE position, not by calendar date (this is a shape/trend comparison, not a
//      claim that point i on one line is the same moment as point i on the other) — the hover
//      tooltip makes this explicit by showing each series' OWN label (its own `labels` array if
//      supplied, else `opts.labels`) at whatever index that series lands on for the hovered position.
// Nice-number axis helper — ADDED 21 Jul 2026 (Rich/Michael follow-up: "add units to the y axis,
// finish a round number, and add ticks"). Same "nice numbers for graph labels" approach most charting
// libraries use: picks a step from {1,2,5,10} x a power of ten close to (range / target tick count),
// then floors/ceils the data bounds to that step so the axis reads in clean round increments
// (£20,000, not £18,432) instead of hugging the exact data min/max. Always folds 0 into the range —
// matches every chart in the legacy portal screenshot Michael shared, where every axis includes 0 even
// for series (occupied area, rate) whose own data never goes near zero. targetCount defaults low (4)
// rather than legacy's own ~6-9, because these charts are only 95px tall (task #354) — more ticks than
// that starts overlapping at this height; fewer, cleaner increments read better at this size.
function niceAxisTicks(dataMin, dataMax, targetCount = 4) {
  let mn = Math.min(dataMin, 0), mx = Math.max(dataMax, 0);
  if (mx === mn) mx = mn + 1;
  const range = mx - mn;
  const roughStep = range / Math.max(targetCount, 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const norm = roughStep / magnitude;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = niceNorm * magnitude;
  const min = Math.floor(mn / step) * step;
  const max = Math.ceil(mx / step) * step;
  const ticks = [];
  for (let v = min; v <= max + step / 1000; v += step) ticks.push(Math.round((v + Number.EPSILON) * 1e6) / 1e6);
  return { min, max, step, ticks };
}

function LineChart({ series, opts = {} }) {
  // opts.height — ADDED 21 Jul 2026 (Rich's portal review, task #354: "MoM: Need to make these
  // smaller like in the portal to see more in a single fold"). Was a hardcoded 150 for every
  // LineChart everywhere; now overridable per-instance so Month-on-Month's 6 stacked trend charts can
  // shrink without affecting every other page's charts (Marketing YoY, Cockpit Charting, etc.), none
  // of which Rich flagged. Default unchanged for every existing caller that doesn't pass it.
  const W = 620, H = opts.height || 150, pad = 8;
  const leftSeries = series.filter((s) => s.axis !== 'right');
  const rightSeries = series.filter((s) => s.axis === 'right');
  const leftVals = (leftSeries.length ? leftSeries : series).flatMap((s) => s.values);
  let leftMin = Math.min(...leftVals), leftMax = Math.max(...leftVals);
  if (opts.zero) leftMin = Math.min(leftMin, 0);
  if (leftMax === leftMin) leftMax = leftMin + 1;
  const rightVals = rightSeries.flatMap((s) => s.values);
  let rightMin = rightVals.length ? Math.min(...rightVals) : 0;
  let rightMax = rightVals.length ? Math.max(...rightVals) : 1;
  if (rightVals.length && opts.zero) rightMin = Math.min(rightMin, 0);
  if (rightMax === rightMin) rightMax = rightMin + 1;
  // opts.niceAxis — ADDED 21 Jul 2026: opt-in nice-round bounds + real tick marks (see
  // niceAxisTicks() above), replacing the raw data min/max used above. Opt-in, not the default, so
  // the other 8 LineChart call sites (Marketing YoY, Cockpit Charting, District Manager) keep
  // behaving exactly as before — this only changes charts that explicitly ask for it via opts.
  const leftNice = opts.niceAxis ? niceAxisTicks(leftMin, leftMax) : null;
  if (leftNice) { leftMin = leftNice.min; leftMax = leftNice.max; }
  const rightNice = (opts.niceAxis && rightVals.length) ? niceAxisTicks(rightMin, rightMax) : null;
  if (rightNice) { rightMin = rightNice.min; rightMax = rightNice.max; }
  const xFor = (s) => { const len = s.values.length; return (i) => pad + (i / Math.max(len - 1, 1)) * (W - pad * 2); };
  const y = (v, isRight) => {
    const mn = isRight ? rightMin : leftMin, mx = isRight ? rightMax : leftMax;
    return H - pad - ((v - mn) / (mx - mn)) * (H - pad * 2);
  };
  const gid = useMemo(() => 'g' + Math.random().toString(36).slice(2, 7), []);
  const [hoverFrac, setHoverFrac] = useState(null);
  const svgRef = useRef(null);
  // Generic auto-formatter for the hover tooltip AND (see axisLabelStyle below) the Y-axis tick
  // labels — plain integer once >=1000 (thousands separator, no decimals — matches this file's own
  // money()/intFmt() rounding conventions elsewhere), 2dp for anything smaller and non-integer (e.g. a
  // rate like 28.57). opts.unit/opts.unitPrefix/opts.axisDecimals — ADDED 21 Jul 2026 (Michael: "add
  // units to the y axis, finish a round number, and add ticks") — let callers get £/ft²/% shown
  // consistently in both places, and force a fixed decimal count (e.g. rates always ".00") instead of
  // the >=1000 auto-detection. unitPrefix puts the unit BEFORE the number with the sign kept outside
  // it (£ style: "-£20,000", not "£-20,000"); without it, the unit is a suffix (ft²/% style:
  // "-20,000 ft²", "45%" — no space before %). Both fully backward compatible: no caller passing these
  // new opts fields sees any change, so the other 8 LineChart call sites are unaffected.
  const fmt = opts.tooltipFormat || ((v) => {
    if (v == null || Number.isNaN(v)) return '—';
    const decimals = opts.axisDecimals;
    const abs = Math.abs(v);
    const body = decimals != null
      ? abs.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
      : (abs >= 1000 ? Math.round(abs).toLocaleString('en-GB') : (Number.isInteger(v) ? String(abs) : abs.toFixed(2)));
    const signed = (v < 0 ? '-' : '') + body;
    if (!opts.unit) return signed;
    return opts.unitPrefix ? (v < 0 ? '-' : '') + opts.unit + body : signed + (opts.unit === '%' ? '' : ' ') + opts.unit;
  });
  const idxFor = (s, frac) => Math.round(Math.max(0, Math.min(1, frac)) * Math.max(s.values.length - 1, 1));
  const handleMove = (e) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return;
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    setHoverFrac(Math.max(0, Math.min(1, (relX - pad) / (W - pad * 2))));
  };
  const first = series[0];
  const firstX = xFor(first);
  // Y-axis labels — FIXED 21 Jul 2026 (Rich's portal review, task #355: "MoM: Y axis needs to be
  // clear. Currently empty" — then Michael's follow-up: "add units to the y axis, finish a round
  // number, and add ticks"). Was just a top(max)/bottom(min) label reusing fmt() with the raw data
  // bounds; now, when opts.niceAxis is set (see niceAxisTicks() above LineChart), a full tick-per-
  // gridline axis at nice round values instead, still via the same fmt() the hover tooltip uses so
  // £/ft²/% stays consistent everywhere on the chart. Callers that don't pass opts.niceAxis keep the
  // original plain min/max labels exactly as before.
  const axisLabelStyle = { position: 'absolute', fontSize: '10px', color: '#98A2B3', whiteSpace: 'nowrap' };
  const leftGutterW = opts.niceAxis && opts.unit ? 46 : 38;
  const rightGutterW = opts.niceAxis && opts.unit ? 46 : 38;
  // fracFor — BUG FIX 21 Jul 2026 (Michael: "Application error: a client-side exception has occurred"
  // on the MoM page). This helper converts an axis VALUE to the same top-down fraction (0 = top/max,
  // 1 = bottom/min) the gridlines/labels below use — it was REFERENCED in three places (gridFracs
  // just below, and both the left/right tick-label spans further down) but never actually DEFINED
  // anywhere in this component, a plain ReferenceError as soon as any chart rendered with
  // opts.niceAxis set — i.e. every one of the 6 MoM charts, immediately, on every load. The esbuild
  // syntax check run after that change only validates parseable JS/JSX; it can't catch a reference to
  // an identifier that's never declared, since that's valid syntax that only fails at runtime. Caught
  // this time by actually reading the rendered component's full source end to end after Michael
  // reported the crash, rather than trusting the earlier syntax-only check.
  const fracFor = (v, mn, mx) => 1 - (v - mn) / (mx - mn);
  // gridFracs — top-down fractions (0 = top/max, 1 = bottom/min) for each horizontal gridline. Nice-
  // axis charts draw one per real tick (aligned with its label below); everyone else keeps the
  // original fixed quarter-lines, unrelated to any data value.
  const gridFracs = leftNice ? leftNice.ticks.map((t) => fracFor(t, leftMin, leftMax)) : [0.25, 0.5, 0.75, 1];
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 16px', marginBottom: '6px' }}>
        {series.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#667085' }}>
            <span style={{ width: '10px', height: '3px', borderRadius: '2px', background: s.color, display: 'inline-block', opacity: s.dashed ? 0.6 : 1 }} />
            {s.name}{s.axis === 'right' ? ' (right axis)' : ''}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
        <div style={{ position: 'relative', width: leftGutterW + 'px', flex: 'none', height: H + 'px' }}>
          {leftNice ? leftNice.ticks.map((t, i) => (
            <span key={i} style={{ ...axisLabelStyle, top: (fracFor(t, leftMin, leftMax) * 100) + '%', left: 0, transform: 'translateY(-50%)' }}>{fmt(t)}</span>
          )) : (<>
            <span style={{ ...axisLabelStyle, top: 0, left: 0 }}>{fmt(leftMax)}</span>
            <span style={{ ...axisLabelStyle, bottom: 0, left: 0 }}>{fmt(leftMin)}</span>
          </>)}
        </div>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none"
            onMouseMove={handleMove} onMouseLeave={() => setHoverFrac(null)}
            style={{ cursor: 'crosshair' }}
          >
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={first.color} stopOpacity={0.18} />
                <stop offset="100%" stopColor={first.color} stopOpacity={0} />
              </linearGradient>
            </defs>
            {gridFracs.map((f, i) => (
              <line key={i} x1={pad} x2={W - pad} y1={pad + f * (H - pad * 2)} y2={pad + f * (H - pad * 2)} stroke="#F2F4F7" strokeWidth={1} />
            ))}
            <path d={`M ${first.values.map((v, i) => firstX(i) + ' ' + y(v, first.axis === 'right')).join(' L ')} L ${firstX(first.values.length - 1)} ${H - pad} L ${firstX(0)} ${H - pad} Z`} fill={`url(#${gid})`} />
            {series.map((s, si) => {
              const sx = xFor(s);
              return <polyline key={si} points={s.values.map((v, i) => sx(i) + ',' + y(v, s.axis === 'right')).join(' ')} fill="none" stroke={s.color} strokeWidth={2.4} strokeDasharray={s.dashed ? '5 4' : '0'} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
            })}
            {series.filter((s) => !s.dashed).map((s, si) => {
              const sx = xFor(s);
              return <circle key={'c' + si} cx={sx(s.values.length - 1)} cy={y(s.values[s.values.length - 1], s.axis === 'right')} r={3.6} fill={s.color} stroke="#fff" strokeWidth={2} />;
            })}
            {hoverFrac != null && (
              <>
                <line x1={pad + hoverFrac * (W - pad * 2)} x2={pad + hoverFrac * (W - pad * 2)} y1={pad} y2={H - pad} stroke="#98A2B3" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
                {series.map((s, si) => {
                  const i = idxFor(s, hoverFrac);
                  return <circle key={'h' + si} cx={pad + hoverFrac * (W - pad * 2)} cy={y(s.values[i], s.axis === 'right')} r={4} fill={s.color} stroke="#fff" strokeWidth={1.5} />;
                })}
              </>
            )}
          </svg>
          {hoverFrac != null && (
            <div style={{
              position: 'absolute', top: 4,
              left: Math.min(Math.max(hoverFrac * 100, 14), 86) + '%',
              transform: 'translateX(-50%)', background: '#0C1425', color: '#E4E7EC',
              fontSize: '11px', lineHeight: 1.5, padding: '6px 9px', borderRadius: '6px',
              boxShadow: '0 4px 12px rgba(16,24,40,.2)', pointerEvents: 'none', whiteSpace: 'nowrap', zIndex: 5,
            }}>
              {series.map((s, si) => {
                const i = idxFor(s, hoverFrac);
                const lbl = (s.labels || opts.labels || [])[i];
                return (
                  <div key={si} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.color, display: 'inline-block', flex: 'none' }} />
                    <span>{lbl ? lbl + ': ' : ''}{s.name}: {fmt(s.values[i])}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '10.5px', color: '#98A2B3' }}>
            {(opts.labels || []).map((l, i) => <span key={i}>{l}</span>)}
          </div>
        </div>
        {rightSeries.length > 0 && (
          <div style={{ position: 'relative', width: rightGutterW + 'px', flex: 'none', height: H + 'px' }}>
            {rightNice ? rightNice.ticks.map((t, i) => (
              <span key={i} style={{ ...axisLabelStyle, top: (fracFor(t, rightMin, rightMax) * 100) + '%', right: 0, transform: 'translateY(-50%)' }}>{fmt(t)}</span>
            )) : (<>
              <span style={{ ...axisLabelStyle, top: 0, right: 0 }}>{fmt(rightMax)}</span>
              <span style={{ ...axisLabelStyle, bottom: 0, right: 0 }}>{fmt(rightMin)}</span>
            </>)}
          </div>
        )}
      </div>
    </div>
  );
}

// ChartComparePicker (17 Jul 2026, task #313, Michael: "add the ability to overlay charts to
// compare, any chart on the portal to any chart on the portal"): a plain native <select> (matching
// this file's no-dependency, hand-rolled-component convention — same reasoning as InfoTip/Donut/
// Gauge) listing every OTHER LineChart on the portal, grouped by page via <optgroup>. Picking one
// tells the page-level render loop (see the chartCards.map() below) to build a combined LineChart
// overlaying the chosen chart's series (tagged axis:'right') onto this one. Deliberately NOT a
// custom dropdown/portal like InfoTip's bubble — a native select needs no positioning/z-index/
// click-outside handling at all, and every chart on the portal only has single-digit LineChart
// counts today (9, across Marketing/Month-on-Month/District Manager), so a flat native list is
// plenty usable without a searchable custom widget.
function ChartComparePicker({ options, value, onChange, titles }) {
  const val = value ? `${value.page}::${value.title}` : '';
  const byPage = options.reduce((acc, o) => { (acc[o.page] ??= []).push(o); return acc; }, {});
  return (
    <select
      value={val}
      onChange={(e) => {
        const v = e.target.value;
        if (!v) { onChange(null); return; }
        const sep = v.indexOf('::');
        onChange({ page: v.slice(0, sep), title: v.slice(sep + 2) });
      }}
      title="Overlay another chart on this graph to compare"
      style={{ fontSize: '11px', color: '#475467', border: '1px solid #D5DAE1', borderRadius: '6px', padding: '3px 6px', background: '#fff', cursor: 'pointer', maxWidth: '170px' }}
    >
      <option value="">+ Compare…</option>
      {Object.entries(byPage).map(([pg, opts]) => (
        <optgroup key={pg} label={titles[pg] || pg}>
          {opts.map((o) => <option key={`${o.page}::${o.title}`} value={`${o.page}::${o.title}`}>{o.title}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

// InfoTip (13 Jul 2026, Michael: "add tool tips... use the exact report name with the exact column...
// very specific if someone needs to see how something is calculated") — a small hoverable "i" icon
// carrying the exact SiteLink report name(s), exact raw column name(s), and the exact formula
// currently implemented for whatever widget/table/tile it's attached to. Deliberately one tip per
// widget (not per individual table column) covering every sub-part in its text — adding per-column
// hover targets to DataTable would mean reworking its shared header-rendering for every table on
// every page, a much larger and riskier change than this info-bubble approach for the same result.
// No dependency — plain hover-controlled div, matching every other hand-rolled component in this
// file (Donut/Gauge/StoreBarChart/etc.), EXCEPT the bubble itself is portaled to document.body.
// FIXED 13 Jul 2026 (Michael: "tooltips appear behind other widgets"): every widget/table card
// wrapper uses `overflow: hidden` (for rounded corners — see the card divs around line ~2745/2780/
// 2802 and DataTable's own outer wrapper). The bubble used to be a plain absolutely-positioned child
// of the icon, popping open with `bottom: 100%` — since the icon sits in the card's HEADER (right at
// the card's top edge), that pop-up bubble immediately poked outside the card's own box and got
// clipped by that SAME card's `overflow: hidden`, regardless of its zIndex (clipping happens before
// stacking is even considered — a high z-index can't rescue an element clipped by an ancestor's
// overflow). Portaling the bubble to document.body (position: fixed, coordinates computed from the
// icon's getBoundingClientRect()) escapes every ancestor's overflow/stacking context entirely, which
// is the standard fix for tooltips/popovers living inside clipped card layouts.
// FIXED AGAIN 13 Jul 2026 (Michael: "I can only see the bottom edge of them"): the first portal-based
// version still tried to open UPWARD (anchored by `bottom`, growing up) whenever the icon was more
// than 180px from the top of the viewport — a guessed threshold that didn't account for how TALL a
// given tooltip's actual text is (several run 5-6 lines). For any bubble taller than the real
// available space above the icon, its top edge landed above y=0 and got clipped by the viewport
// itself (a `position: fixed` box doesn't wrap/scroll on its own) — leaving only the bottom sliver
// nearest the icon visible, exactly the symptom reported. Simplified to ALWAYS open DOWNWARD from
// the icon instead (predictable, and the card's own `overflow: hidden` no longer matters since this
// is portaled out of the card entirely) — the only remaining edge case is an icon very near the
// BOTTOM of the viewport, guarded with a computed `maxHeight` + internal scroll so a long bubble
// there scrolls instead of silently clipping.
function InfoTip({ text }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState(null);
  const iconRef = useRef(null);
  const place = () => {
    const r = iconRef.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.min(Math.max(8, r.left), vw - 328);   // keep the 320px-wide bubble on-screen horizontally
    const top = r.bottom + 6;
    const maxHeight = Math.max(80, vh - top - 12);          // leave the bubble fully inside the viewport vertically; scrolls internally if still too tall
    setPos({ left, top, maxHeight });
  };
  useEffect(() => {
    if (!show) return;
    place();
    const onMove = () => place();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => { window.removeEventListener('scroll', onMove, true); window.removeEventListener('resize', onMove); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);
  if (!text) return null;
  return (
    <span
      ref={iconRef}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', cursor: 'help', flex: 'none' }}
    >
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9.5" stroke="#98A2B3" strokeWidth="1.6" />
        <path d="M12 11.2v5.3M12 7.6v.01" stroke="#98A2B3" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      {show && pos && typeof document !== 'undefined' && createPortal(
        <div style={{
          position: 'fixed', left: pos.left, top: pos.top, width: '320px', maxWidth: '80vw',
          maxHeight: pos.maxHeight, overflowY: 'auto',
          background: '#0C1425', color: '#E4E7EC', fontSize: '11.5px', fontWeight: 400, lineHeight: 1.55,
          textTransform: 'none', letterSpacing: 'normal', whiteSpace: 'pre-line', padding: '10px 12px',
          borderRadius: '8px', boxShadow: '0 8px 20px rgba(16,24,40,.25)', zIndex: 9999, pointerEvents: 'none',
        }}>
          {text}
        </div>,
        document.body
      )}
    </span>
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
  // District Manager (15 Jul 2026, Michael: "add a little emoji... it's missing it when all other
  // pages have it") — every other nav item below is an SVG line icon, but District Manager was added
  // later (task #174/#203) and never got an entry in `defs`, so NavIcon silently rendered an empty
  // <svg> for it. Michael asked for an emoji specifically rather than a matching line icon, so this
  // is the one exception to the SVG-icon pattern — a compass, evoking "overseeing multiple sites."
  if (id === 'districtManager') return <span style={{ fontSize: '15px', lineHeight: 1 }}>🧭</span>;
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
    discountSummary: (
      <>
        <path d="M20.59 13.41 12 22 2 12l1.41-9.59L11 2l9.59 9.59a2 2 0 0 1 0 2.82Z" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
        <circle cx={8.5} cy={7.5} r={1.5} stroke="currentColor" strokeWidth={2} />
      </>
    ),
    economicOccupancy: (
      <>
        <path d="M4 19V5M4 19h16" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
        <path d="M8 15v-3M12 15V8M16 15v-5M20 15V6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      </>
    ),
    snapshot: (
      <>
        <path d="M3 12a9 9 0 1 1 18 0 9 9 0 0 1-18 0Z" stroke="currentColor" strokeWidth={2} />
        <path d="M12 7v5l3.5 2" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 2v2M22 12h-2M2 12h2" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
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
    default: return String(value);
  }
}
function thresholdColor(value) {
  if (value >= 85) return C.green;
  if (value >= 70) return C.amber;
  return C.red;
}

function normalizedReservationSqftPerReservation(sites) {
  if (!sites || !sites.length) return 70;
  const moveInArea = sites.reduce((a, s) => a + (s.moveInAreaSum || 0), 0);
  const moveIns = sites.reduce((a, s) => a + (s.moveIns || 0), 0);
  if (moveInArea > 0 && moveIns > 0) {
    const avg = moveInArea / moveIns;
    if (avg >= 25 && avg <= 400) return avg;
  }
  const reservedSqft = sites.reduce((a, s) => a + (s.reservedSqftEstimate || 0), 0);
  const activeReservations = sites.reduce((a, s) => a + (s.activeReservations || 0), 0);
  if (reservedSqft > 0 && activeReservations > 0) {
    const avg = reservedSqft / activeReservations;
    if (avg >= 25 && avg <= 400) return avg;
  }
  return 70;
}

function normalizedReservationSqftPerReservationForSite(site, fallback) {
  if (!site) return fallback;
  if ((site.moveInAreaSum || 0) > 0 && (site.moveIns || 0) > 0) {
    const avg = site.moveInAreaSum / site.moveIns;
    if (avg >= 25 && avg <= 400) return avg;
  }
  if ((site.reservedSqftEstimate || 0) > 0 && (site.activeReservations || 0) > 0) {
    const avg = site.reservedSqftEstimate / site.activeReservations;
    if (avg >= 25 && avg <= 400) return avg;
  }
  return fallback;
}
// `totals` (optional): object keyed by column key with pre-computed portfolio totals/averages for
// this table — rendered as a pinned footer row (visible on every pagination page), matching the
// legacy portal's month-labelled totals row at the bottom of every per-store table. Sums are
// summed and rates/percentages are re-derived sum-then-divide by the CALLER (same rule as
// computeTotals — never average per-site rates here). `totalsLabel` is the first-column label
// ("Total" or "Average").
function DataTable({ title, columns, rows, live, pageSize = 12, totals, totalsLabel, totalsPrev, tip, headerExtra, collapsible, wide }) {
  // REMOVED 8 Jul 2026 (Michael: "remove the scroll bar and scrolling thing on the big widgets... it
  // makes navigating annoying") — this used to cap tall tables to a fixed ~pageSize-row viewport with
  // their own internal scrollbar (6 Jul 2026 change, replacing Prev/Next pagination). In practice that
  // meant scrolling within a small nested box to see the rest of a widget's rows, which is what made
  // navigating a 29-store table annoying. Every row now renders inline at full height; the outer page
  // scrolls as one normal page, no nested scroll areas.
  const ROW_H = 41; // approx rendered row height (padding 11px*2 + line height) — unused now that nothing caps to it, kept in case a max-height cap is wanted again later
  const needsScroll = false;
  // Collapse/expand (added 15 Jul 2026, Michael: "add a button on the district manager tables to
  // collapse, and have them default to collapsed until you open fully") — opt-in via the `collapsible`
  // prop (only the District Manager page's tables pass it today) so every other page's tables are
  // unaffected. Starts collapsed; the whole header row is clickable, not just the chevron, since a
  // small target on a table this wide is easy to miss.
  const [collapsed, setCollapsed] = useState(!!collapsible);
  return (
    // gridColumn (21 Jul 2026, task #395, Michael: "narrow [tables] and put two tables next to
    // eachother") — the tables container below is now a 2-up CSS grid (like the stat-card/chart-card
    // grids elsewhere on this page), so any table NOT explicitly flagged `wide` sits in a single
    // ~480px-min column instead of stretching full width. Dense/many-column tables keep `wide` (spans
    // both columns, same full-width look as before) so nothing gets cramped into overlap or its own
    // internal scrollbar — see the `wide` flag on each out.tables.push(...) call for which is which.
    <div style={{ background: '#fff', border: '1px solid #D5DAE1', borderRadius: '16px', boxShadow: '0 1px 3px rgba(16,24,40,.07),0 2px 6px rgba(16,24,40,.08)', overflow: 'hidden', gridColumn: wide ? '1/-1' : undefined }}>
      <div
        onClick={collapsible ? () => setCollapsed((v) => !v) : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '14px 18px', borderBottom: collapsible && collapsed ? 'none' : '1px solid #F2F4F7', cursor: collapsible ? 'pointer' : undefined }}
      >
        {collapsible && (
          <span style={{ display: 'inline-flex', color: '#98A2B3', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform .15s ease', fontSize: '10px', width: 10 }}>▼</span>
        )}
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.blue }} />
        <span style={{ fontSize: '12.5px', fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: '#475467', flex: 1 }}>{title}</span>
        <InfoTip text={tip} />
        {live && <span style={{ fontSize: '9.5px', fontWeight: 700, letterSpacing: '.08em', color: '#08875D', background: '#E7F6EF', borderRadius: '5px', padding: '2px 6px' }}>LIVE</span>}
        {/* headerExtra (14 Jul 2026): optional per-table controls, e.g. the District Manager Unit
            Groups widget's own location/type filters — additive, every other table simply omits it. */}
        {headerExtra && <span onClick={(e) => e.stopPropagation()}>{headerExtra}</span>}
        {collapsible && (
          <button
            onClick={(e) => { e.stopPropagation(); setCollapsed((v) => !v); }}
            style={{ fontFamily: 'inherit', fontSize: '11.5px', fontWeight: 600, color: '#2757E8', background: '#EFF4FF', border: 'none', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer' }}
          >
            {collapsed ? 'Expand' : 'Collapse'}
          </button>
        )}
      </div>
      {(!collapsible || !collapsed) && (
      <div style={{ overflowX: 'auto', overflowY: needsScroll ? 'auto' : 'visible', maxHeight: needsScroll ? (ROW_H * pageSize) + 'px' : undefined }}>
        {/* minWidth LOWERED 560->420 (task #395) — was sized for full-width-only tables; narrow (non-
            `wide`) tables now sit in a ~480px-min grid column, and 560px would force every one of them
            into its own horizontal scrollbar (overflowX above) even though 4-column tables read fine
            at 420px. Wide tables ignore this floor entirely since their column is always much wider. */}
        <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', fontSize: '13.5px', minWidth: '420px' }}>
          <thead>
            <tr>
              {columns.map((c, ci) => (
                // AUTO-SIZE (15 Jul 2026, Michael: "auto size all the tables so the store name is not
                // so far from the data"): the first (identifying, e.g. Store/Type) column was absorbing
                // a disproportionate share of the table's width:100% stretch since it naturally has the
                // widest text content — pushing every data column far to its right. Pinning column 1 to
                // its own content width (width:1% + nowrap is the standard CSS trick for this) means the
                // remaining columns share the leftover width instead, so data sits right after the label.
                <th key={c.key} style={{ textAlign: c.align === 'right' ? 'right' : 'left', padding: '11px 18px', fontSize: '11px', fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085', background: '#F1F3F7', borderBottom: '1px solid #DDE2EA', position: needsScroll ? 'sticky' : undefined, top: needsScroll ? 0 : undefined, zIndex: 1, width: ci === 0 ? '1%' : undefined, whiteSpace: ci === 0 ? 'nowrap' : undefined }}>{c.label}</th>
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
                    <td key={c.key} style={{ padding: '11px 18px', textAlign: c.align === 'right' ? 'right' : 'left', color, fontWeight: c.key === columns[0].key ? 500 : 400, borderBottom: '1px solid #F2F4F7', fontVariantNumeric: c.type && c.type !== 'text' ? 'tabular-nums' : undefined, whiteSpace: c.key === columns[0].key ? 'nowrap' : undefined }}>{display}</td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {totals && (
            <tfoot>
              <tr>
                {columns.map((c, ci) => {
                  // "vs last month" totals-row indicator (8 Jul 2026, Michael: "add an arrow up or
                  // down and the net change by each total compared to last month at the bottom
                  // totals bar"). totalsPrev is optional and the SAME shape as totals (keyed by
                  // column key) — absent/missing per-key whenever no single-month comparison is
                  // available (multi-month range, earliest stored month, fetch failure), in which
                  // case this silently renders no chip, same graceful-degradation rule the KPI stat
                  // card arrows already follow.
                  const curVal = totals[c.key];
                  const prevVal = totalsPrev ? totalsPrev[c.key] : null;
                  const { delta, dir } = (ci !== 0 && curVal != null && prevVal != null)
                    ? deltaTick(curVal, prevVal, DELTA_KIND_FOR_TYPE[c.type])
                    : { delta: null, dir: null };
                  const { deltaStyle, deltaArrow } = chip(delta, dir);
                  return (
                    <td key={c.key} style={{ padding: '11px 18px', textAlign: c.align === 'right' ? 'right' : 'left', color: '#101828', fontWeight: 700, background: '#F1F3F7', borderTop: '2px solid #DDE2EA', fontVariantNumeric: c.type && c.type !== 'text' ? 'tabular-nums' : undefined }}>
                      {ci === 0 ? (totalsLabel || 'Total') : (curVal != null ? formatCell(c.type, curVal) : '')}
                      {delta != null && (
                        <div style={{ ...deltaStyle, justifyContent: c.align === 'right' ? 'flex-end' : 'flex-start' }}>{deltaArrow} {delta}</div>
                      )}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      )}
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

  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  // Task #202 (13 Jul 2026) — sign out via the browser Supabase client (clears the session cookie
  // middleware.js checks on every request), then hard-send to /login. router.refresh() alone isn't
  // enough here since we're navigating to a route middleware treats completely differently (public,
  // no sidebar/portal chrome at all) rather than re-rendering this same page.
  const signOut = async () => {
    setSigningOut(true);
    try { await supabaseBrowser().auth.signOut(); } catch {}
    router.push('/login');
    router.refresh();
  };
  const [page, setPage] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [panelAOpen, setPanelAOpen] = useState(false);
  const [panelBOpen, setPanelBOpen] = useState(false);
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
  // chartOverlays (17 Jul 2026, task #313): which OTHER {page,title} chart, if any, is currently
  // overlaid onto each LineChart card. Keyed by `${page}::${chart title}` of the HOST chart (not the
  // overlay) so the same overlay choice persists correctly if the user navigates away and back to a
  // page — cleared only by explicitly picking "+ Compare..." -> blank in ChartComparePicker.
  const [chartOverlays, setChartOverlays] = useState({});
  // Builder now supports 2-4 columns: builderFields[i] paired with builderOps[i-1] between
  // columns i-1 and i (evaluated left-to-right — see evalWidget() above). Defaults mirror the old
  // 2-field Rent Roll ÷ Occupied Area widget.
  const [builderFields, setBuilderFields] = useState(['rent', 'occA']);
  const [builderOps, setBuilderOps] = useState(['/']);
  const [builderName, setBuilderName] = useState('');
  const [customWidgets, setCustomWidgets] = useState([]);
  const [spin, setSpin] = useState(false);
  // lastPullAt (15 Jul 2026, Michael: "check if the auto updates are working a different way, so we
  // can be certain") — the REAL last-successful-cron timestamp (portal_payload.generated_at, written
  // by lib/pull.js only when a pull actually completes), as opposed to `updated` above which is a
  // purely cosmetic "just now" the Refresh button sets on itself regardless of whether any new data
  // came back. This gives anyone looking at the portal a genuine, at-a-glance answer to "did the
  // overnight cron actually run" with no script/dashboard-digging required.
  const [lastPullAt, setLastPullAt] = useState(null);
  const [rangePullAt, setRangePullAt] = useState(null);

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
  // Weekly/Daily Snapshot page (9 Jul 2026) — deliberately independent of the liveTotals/liveSitesRaw
  // chain above: it's a different period concept entirely (yesterday / last 7 days / quarter-to-date,
  // not the global month/range selector), backed by its own snapshot_payload row and its own lean
  // pull (lib/pullSnapshot.js / npm run pull:snapshot), refreshed on its own schedule. Fetched once on
  // mount, same as the unscoped /api/portfolio call — the store filter still applies client-side via
  // computeSnapshotTotals() below, same pattern as computeTotals().
  // 21 Jul 2026: briefly tried anchoring all three periods on TODAY instead of yesterday (Michael),
  // reverted the same day once "today" turned out to mean "frozen at whatever this morning's one
  // pull saw" rather than anything live — see lib/pullSnapshot.js's header comment.
  const [liveSnapshot, setLiveSnapshot] = useState(null); // { daily, weekly, quarterly } or null if unavailable/unconfigured
  const [snapshotPeriod, setSnapshotPeriod] = useState('daily'); // 'daily' | 'weekly' | 'quarterly' — which liveSnapshot period the Snapshot page currently shows
  // Occupancy by Floor (10 Jul 2026, roadmap #132/#139) — same independent-fetch pattern as
  // liveSnapshot above: floor is a static per-unit property, not part of the normal per-month pull
  // or the global month/range selector. Since 21 Jul 2026 this dataset can be populated either by
  // the older manual XLSX import or by the preferred live CallCenterWs.UnitsInformation import; this
  // page just reads whatever sites have been loaded into unit_floor_status so far.
  const [liveFloorOcc, setLiveFloorOcc] = useState(null); // { sites: [...codes], floors: [...], siteFloors: {code:[...]} } or null if unavailable

  // District Manager — Unit Groups Stay & Re-Lease widget-local filters (14 Jul 2026, Michael:
  // "condense... add a filter for that specific widget to filter by location and by type or both, all
  // of them or none of them"). Deliberately SEPARATE from the global store filter (selected/region
  // above) — this table can run into the thousands of (store, type, size) rows across the whole
  // portfolio, so it needs its OWN narrower location/type filter regardless of what the page-wide
  // store filter is set to. 'All' means no filtering on that axis; the two filters combine (AND), so
  // picking a location AND a type shows just that one row, either alone narrows one axis, and leaving
  // both on 'All' shows everything (unfiltered, matching today's behavior).
  const [dmGroupLocation, setDmGroupLocation] = useState('All');
  const [dmGroupType, setDmGroupType] = useState('All');
  const [dmWatchLocation, setDmWatchLocation] = useState('All');
  const [dmWatchType, setDmWatchType] = useState('All');
  // Cockpit Charting (14 Jul 2026, task #174/#207) — same independent-fetch pattern as liveSnapshot/
  // liveFloorOcc above: its own accumulating table (daily_financial_snapshot), refreshed by its own
  // daily cron (lib/pullCockpit.js). FIXED 24 Jul 2026 (deep audit): this used to stay on the
  // unscoped/default month even while the District Manager page's PERIOD selector moved the rest of
  // the page, so one widget could silently show a different month from the subtitle and neighboring
  // tables. It now follows the selected month (or the end month of a selected range), same as the
  // rest of the page.
  const [liveCockpit, setLiveCockpit] = useState(null); // { month, curve, avgDailyRate } or null if unavailable
  const [liveMomCockpit, setLiveMomCockpit] = useState(null); // selected single month's daily_financial_snapshot curve for MoM's 1M daily chart

  const reloadTimer = useRef(null);
  const rangeInitialized = useRef(false);   // snaps monthFrom/monthTo to the real latest month exactly once, the first time liveMonths loads — never overrides a month the person has since picked themselves
  const seqAIdx = useRef(0);
  const seqAReset = useRef(null);
  const seqBIdx = useRef(0);
  const seqBReset = useRef(null);
  const liveTotalsRequestId = useRef(0);
  const liveRangeRequestId = useRef(0);
  const livePrevRequestId = useRef(0);
  const latestLiveMonthKeyRef = useRef(null);
  const liveSnapshotRequestId = useRef(0);
  const liveFloorOccRequestId = useRef(0);
  const liveCockpitRequestId = useRef(0);
  const liveMomCockpitRequestId = useRef(0);
  const initialFetchStarted = useRef(false); // FIXED 7 Jul 2026 (Michael: "total units is 51 less than legacy portal... go through and double check July"): Next.js dev runs in React StrictMode, which double-invokes mount effects — the mount useEffect below was calling fetchLiveTotals() TWICE in quick succession. Both calls' async .then() callbacks saw rangeInitialized.current still false-then-true in a race: call A correctly snapped monthFrom/monthTo to the latest month (July) and fetched it, but call B's callback closed over the STALE pre-snap monthFrom/monthTo (still 17 = June) and re-fetched June AFTER call A, silently clobbering the correct July data back to June on every single page load — not just occasionally. This guard makes the second StrictMode invocation a no-op so only one fetch chain ever runs.
  const storeFilterRef = useRef(null);
  const periodFilterRef = useRef(null);

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
  const reportingAnchorDate = () => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  };
  const completedDayForMonth = (monthKey, freshnessAt) => {
    const [yy, mm] = String(monthKey || '').split('-').map(Number);
    if (!yy || !mm) return 1;
    const anchor = reportingAnchorDate();
    const monthEndDay = new Date(yy, mm, 0).getDate();
    const freshnessDate = freshnessAt ? new Date(freshnessAt) : null;
    if (!freshnessDate || Number.isNaN(freshnessDate.getTime())) {
      return yy === anchor.getFullYear() && mm === (anchor.getMonth() + 1) ? anchor.getDate() : monthEndDay;
    }
    const freshnessKey = `${freshnessDate.getFullYear()}-${String(freshnessDate.getMonth() + 1).padStart(2, '0')}`;
    if (freshnessKey > monthKey) return monthEndDay;
    if (freshnessKey < monthKey) return Math.min(anchor.getDate(), monthEndDay);
    return Math.min(monthEndDay, Math.max(1, freshnessDate.getDate() - 1));
  };
  const lastVisibleDayOfMonth = (monthKey, curve, freshnessAt) => {
    if (!monthKey) return null;
    const [yy, mm] = monthKey.split('-').map(Number);
    const anchor = reportingAnchorDate();
    const isCurrentMonth = yy === anchor.getFullYear() && mm === (anchor.getMonth() + 1);
    if (!isCurrentMonth) return new Date(yy, mm, 0).getDate();
    const fallback = completedDayForMonth(monthKey, freshnessAt);
    if (!Array.isArray(curve) || !curve.length) return fallback;
    const prefix = `${monthKey}-`;
    const maxSeen = curve.reduce((max, row) => {
      const date = String(row?.date || '');
      if (!date.startsWith(prefix)) return max;
      const day = Number(date.slice(8, 10));
      return Number.isFinite(day) ? Math.max(max, day) : max;
    }, 0);
    return maxSeen > 0 ? Math.min(maxSeen, fallback) : fallback;
  };
  const padDailyMonthCurve = (curve, monthKey, makeEmpty, freshnessAt) => {
    if (!curve || !curve.length || !monthKey) return null;
    const lastDay = lastVisibleDayOfMonth(monthKey, curve, freshnessAt);
    const byDate = new Map(curve.map((row) => [row.date, row]));
    const out = [];
    let carry = makeEmpty();
    for (let day = 1; day <= lastDay; day++) {
      const date = `${monthKey}-${String(day).padStart(2, '0')}`;
      const hit = byDate.get(date);
      if (hit) carry = hit;
      out.push(hit ? hit : { ...carry, date });
    }
    return out;
  };
  const monthDayLabels = (monthKey, curve, freshnessAt) => {
    if (!monthKey) return null;
    const lastDay = lastVisibleDayOfMonth(monthKey, curve, freshnessAt);
    return Array.from({ length: lastDay }, (_, i) => String(i + 1));
  };
  const enquiryChannelKey = (label) => String(label ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
  const enquiryWebVisible = (e) => Number(e?.webOnly ?? e?.web ?? 0) || 0;
  const enquiryTotalVisible = (e) => (Number(e?.phone) || 0) + (Number(e?.walkin) || 0) + enquiryWebVisible(e);
  const enquiryVisibleConversionBase = (e) => {
    const channels = e?.channels || {};
    const allChannelRows = Object.entries(channels);
    const visibleChannelRows = allChannelRows.filter(([label]) => {
      const k = enquiryChannelKey(label);
      return k === 'phone' || k === 'walkin' || k === 'web';
    });
    if (visibleChannelRows.length) {
      return visibleChannelRows.reduce((sum, [, row]) => sum + (Number(row?.enquiries) || 0), 0);
    }
    if (allChannelRows.length) return 0;
    return enquiryTotalVisible(e);
  };
  const enquiryVisibleConversionNumerator = (e) => {
    const channels = e?.channels || {};
    const allChannelRows = Object.entries(channels);
    const visibleChannelRows = allChannelRows.filter(([label]) => {
      const k = enquiryChannelKey(label);
      return k === 'phone' || k === 'walkin' || k === 'web';
    });
    if (visibleChannelRows.length) {
      return visibleChannelRows.reduce((sum, [, row]) => sum + (Number(row?.converted) || 0), 0);
    }
    if (allChannelRows.length) return 0;
    return Number(e?.reservationConversions) || 0;
  };

  // Global PERIOD selector (Michael, 6 Jul 2026): fetches the FULL detail for a specific from/to
  // month range from /api/portfolio's ?from/?to params (server computes this live from already-
  // stored raw data — see lib/buildPayload.js's buildPayloadRange()) and swaps liveTotals/
  // liveSitesRaw to it, so every widget on every page switches to that month/range. Deliberately
  // does NOT touch liveMonthly/liveMonths/liveHistory — those stay as the full unscoped history so
  // Month-on-Month and the selector's own dropdown options are unaffected by what's currently picked.
  const fetchLiveRange = (fromKey, toKey, onSettled) => {
    // FIXED 24 Jul 2026 (production audit): overlapping range fetches could resolve out of order and
    // let an older slower response overwrite a newer selection. This can happen if someone clicks
    // period presets quickly, changes the custom month range twice in succession, or hits Refresh
    // while a previous range load is still in flight. Guard both the main range payload and the
    // single-month "previous month" comparator payload with request ids so only the newest still-
    // intended response is allowed to write state.
    const requestId = ++liveRangeRequestId.current;
    fetch(`/api/portfolio?from=${fromKey}&to=${toKey}`)
      .then((res) => res.json())
      .then((data) => {
        if (requestId !== liveRangeRequestId.current) return;
        if (!data || !data.configured || !data.totals) {
          livePrevRequestId.current += 1;
          debugWarn(`[portal-v2] /api/portfolio?from=${fromKey}&to=${toKey} returned no data — keeping the current view.`);
          onSettled && onSettled(false);
          return;
        }
        setLiveTotals(data.totals);
        setLiveSitesRaw(Array.isArray(data.sites) ? data.sites : null);
        if (data.generated_at) setRangePullAt(data.generated_at);
        setViewLive(fromKey === toKey && toKey === latestLiveMonthKeyRef.current);
        onSettled && onSettled(true);
      })
      .catch((err) => {
        if (requestId !== liveRangeRequestId.current) return;
        livePrevRequestId.current += 1;
        debugWarn(`[portal-v2] /api/portfolio?from=${fromKey}&to=${toKey} fetch failed.`, err);
        onSettled && onSettled(false);
      });

    // "vs last month" delta ticks (8 Jul 2026, Michael: "put the ticks that show the net changes with
    // arrows... on the 29 pull one") — only meaningful for a single selected month, compared against
    // the one calendar month right before it. A multi-month range has no single obvious "previous
    // period" (previous equal-length range? previous single month?), so we deliberately don't guess —
    // livePrevSitesRaw just goes null, which makes the delta ticks disappear rather than mislead.
    if (fromKey === toKey) {
      const prevRequestId = ++livePrevRequestId.current;
      const prevKey = monthKeyOf(indexOfMonthKey(fromKey) - 1);
      fetch(`/api/portfolio?from=${prevKey}&to=${prevKey}`)
        .then((res) => res.json())
        // Checking data.totals (not just data.configured) matters here: buildPayloadRange() returns
        // configured:true with totals:null and sites:[] for an out-of-range month (e.g. fromKey is
        // already the earliest stored month) — without this, an empty-but-truthy [] would flow through
        // to computeTotals([]), which returns all-zero totals instead of null, and deltaTick() would
        // then render a fake "100% up" arrow against that phantom zero instead of correctly hiding it.
        .then((data) => {
          if (requestId !== liveRangeRequestId.current || prevRequestId !== livePrevRequestId.current) return;
          setLivePrevSitesRaw(data && data.configured && data.totals && Array.isArray(data.sites) ? data.sites : null);
        })
        .catch(() => {
          if (requestId !== liveRangeRequestId.current || prevRequestId !== livePrevRequestId.current) return;
          setLivePrevSitesRaw(null);
        });
    } else {
      livePrevRequestId.current += 1;
      setLivePrevSitesRaw(null);
    }
  };

  const fetchLiveTotals = (onInitialSettled) => {
    const requestId = ++liveTotalsRequestId.current;
    fetch('/api/portfolio')
      .then((res) => res.json())
      .then((data) => {
        if (requestId !== liveTotalsRequestId.current) return;
        if (!data || !data.configured || !data.totals) {
          debugWarn('[portal-v2] /api/portfolio not configured — dashboard KPI row + rate table + trend charts are using mock data.');
          // FIXED 14 Jul 2026 (Michael: District Manager page shows real data for a few seconds then
          // reverts to blank/mock right after first switching to it) — this branch used to
          // unconditionally null liveTotals/liveSitesRaw/etc, but the 8 Jul fix above already stopped
          // this function's SUCCESS path from setting liveTotals/liveSitesRaw (fetchLiveRange owns
          // those exclusively now) without updating this failure path to match. reload() re-runs this
          // whole fetch on every nav click; if this one unscoped call (used only for month-list
          // metadata) has any transient hiccup — a Vercel cold start right after a fresh deploy is the
          // likely trigger — it wiped out perfectly good data that fetchLiveRange had already loaded,
          // and nothing re-fetched it afterward since fetchLiveRange is only called from the success
          // branch below. Only clear state when there's no previous good load to protect (the real
          // first load); otherwise keep showing what's already there, same "keep current view" rule
          // fetchLiveRange's own error handling already follows.
          if (!rangeInitialized.current) {
            setLiveTotals(null);
            setLiveSitesRaw(null);
            setLiveMonthly(null);
            setLiveMonths(null);
            setLiveHistory(null);
          }
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
        latestLiveMonthKeyRef.current = (months && months.length) ? months[months.length - 1] : null;
        setLiveHistory(Array.isArray(data.history) ? data.history : null);
        // Real cron timestamp, not the client-side "just now" — see lastPullAt's declaration above.
        if (data.generated_at) setLastPullAt(data.generated_at);

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
            // FIXED 24 Jul 2026 (deep audit): initial mount still never fetched cockpit data for the
            // real latest stored month. That meant the District Manager page could open for the first
            // time with mock/empty cockpit content until the user manually refreshed, navigated again,
            // or changed the month selector — reload() and the later monthTo effect both fetched it,
            // but the very first successful app boot did not. Pull the latest month's cockpit payload
            // at the same moment we snap the main selector to that same month so the first District
            // Manager visit starts from the correct persisted daily curve too.
            fetchCockpit(latestKey, setLiveCockpit, liveCockpitRequestId);
            fetchCockpit(latestKey, setLiveMomCockpit, liveMomCockpitRequestId);
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
        if (requestId !== liveTotalsRequestId.current) return;
        debugWarn('[portal-v2] /api/portfolio fetch failed — dashboard KPI row + rate table + trend charts are using mock data.', err);
        // Same fix as the "not configured" branch above: don't erase already-loaded good data just
        // because THIS particular re-fetch (triggered by reload() on a nav click) failed.
        if (!rangeInitialized.current) {
          setLiveTotals(null);
          setLiveSitesRaw(null);
          setLiveMonthly(null);
          setLiveMonths(null);
          setLiveHistory(null);
        }
        onInitialSettled && onInitialSettled();
      });
  };

  // Weekly/Daily Snapshot fetch — reads the persisted snapshot_payload row (no SiteLink calls; those
  // only happen in lib/pullSnapshot.js). Independent of fetchLiveTotals/fetchLiveRange above, so a
  // slow or failed snapshot fetch never blocks or flickers the rest of the app.
  const fetchSnapshot = () => {
    const requestId = ++liveSnapshotRequestId.current;
    return fetch('/api/snapshot')
      .then((res) => res.json())
      .then((data) => {
        if (requestId !== liveSnapshotRequestId.current) return;
        const hasAnySnapshotPeriod = !!(data && (data.daily || data.weekly || data.quarterly));
        if (!data || !data.configured || !hasAnySnapshotPeriod) {
          debugWarn('[portal-v2] /api/snapshot not configured yet — run `npm run pull:snapshot`. Snapshot page will show mock data.');
          setLiveSnapshot((prev) => prev);
          return;
        }
        setLiveSnapshot({ daily: data.daily || null, weekly: data.weekly || null, quarterly: data.quarterly || null, generatedAt: data.generated_at });
      })
      // FIXED 24 Jul 2026 (deep audit): this independent fetch path still used the old "clear to
      // null on any transient failure" behavior that was already removed from fetchLiveTotals on 14
      // Jul. Result: a one-off cold start / network hiccup while switching back to the Snapshot page
      // could wipe a perfectly good previously-loaded snapshot payload and make the page fall back to
      // mock data, even though nothing was actually wrong with the stored snapshot row. Keep the last
      // good payload on failure/not-configured responses; first load still naturally shows mock/null
      // because prev is null in that case.
      .catch((err) => {
        if (requestId !== liveSnapshotRequestId.current) return;
        debugWarn('[portal-v2] /api/snapshot fetch failed.', err);
        setLiveSnapshot((prev) => prev);
      });
  };

  // Occupancy by Floor fetch — reads unit_floor_status via /api/floor-occupancy (no live SiteLink
  // calls here; that table is written by the import scripts). Independent of every other live
  // fetch, same reasoning as fetchSnapshot above.
  const fetchFloorOccupancy = () => {
    const requestId = ++liveFloorOccRequestId.current;
    return fetch('/api/floor-occupancy')
      .then((res) => res.json())
      .then((data) => {
        if (requestId !== liveFloorOccRequestId.current) return;
        if (!data || !data.configured || !data.floors || !data.floors.length) {
          debugWarn('[portal-v2] /api/floor-occupancy not configured yet — run `npm run pull:floor-occupancy`. Occupancy by Floor will show mock data.');
          setLiveFloorOcc((prev) => prev);
          return;
        }
        setLiveFloorOcc({ sites: data.sites, floors: data.floors, siteFloors: data.site_floors || {}, generatedAt: data.generated_at });
      })
      .catch((err) => {
        if (requestId !== liveFloorOccRequestId.current) return;
        debugWarn('[portal-v2] /api/floor-occupancy fetch failed.', err);
        setLiveFloorOcc((prev) => prev);
      });
  };

  // Cockpit Charting fetch — reads the accumulated daily_financial_snapshot rows via /api/cockpit (no
  // live SiteLink calls; those only happen in lib/pullCockpit.js). Independent of every other live
  // fetch, same reasoning as fetchSnapshot/fetchFloorOccupancy above.
  const fetchCockpit = (monthKey, setter = setLiveCockpit, requestRef = liveCockpitRequestId) => {
    const requestId = ++requestRef.current;
    const qs = monthKey ? `?month=${monthKey}` : '';
    return fetch(`/api/cockpit${qs}`)
      .then((res) => res.json())
      .then((data) => {
        if (requestId !== requestRef.current) return;
        if (!data || !data.configured) {
          debugWarn(`[portal-v2] /api/cockpit${qs} not configured yet — run \`npm run pull:cockpit\`. Cockpit Charting will show mock data.`);
          setter((prev) => {
            if (data && data.month === monthKey) {
              return { month: data.month, curve: [], avgDailyRate: data.avgDailyRate == null ? null : Number(data.avgDailyRate), generatedAt: data.generated_at || null };
            }
            return monthKey && prev?.month !== monthKey ? null : prev;
          });
          return;
        }
        setter({ month: data.month, curve: data.curve, avgDailyRate: data.avgDailyRate, generatedAt: data.generated_at || null });
      })
      .catch((err) => {
        if (requestId !== requestRef.current) return;
        debugWarn(`[portal-v2] /api/cockpit${qs} fetch failed.`, err);
        setter((prev) => (monthKey && prev?.month !== monthKey ? null : prev));
      });
  };

  // Silent background refresh for already-open tabs. The cron jobs can write fresh snapshot/portal/
  // cockpit/floor payloads overnight while someone leaves the portal open, but before this the UI only
  // re-read them on the first mount, an explicit Refresh click, or certain navigation actions. Result:
  // a tab left open until the next morning could keep showing yesterday's stored payload even though
  // the 6-8am cron chain had already succeeded. Re-read every persisted source quietly on visibility
  // return and on a short timer so the portal can "live on its own" without needing a manual reload.
  const silentRefreshAll = () => {
    const pending = [
      new Promise((resolve) => fetchLiveTotals(resolve)),
      fetchSnapshot(),
      fetchFloorOccupancy(),
      fetchCockpit(monthKeyOf(monthTo)),
      monthFrom === monthTo
        ? fetchCockpit(monthKeyOf(monthTo), setLiveMomCockpit, liveMomCockpitRequestId)
        : Promise.resolve((liveMomCockpitRequestId.current += 1, setLiveMomCockpit(null))),
    ];
    return Promise.allSettled(pending);
  };

  // reload(): mirrors the original DCLogic method — toggles the loading skeleton
  // and is invoked by every state-changing action (nav clicks, filters, refresh).
  // Hooked here to also re-fetch live totals so a manual refresh pulls fresh data.
  // FIXED 8 Jul 2026 (Michael: "annoying pulos for a few seconds for 28 stores in the financials
  // then goes to the appropriate 29 stores") — this is the SAME bug class already fixed on the mount
  // effect earlier today (a FIXED timer racing a variable-latency network fetch), just never carried
  // over to this function. reload() fires on every nav click (including switching to the Financials
  // tab), which re-fetches live totals — but the hardcoded 550ms timer used to hide the loading
  // skeleton regardless of whether that fetch had actually finished, so on any slower round trip the
  // skeleton cleared early and exposed whatever liveSitesRaw held at that instant (stale/partial)
  // until the real response landed a moment later and replaced it. Now waits for the fetch's own
  // completion callback; the timer is only a safety net so the skeleton can't get stuck forever.
  // FIXED 16 Jul 2026 (deep re-audit: caught a brief flash of fabricated RAW_STORES site names —
  // Reading, Guildford, Basildon, etc. — on the Dashboard's Portfolio Occupancy / Rates per ft²
  // tables). Root cause: this is the SAME bug class as the two fixes already documented above (a
  // fixed timer racing a variable-latency network fetch), but in the safety net itself rather than
  // the main path — the 4000ms safety timer was tight enough that a slow round trip (a Vercel
  // serverless cold start on the first hit after idle, plus this function's own sequential
  // unscoped-then-ranged /api/portfolio fetch chain) could still exceed it. When that happens the
  // timer fires setLoading(false) BEFORE fetchLiveTotals's own completion callback, so the skeleton
  // clears while liveSitesRaw is still null — exposing exactly one render's worth of the mock
  // RAW_STORES fallback until the real fetch lands a moment later and replaces it. Bumped from
  // 4000ms to 15000ms so the safety net only fires for a genuinely hung/failed fetch, not a slow-
  // but-still-completing one; the real completion callback (which always fires first in the normal
  // case) is unaffected.
  const reload = () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    setLoading(true);
    reloadTimer.current = setTimeout(() => { setLoading(false); setSpin(false); }, 15000);
    // FIXED 24 Jul 2026 (deep audit): after the initial mount, the generic reload path only
    // re-fetched /api/portfolio. Snapshot/Floor/Cockpit each have their OWN persisted payloads and
    // fetch helpers, but none of them were called here — so clicking Refresh, or navigating away and
    // back via the sidebar (which also calls reload()), could leave those pages showing whatever was
    // loaded the very first time the app mounted, even if newer stored data existed by then. Refresh
    // all independent persisted datasets here too so every page reflects the latest available stored
    // payload after a manual refresh or a navigation-triggered reload.
    silentRefreshAll().finally(() => {
      clearTimeout(reloadTimer.current);
      setLoading(false);
      setSpin(false);
    });
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
    // BUMPED 16 Jul 2026 (deep re-audit, mock-data-flash bug): 4000ms was still tight enough that a
    // slow round trip (Vercel cold start + this function's sequential unscoped-then-ranged fetch
    // chain) could exceed it, firing this "safety" timer BEFORE the real completion callback and
    // clearing the skeleton onto one render's worth of RAW_STORES mock data (fabricated site names)
    // until the real fetch landed a moment later. See reload()'s matching fix above for the full
    // writeup — same bug class, same fix (generous timer, only a true last resort now).
    const safety = setTimeout(() => setLoading(false), 15000);
    if (!initialFetchStarted.current) {
      initialFetchStarted.current = true;
      fetchLiveTotals(() => { clearTimeout(safety); setLoading(false); });
      fetchSnapshot();
      fetchFloorOccupancy();
    }
    // FIXED 21 Jul 2026 (Rich's portal review, task #362): "Clicking off dropdown on store selection
    // to move on. Not having to click back on drop down." Root cause: this listener is registered on
    // `document` with capture:true, so it always fires BEFORE the store/period popup panels' own
    // onClick={(e) => e.stopPropagation()} even gets a chance to run — capture phase runs document
    // first, then walks DOWN to the target, so a capture listener on `document` itself can never be
    // stopped by a descendant's stopPropagation() call. The `closest('select')` check was only ever
    // an exception for the period popup's native FROM/TO <select> dropdowns — the store popup's own
    // checkboxes, "Select all"/"Clear" buttons, and region chips were never covered, so EVERY click
    // inside the store popup (most commonly: ticking a store checkbox) closed the whole popup
    // immediately, forcing a re-open to pick a second store. Fixed properly by checking against the
    // popup panels themselves (data-popover-panel, added to both panel divs below) instead of relying
    // on stopPropagation()/capture-order — closes on any REAL outside click, stays open for anything
    // inside either panel.
    const onDocClick = (e) => {
      const target = e.target;
      const insideStore = storeFilterRef.current && target instanceof Node && storeFilterRef.current.contains(target);
      const insidePeriod = periodFilterRef.current && target instanceof Node && periodFilterRef.current.contains(target);
      if (!insideStore) setStorePopOpen(false);
      if (!insidePeriod) setPeriodPopOpen(false);
    };
    document.addEventListener('click', onDocClick, true);

    const SEQ_A = [98, 101, 110, 115, 111, 110];
    const SEQ_B = [109, 97, 114, 116, 121];
    const onKeySeq = (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
      const code = e.key.length === 1 ? e.key.toLowerCase().charCodeAt(0) : -1;

      clearTimeout(seqAReset.current);
      seqAReset.current = setTimeout(() => { seqAIdx.current = 0; }, 2000);
      if (code === SEQ_A[seqAIdx.current]) {
        seqAIdx.current++;
        if (seqAIdx.current === SEQ_A.length) {
          seqAIdx.current = 0;
          clearTimeout(seqAReset.current);
          setPanelAOpen(true);
        }
      } else {
        seqAIdx.current = code === SEQ_A[0] ? 1 : 0;
      }

      clearTimeout(seqBReset.current);
      seqBReset.current = setTimeout(() => { seqBIdx.current = 0; }, 2000);
      if (code === SEQ_B[seqBIdx.current]) {
        seqBIdx.current++;
        if (seqBIdx.current === SEQ_B.length) {
          seqBIdx.current = 0;
          clearTimeout(seqBReset.current);
          setPanelBOpen(true);
        }
      } else {
        seqBIdx.current = code === SEQ_B[0] ? 1 : 0;
      }
    };
    document.addEventListener('keydown', onKeySeq);

    return () => {
      clearTimeout(safety);
      clearTimeout(seqAReset.current);
      clearTimeout(seqBReset.current);
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKeySeq);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!rangeInitialized.current) return;
    fetchCockpit(monthKeyOf(monthTo), setLiveCockpit, liveCockpitRequestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthTo]);

  useEffect(() => {
    if (!rangeInitialized.current) return;
    if (monthFrom !== monthTo) {
      liveMomCockpitRequestId.current += 1;
      setLiveMomCockpit(null);
      return;
    }
    // FIXED 24 Jul 2026 (deep audit): this single-month MoM cockpit fetch could still resolve after
    // the user had already switched to a different month or to a multi-month range, and then write
    // the old month's daily cockpit curve back into state. fetchCockpit() now accepts a request-ref
    // guard, so just route this path through that same "latest request wins" mechanism.
    fetchCockpit(monthKeyOf(monthTo), setLiveMomCockpit, liveMomCockpitRequestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthFrom, monthTo]);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const run = () => {
      if (disposed || inFlight) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      inFlight = true;
      silentRefreshAll().finally(() => { inFlight = false; });
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    const interval = setInterval(run, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', run);
    return () => {
      disposed = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', run);
    };
  }, [monthFrom, monthTo]);

  useEffect(() => {
    const scopedLiveNames = liveSitesRaw ? liveSitesRaw.map((s) => s.name) : [];
    const snapshotNames = (liveSnapshot && liveSnapshot[snapshotPeriod] && Array.isArray(liveSnapshot[snapshotPeriod].sites))
      ? liveSnapshot[snapshotPeriod].sites.map((s) => s.store || SITE_NAME_BY_CODE[s.code] || (liveSitesRaw || []).find((site) => site.code === s.code)?.name || s.code)
      : [];
    const validNames = page === 'snapshot'
      ? (snapshotNames.length ? snapshotNames : scopedLiveNames)
      : scopedLiveNames;
    const liveNames = new Set(validNames);
    if (!liveNames.size) return;
    setSelected((prev) => {
      let changed = false;
      const next = {};
      for (const [name, on] of Object.entries(prev)) {
        if (!on) continue;
        if (liveNames.has(name)) next[name] = true;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [liveSitesRaw, liveSnapshot, snapshotPeriod, page]);

  useEffect(() => {
    setDmGroupLocation('All');
    setDmGroupType('All');
    setDmWatchLocation('All');
    setDmWatchType('All');
  }, [page, monthFrom, monthTo, selected, snapshotPeriod]);

  // Live mode currently has no authoritative region metadata, so any stale mock-only region choice
  // must be neutralized consistently everywhere, including mock fallback scaling paths.
  const effectiveRegion = liveSitesRaw ? 'All' : region;
  const filteredStores = () => {
    const selectedMockNames = new Set(
      Object.entries(selected)
        .filter(([, on]) => on)
        .map(([name]) => name)
        .filter((name) => STORES.some((s) => s.name === name))
    );
    return STORES.filter((s) => {
      if (effectiveRegion !== 'All' && s.region !== effectiveRegion) return false;
      if (selectedMockNames.size && !selectedMockNames.has(s.name)) return false;
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
    const lo = Math.min(fromIdx, toIdx);
    const hi = Math.max(fromIdx, toIdx);
    const prevFrom = monthFrom;
    const prevTo = monthTo;
    const prevPeriod = period;
    setMonthFrom(lo); setMonthTo(hi);
    // FIXED 8 Jul 2026 — same fixed-timer-races-the-real-fetch bug as reload() above, same fix:
    // wait for fetchLiveRange's own completion callback instead of guessing 550ms is always enough.
    // BUMPED 24 Jul 2026 (deep audit): this path still had the older 4000ms safety cutoff even after
    // reload()/initial load had already been widened to 15000ms for the same cold-start race. A slow
    // range fetch could therefore still clear the skeleton early and expose stale/mock content mid-
    // transition, just by changing the month range instead of clicking Refresh. Keep the same generous
    // "last resort only" timeout here too so all three entry points behave consistently.
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    setLoading(true);
    reloadTimer.current = setTimeout(() => setLoading(false), 15000);
    fetchLiveRange(monthKeyOf(lo), monthKeyOf(hi), (ok) => {
      if (!ok) {
        setMonthFrom(prevFrom);
        setMonthTo(prevTo);
        setPeriod(prevPeriod);
      }
      clearTimeout(reloadTimer.current);
      setLoading(false);
    });
  };

  const applyPreset = (pl) => {
    // Anchor "latest" to the real most-recent stored month once live data has loaded, instead of the
    // hardcoded index-17 (Jun 2026) placeholder — otherwise every preset would silently stop
    // updating once actual data moves past whatever month was hardcoded here.
    const latestIdx = liveMonths && liveMonths.length ? indexOfMonthKey(liveMonths[liveMonths.length - 1]) : 17;
    const earliestIdx = liveMonths && liveMonths.length ? indexOfMonthKey(liveMonths[0]) : 0;
    let from = latestIdx, to = latestIdx;
    // ADDED 15 Jul 2026 (Michael: "add a button for prior month as well") — a single-month view of the
    // month immediately before the current latest one, same idea as '1M' but shifted back by one. Both
    // from AND to move back a month here (every other preset keeps `to` pinned at latestIdx).
    if (pl === 'PM') { from = latestIdx - 1; to = latestIdx - 1; }
    else if (pl === '3M') from = latestIdx - 2;
    else if (pl === '6M') from = latestIdx - 5;
    // FIXED 14 Jul 2026 (Michael: "12m should be for example june 25 to jun26") — was latestIdx - 11,
    // a plain trailing-12-calendar-months window (e.g. Jul'25-Jun'26 if latest=Jun'26: 12 points, but
    // starting a month AFTER last year's same month). Michael wants the FROM month to land on the
    // exact same calendar month one year before TO — i.e. latestIdx - 12 (e.g. Jun'25-Jun'26). YTD and
    // All were checked against his examples too (Jan-of-this-year -> latest, and earliest stored month
    // -> latest, respectively) and are already correct — no change needed there.
    else if (pl === '12M') from = latestIdx - 12;
    else if (pl === 'YTD') from = indexOfMonthKey(`${monthKeyOf(latestIdx).slice(0, 4)}-01`);
    else if (pl === 'All') from = earliestIdx;
    setPeriod(pl);
    selectRange(Math.max(earliestIdx, from), Math.max(earliestIdx, to));
  };

  // ---------- page content (verbatim port of buildPage()) ----------
  // FIXED 10 Jul 2026 (pre-go-live audit): now takes an explicit `page` parameter instead of reading
  // the `page` state via closure. Every internal `page === 'xxx'` check below is unaffected (same
  // identifier, now sourced from the parameter) — this is what lets withPage() below actually build a
  // DIFFERENT page's data on demand for the "export everything" flow, instead of always silently
  // returning whatever the currently-viewed page happens to be.
  function buildPage(page) {
    const fs = filteredStores();
    const f = factor();
    const scopedLiveNames = liveSitesRaw ? liveSitesRaw.map((s) => s.name) : [];
    const scopedSnapshotNames = (liveSnapshot && liveSnapshot[snapshotPeriod] && Array.isArray(liveSnapshot[snapshotPeriod].sites))
      ? liveSnapshot[snapshotPeriod].sites.map((s) => s.store || SITE_NAME_BY_CODE[s.code] || (liveSitesRaw || []).find((site) => site.code === s.code)?.name || s.code)
      : [];
    const pageSelectedNames = new Set(
      Object.entries(selected)
        .filter(([, on]) => on)
        .map(([name]) => name)
        .filter((name) => (page === 'snapshot'
          ? (scopedSnapshotNames.length ? scopedSnapshotNames : scopedLiveNames).includes(name)
          : scopedLiveNames.includes(name)))
    );
    const pageHasSelectedStores = pageSelectedNames.size > 0;
    const liveScopeLabel = (!pageHasSelectedStores || !liveSitesRaw)
      ? 'All Stores'
      : pageSelectedNames.size === 1
        ? [...pageSelectedNames][0]
        : `${pageSelectedNames.size} Stores`;
    // Store-name filter for live data: same `selected` toggle state the mock filteredStores() above
    // uses. Region filtering can't apply to live sites (no region field on real data — same gap
    // flagged throughout this file), so only the individual store checkboxes take effect here; "All"
    // (nothing individually selected) shows every live site, matching filteredStores()'s own rule.
    // This shadows the `liveSitesRaw` state for the rest of buildPage() — every widget below that
    // reads `liveSites` automatically gets the filtered view without being edited individually.
    const liveSites = (() => {
      if (!liveSitesRaw) return null;
      if (!pageHasSelectedStores) return liveSitesRaw;
      return liveSitesRaw.filter((s) => pageSelectedNames.has(s.name));
    })();
    // Same store-filter mirror as liveSites, applied to last month's snapshot — feeds the "vs last
    // month" delta ticks below so they respect the store filter exactly like every other live number.
    const livePrevSites = (() => {
      if (!livePrevSitesRaw) return null;
      if (!pageHasSelectedStores) return livePrevSitesRaw;
      const filtered = livePrevSitesRaw.filter((s) => pageSelectedNames.has(s.name));
      // FIXED 24 Jul 2026 (task #433, found via a sweep for the same silent-wrong-data bug class as
      // the MoM/Cockpit chart fixes above): a store filter matching NO rows in last month's snapshot
      // (e.g. a just-onboarded site like Edmonton/Abingdon that didn't exist yet last month) used to
      // return `[]` here — truthy, so every "vs last month" delta consumer below (prevT/kpiPrevT/
      // finTPrev/ancTPrev/umTPrev/enqSumPrev and the raw prevMoveIns/etc. reduces — all of them only
      // null-check livePrevSites, never its .length) ran computeTotals([]) and got back a fully
      // populated ALL-ZERO object, not null. That sailed straight past deltaTick()'s `prev == null`
      // guard and rendered a fabricated (often large) "up" delta arrow — current value vs a phantom
      // "0 last month" — instead of no-arrow/N/A. The exact same hazard was already caught and fixed
      // once upstream, at the raw-fetch step (see this file's own comment a few hundred lines up), but
      // was never patched here at the per-store name-filter step. Now returns null in that case too, so
      // every downstream `livePrevSites ? X : null` consumer correctly shows no delta instead of a fake
      // one. Every direct (non-ternary-guarded) livePrevSites.reduce()/.find() call site elsewhere in
      // this file was checked and confirmed to sit inside a block already conditioned on this same
      // ternary-guarded variable (or a value derived from it), so this can't newly throw on null.
      return filtered.length ? filtered : null;
    })();
    // Same store-checkbox rule as liveSites above, but applied to the independent floor-occupancy
    // dataset. Region-only filtering still can't narrow live floor data (no region field in the
    // imported rows), so only explicit store selections affect this widget; no selection = all
    // imported sites.
    const liveFloorFloors = (() => {
      if (!liveFloorOcc) return null;
      if (!pageHasSelectedStores) return liveFloorOcc.floors;
      if (!liveSitesRaw) return liveFloorOcc.floors;
      const selectedCodes = new Set(
        liveSitesRaw
          .filter((s) => pageSelectedNames.has(s.name))
          .map((s) => s.code)
      );
      if (!selectedCodes.size) return [];
      const byFloor = new Map();
      for (const code of selectedCodes) {
        for (const row of (liveFloorOcc.siteFloors?.[code] || [])) {
          const bucket = byFloor.get(row.floor) || { floor: row.floor, totalUnits: 0, occupiedUnits: 0, totalArea: 0, occupiedArea: 0 };
          bucket.totalUnits += row.totalUnits || 0;
          bucket.occupiedUnits += row.occupiedUnits || 0;
          bucket.totalArea += row.totalArea || 0;
          bucket.occupiedArea += row.occupiedArea || 0;
          byFloor.set(row.floor, bucket);
        }
      }
      return [...byFloor.values()]
        .sort((a, b) => a.floor - b.floor)
        .map((b) => ({ ...b, occPct: b.totalUnits ? +((b.occupiedUnits / b.totalUnits) * 100).toFixed(1) : 0 }));
    })();
    const agg = fs.reduce((a, s) => {
      a.occupied += s.occupied; a.total += s.total; a.area += s.area; a.rentRoll += s.rentRoll; a.claW += s.occupied * s.claPct;
      return a;
    }, { occupied: 0, total: 0, area: 0, rentRoll: 0, claW: 0 });
    const occPct = agg.total ? (agg.occupied / agg.total) * 100 : 0;
    const claPct = agg.occupied ? agg.claW / agg.occupied : 0;
    const gross = occPct ? agg.rentRoll / (occPct / 100) : 0;
    const out = { kpiRow: [], statCards: [], tables: [], chartCards: [], unitMix: [] };
    const econDetailData = (() => {
      if (!liveSites || !liveSites.length) return null;
      const normType = (t) => (t || '').trim().toLowerCase().replace(/\s+/g, '');
      const TYPE_LABELS = {
        driveup: 'Drive Up', enterprise: 'Enterprise', indoorselfstorage: 'Indoor Self Storage',
        mailbox: 'Mailbox', office: 'Office', parking: 'Parking', valueunit: 'Value Unit',
        selfstorage: 'Self Storage', bulk: 'Bulk', miscellaneousst: 'Miscellaneous St',
        locker: 'Locker', tradecounter: 'Trade Counter',
      };
      const sumByType = (sites) => {
        const g = {};
        for (const s of sites) for (const row of (s.occByTypeSize || [])) {
          const k = normType(row.type);
          if (!k) continue;
          const Z = (g[k] ??= { type: TYPE_LABELS[k] || (row.type || '').trim(), occArea: 0, totalArea: 0, grossPotential: 0, actualOccupied: 0 });
          Z.occArea += row.occArea || 0;
          Z.totalArea += row.totalArea || 0;
          Z.grossPotential += row.grossPotential || 0;
          Z.actualOccupied += row.actualOccupied || 0;
        }
        return g;
      };
      const metricsFor = (g) => {
        if (!g) return null;
        const askingRaw = g.totalArea ? (g.grossPotential / g.totalArea * 12) : 0;
        const inPlaceRaw = g.occArea ? (g.actualOccupied / g.occArea * 12) : 0;
        const discountPct = askingRaw ? +((inPlaceRaw - askingRaw) / askingRaw * 100).toFixed(1) : 0;
        const occPct = g.totalArea ? +(g.occArea / g.totalArea * 100).toFixed(1) : 0;
        const econPct = g.grossPotential ? +(g.actualOccupied / g.grossPotential * 100).toFixed(1) : 0;
        return { askingPSF: R2(askingRaw), inPlacePSF: R2(inPlaceRaw), discountPct, occPct, econPct };
      };
      const momStr = (cur, prev, isMoney) => {
        if (cur == null || prev == null || !isFinite(cur) || !isFinite(prev)) return '–';
        const diff = cur - prev;
        if (Math.abs(diff) < (isMoney ? 0.005 : 0.05)) return '–';
        const arrow = diff > 0 ? '↑' : '↓';
        return arrow + Math.abs(diff).toFixed(isMoney ? 2 : 1) + (isMoney ? '' : 'pt');
      };
      const cur = sumByType(liveSites);
      const prev = livePrevSites ? sumByType(livePrevSites) : {};
      const rows = Object.keys(cur).sort((a, b) => a.localeCompare(b)).map((k) => {
        const m = metricsFor(cur[k]), p = metricsFor(prev[k]);
        return {
          type: cur[k].type,
          askingPSF: m.askingPSF, askingMoM: p ? momStr(m.askingPSF, p.askingPSF, true) : '–',
          inPlacePSF: m.inPlacePSF, inPlaceMoM: p ? momStr(m.inPlacePSF, p.inPlacePSF, true) : '–',
          discountPct: m.discountPct, discountMoM: p ? momStr(m.discountPct, p.discountPct, false) : '–',
          occPct: m.occPct, occMoM: p ? momStr(m.occPct, p.occPct, false) : '–',
          econPct: m.econPct, econMoM: p ? momStr(m.econPct, p.econPct, false) : '–',
        };
      });
      const scope = (() => {
        if (!pageHasSelectedStores) return 'All stores, blended';
        return liveSites.length === 1 ? liveSites[0].name : liveSites.length + ' stores, blended';
      })();
      return { rows, scope };
    })();

    if (page === 'dashboard') {
      // --- KPI row: live-wired for these 6 tiles only ---
      let useLive = false;
      let t = null;
      if (liveSites) {
        useLive = true;
        t = computeTotals(liveSites);   // recomputed client-side so the store filter applies (see computeTotals)
      } else {
        // Fallback mock path (also used if /api/portfolio is unconfigured or errors).
        debugWarn('[portal-v2] KPI row rendering with mock RAW_STORES data (no live totals available).');
      }
      // FIXED 21 Jul 2026 (full portal audit): all three tiles below carry a "vs last month" sub-
      // label but hardcoded delta:null,dir:null on the live path — kpiPrevT/prevT was computed further
      // down (for the Portfolio Occupancy table) but never wired back up to these tiles, so they never
      // actually showed a MoM arrow despite claiming to. Moved that computation up here so both this
      // block and the Portfolio Occupancy table below can share one `prevT` (removed the duplicate
      // declaration that used to sit lower down).
      const prevT = livePrevSites ? computeTotals(livePrevSites) : null;
      const claYoy = (() => {
        if (!liveMonthly) return null;
        const curMonthKey = monthKeyOf(monthTo);
        const yoyMonthKey = monthKeyOf(monthTo - 12);
        const currentRows = liveMonthly[curMonthKey];
        const yoyRows = liveMonthly[yoyMonthKey];
        if (!currentRows || !yoyRows) return null;
        const filterRows = (rows) => {
          if (!pageSelectedNames.size) return rows;
          return rows.filter((r) => wanted.has(r.name));
        };
        const wanted = pageSelectedNames;
        const currentTotals = computeTotals(filterRows(currentRows));
        const yoyTotals = computeTotals(filterRows(yoyRows));
        if (currentTotals.claPC == null || yoyTotals.claPC == null) return null;
        const diff = +(currentTotals.claPC - yoyTotals.claPC).toFixed(1);
        return { label: 'YoY', value: (diff > 0 ? '+' : '') + diff.toFixed(1) + 'pt', positive: diff >= 0 };
      })();

      if (useLive) {
        // Defensive fallback to 0 per-field: a stale/incomplete portal_payload row (e.g. written
        // before claA/claPC existed) should degrade a single tile to "0.0%" rather than crash the
        // whole dashboard. If you see 0s here, re-run `npm run pull` to refresh portal_payload.
        const claPC = t.claPC ?? 0;
        out.kpiRow = [
          { label: 'Occupancy (% of CLA)', value: claPC.toFixed(1) + '%', ...deltaTick(t.claPC, prevT && prevT.claPC), sub: 'vs last month', extraChip: claYoy, tip: 'Report: OccupancyStatistics.\nFields: OccupiedArea (falls back to Area × Occupied if not present), Area, TotalUnits, Unrentable.\nCalculation: % of CLA = Σ OccupiedArea ÷ Σ(Area × (TotalUnits − Unrentable)) × 100.\nNote: OccupiedArea is SiteLink\'s own average of day 10, day 20, and month-end — not a live figure.' },
          { label: 'Occupied Units', value: intFmt(t.occ ?? 0), ...deltaTick(t.occ, prevT && prevT.occ, 'count'), sub: 'of ' + intFmt(t.tot ?? 0), tip: 'Report: OccupancyStatistics.\nFields: Occupied, TotalUnits.\nCalculation: Σ Occupied units of Σ TotalUnits, across the current store scope.' },
          // ADDED 16 Jul 2026 (Michael: "total occupancy in sqft, it is a column in the occupancy
          // statistics excel"). t.occA already existed — computeTotals() sums each site's occA
          // (occupied area) — and was already used internally for the "Rented Area by Store" chart's
          // average bar; this just surfaces that same portfolio total as its own headline tile.
          { label: 'Total Occupancy (sqft)', value: intFmt(t.occA ?? 0) + ' ft²', ...deltaTick(t.occA, prevT && prevT.occA, 'ft'), sub: 'vs last month', tip: 'Report: OccupancyStatistics.\nFields: OccupiedArea (falls back to Area × Occupied if not present).\nCalculation: Σ OccupiedArea, across the current store scope.\nNote: OccupiedArea is SiteLink\'s own average of day 10, day 20, and month-end — not a live figure.' },
        ];
      } else {
        out.kpiRow = [
          { label: 'Occupancy (% of CLA)', value: occPct.toFixed(1) + '%', delta: '1.4%', dir: 'up', sub: 'vs last month' },
          { label: 'Occupied Units', value: intFmt(agg.occupied), delta: '42', dir: 'up', sub: 'of ' + intFmt(agg.total) },
          { label: 'Total Occupancy (sqft)', value: intFmt(agg.area) + ' ft²', delta: '820', dir: 'up', sub: 'vs last month' },
        ];
      }

      // Portfolio Occupancy: live-wired from /api/portfolio's per-site array. occPct <- occPC,
      // claPct <- areaPC (per-site "% of CLA": occA/claA when claA is known, else occA/totA — same
      // rule used everywhere else, e.g. recordFor() in lib/buildPayload.js), rentRoll <- rent.
      // Same "no region field on live data" gap as the Rates per ft² table below.
      const liveOccRows = liveSites ? liveSites.map((s) => ({
        name: s.name, occupied: s.occ || 0, total: s.tot || 0, occPct: s.occPC || 0, claPct: s.areaPC || 0, rentRoll: s.rent || 0,
      })) : null;
      if (!liveOccRows) debugWarn('[portal-v2] Portfolio Occupancy table rendering with mock RAW_STORES data (no live sites available).');
      // "vs last month" totals-row deltas (8 Jul 2026) — reuses the SAME `prevT` computed above for
      // the KPI row's own arrows (one computeTotals(livePrevSites) call shared by both, instead of a
      // second copy here). null whenever no single-month comparison is available (matches
      // livePrevSites' own null cases: multi-month range, earliest stored month, fetch failure) — the
      // totals row then simply shows no chip, same as an individual KPI card with no arrow.
      // Totals row (legacy parity: the legacy portal's per-store tables all end with a portfolio
      // totals row). Sums for units/rent; occupancy %s re-derived sum-then-divide (t.occPC/t.claPC
      // from computeTotals on the live path — never an average of per-site %s).
      const occTotals = (liveOccRows && t)
        ? { occupied: t.occ ?? 0, total: t.tot ?? 0, occPct: t.occPC ?? 0, claPct: t.claPC ?? 0, rentRoll: t.rent ?? 0 }
        : { occupied: agg.occupied, total: agg.total, occPct: +occPct.toFixed(1), claPct: +claPct.toFixed(1), rentRoll: agg.rentRoll };
      const occTotalsPrev = (liveOccRows && prevT)
        ? { occupied: prevT.occ ?? 0, total: prevT.tot ?? 0, occPct: prevT.occPC ?? 0, claPct: prevT.claPC ?? 0, rentRoll: prevT.rent ?? 0 }
        : null;
      out.tables = [{
        // NARROWED 21 Jul 2026 (Michael: "go across every page and make all the big tables narrower
        // and put them next to each other") — sits 2-up with Rates per ft² below, same page.
        title: `Portfolio Occupancy (${liveScopeLabel})`, live: !!liveOccRows, pageSize: 12, totals: occTotals, totalsPrev: occTotalsPrev, totalsLabel: 'Total',
        tip: 'Reports: OccupancyStatistics (Occupied, Total, % of CLA); RentRoll (Rent Roll).\nFields: Occupied, TotalUnits (OccupancyStatistics); dcRent, bRented (RentRoll).\nCalculation: Occupancy % = Occupied ÷ TotalUnits × 100. % of CLA = occupied area ÷ CLA area × 100. Rent Roll = Σ dcRent on occupied (bRented) units.',
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
      const liveRateRows = liveSites ? liveSites.map((s) => ({
        name: s.name, selfRate: s.ssRate || 0, totalRate: s.rate || 0, realRate: s.ssReal || 0, realTotal: s.realRate || 0, area: s.occA || 0,
      })) : null;
      const mockRateRows = fs.map((s) => ({ name: s.name, region: s.region, selfRate: s.rate, totalRate: +(s.rate * 0.957).toFixed(2), realRate: +(s.rate * 0.925).toFixed(2), realTotal: +(s.rate * 0.89).toFixed(2), area: s.area }));
      if (!liveRateRows) debugWarn('[portal-v2] Rates per ft² table rendering with mock RAW_STORES data (no live sites available).');
      // Portfolio row (legacy parity: the legacy Rate/Real Rate tables end with one portfolio-wide
      // summary row). Live path reuses computeTotals' weighted rates (Σ rent ÷ Σ area × 12 — never a
      // mean of per-site rates); mock path weights each mock rate by that store's occupied area.
      const rateTotals = (liveRateRows && t)
        ? { selfRate: t.ssRate ?? 0, totalRate: t.rate ?? 0, realRate: t.ssReal ?? 0, realTotal: t.realRate ?? 0, area: t.occA ?? 0 }
        : (() => {
            const aSum = mockRateRows.reduce((a, r) => a + r.area, 0);
            const w = (k) => aSum ? R2(mockRateRows.reduce((a, r) => a + r[k] * r.area, 0) / aSum) : 0;
            return { selfRate: w('selfRate'), totalRate: w('totalRate'), realRate: w('realRate'), realTotal: w('realTotal'), area: aSum };
          })();
      const rateTotalsPrev = (liveRateRows && prevT)
        ? { selfRate: prevT.ssRate ?? 0, totalRate: prevT.rate ?? 0, realRate: prevT.ssReal ?? 0, realTotal: prevT.realRate ?? 0, area: prevT.occA ?? 0 }
        : null;
      out.tables.push({
        // NARROWED 21 Jul 2026 (same request as Portfolio Occupancy above) — pairs with it 2-up.
        title: `Rates per ft² (${liveScopeLabel})`, live: !!liveRateRows, pageSize: 12, totals: rateTotals, totalsPrev: rateTotalsPrev, totalsLabel: 'Portfolio',
        // UPDATED 24 Jul 2026 (task #308/#404/#405) — Total Real Rate's formula changed (Rent-only
        // True Revenue ÷ rewound-or-frozen occupied area, see lib/buildPayload.js's recordFor()
        // comment), now validated at avg|gap| £0.51 / 24 of 25 sites within £1 of Michael's
        // legacy-confirmed June targets — removed the stale "known open accuracy item" note below,
        // which described the old all-charge-types/total-area formula's ~26% avg error, not this one.
        // UPDATED AGAIN same day (task #308 follow-up, Michael: "self storage is the same rate but
        // you [need to] put a filter on the type to only be self storage not everything") — Self
        // Storage Real Rate now ALSO uses a Rent-only numerator ÷ occupied-area denominator, scoped
        // to Self Storage specifically, but its denominator is NOT rewound like Total's (move_ins_outs
        // doesn't split moves by unit type) — always the frozen month-end Self Storage occupied area.
        // Not yet independently re-validated against a legacy Self Storage Real Rate target.
        tip: 'Reports: RentRoll (Rate, and Real Rate fallback); True Revenue custom report (Real Rate, "Rent" charge line only); OccupancyStatistics/MoveInsAndMoveOuts (Total Real Rate\'s occupied-area denominator).\nFields: dcStdRate, dcRent, Area/Area1, bRented (RentRoll); TruePeriod filtered to ChargeDesc="Rent" and, for Self Storage Real Rate, also to UnitType="Self Storage" (True Revenue); MoveIn/MoveOut, MovedInArea/MovedOutArea (MoveInsAndMoveOuts).\nCalculation: Rate = Σ dcStdRate ÷ Σ area × 12. Total Real Rate = Σ Rent-only TruePeriod ÷ Σ occupied area × 12, where the occupied area is today\'s live figure "rewound" back to month-end using MoveInsAndMoveOuts\' dated move events (falls back to the month-end snapshot\'s own occupied area at any site whose total unit count has shifted more than ordinary noise since — e.g. a genuine property expansion). Self Storage Real Rate = Σ Self-Storage-only Rent-only TruePeriod ÷ Σ Self Storage occupied area × 12 — same numerator logic, but always the frozen (not rewound) occupied area. Both fall back further to Σ dcRent ÷ Σ area × 12 if True Revenue wasn\'t pulled.',
        columns: liveRateRows ? [
          { key: 'name', label: 'Location', type: 'text' },
          { key: 'selfRate', label: 'Self Storage Rate', type: 'money2', align: 'right' }, { key: 'totalRate', label: 'Total Rate', type: 'money2', align: 'right' },
          { key: 'realRate', label: 'Self Storage Real Rate', type: 'money2', align: 'right' }, { key: 'realTotal', label: 'Total Real Rate', type: 'money2', align: 'right' },
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
            return { title: 'Move-ins & Move-outs', tip: 'Reports: ManagementSummary (Move-ins, Move-outs); MoveInsAndMoveOuts (Net ft²).\nFields: sDesc rows matching "Move In"/"Move Out", iMCount (ManagementSummary); MovedInArea, MovedOutArea (MoveInsAndMoveOuts).\nCalculation: Move-ins/Move-outs = counts within the selected period. Net ft² = Σ MovedInArea − Σ MovedOutArea, across the current store scope.', tiles: [
              { value: intFmt(sum('moveIns')), label: 'Move-ins', delta: null, dir: null },
              { value: intFmt(sum('moveOuts')), label: 'Move-outs', delta: null, dir: null },
              { value: intFmt(sum('netArea')) + ' ft²', label: 'Net ft²', delta: null, dir: null },
            ] };
          }
          debugWarn('[portal-v2] Move-ins & Move-outs stat card rendering with mock RAW_STORES data (no live sites available).');
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
            const enquiryRows = liveSites.map((s) => s.enquiries || {});
            return { title: 'Enquiries', tip: 'Report: InquiryTracking.\nFields: sInquiryType (Phone/WalkIn/Web/EMail), dPlaced.\nCalculation: Phone/Walk-ins/Web = counts where sInquiryType matches and dPlaced falls in the selected period. The displayed Web and Total counts follow the live legacy Marketing page and exclude EMail; EMail remains available separately in the widget builder.', tiles: [
              { value: intFmt(sum('phone')), label: 'Phone', delta: null, dir: null },
              { value: intFmt(sum('walkin')), label: 'Walk-ins', delta: null, dir: null },
              { value: intFmt(enquiryRows.reduce((a, e) => a + enquiryWebVisible(e), 0)), label: 'Web', delta: null, dir: null },
              { value: intFmt(enquiryRows.reduce((a, e) => a + enquiryTotalVisible(e), 0)), label: 'Visible Total', delta: null, dir: null },
            ] };
          }
          debugWarn('[portal-v2] Enquiries stat card rendering with mock RAW_STORES data (no live sites available).');
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
      if (!liveAreaBars) debugWarn('[portal-v2] Dashboard comparison charts rendering with mock RAW_STORES data (no live sites available).');

      // Pinned summary bar on each comparison chart (legacy parity — the legacy portal's bar
      // charts end with one summary bar). Area = mean per store; rate/% = the portfolio's
      // weighted figure (computeTotals) on the live path, mean of mock values otherwise.
      const nBars = liveSites ? liveSites.length : fs.length;
      const avgArea = (liveAreaBars && t) ? (nBars ? (t.occA ?? 0) / nBars : 0) : (fs.length ? agg.area / fs.length : 0);
      const avgSSRate = (liveRateBars && t) ? (t.ssRate ?? 0) : (fs.length ? fs.reduce((a, s) => a + s.rate, 0) / fs.length : 0);
      const avgCla = (liveClaBars && t) ? (t.claPC ?? 0) : (fs.length ? fs.reduce((a, s) => a + s.claPct, 0) / fs.length : 0);
      out.chartCards = [
        { title: 'Rented Area by Store', tip: 'Report: OccupancyStatistics.\nFields: OccupiedArea (falls back to Area × Occupied if not present).\nCalculation: Occupied area = Σ OccupiedArea per store. Average bar = mean across shown stores.\nNote: OccupiedArea is SiteLink\'s own average of day 10, day 20, and month-end — not a live figure.', el: <StoreBarChart items={liveAreaBars || fs.map((s) => ({ label: s.name, value: s.area, disp: intFmt(s.area) + ' ft²', color: C.blue }))} opts={{ average: { label: 'Average', value: avgArea, disp: intFmt(avgArea) + ' ft²' } }} /> },
        { title: 'Self Storage Rate per ft² by Store', tip: 'Report: RentRoll.\nFields: dcStdRate, Area/Area1, bRented, sTypeName ("Indoor Self Storage").\nCalculation: Rate = Σ dcStdRate ÷ Σ area × 12, occupied self storage units only, per store. Portfolio bar = weighted across the shown store scope, not a simple mean.', el: <StoreBarChart items={liveRateBars || fs.map((s) => ({ label: s.name, value: s.rate, disp: '£' + s.rate.toFixed(2), color: C.teal }))} opts={{ average: { label: 'Portfolio', value: avgSSRate, disp: '£' + avgSSRate.toFixed(2) } }} /> },
        { title: 'Occupied Area % of CLA by Store', tip: 'Report: OccupancyStatistics.\nFields: Area, Occupied, TotalUnits, Unrentable.\nCalculation: % of CLA = occupied area ÷ CLA area × 100, per store. Portfolio bar = weighted across the shown store scope.', el: <StoreBarChart items={liveClaBars || fs.map((s) => ({ label: s.name, value: s.claPct, disp: s.claPct.toFixed(1) + '%', color: thresholdColorFor(s.claPct) }))} opts={{ zero: false, average: { label: 'Portfolio', value: avgCla, disp: avgCla.toFixed(1) + '%' } }} /> },
      ];
      customWidgets.forEach((w) => {
        // Custom widgets: use live per-site records when a live pull is loaded (evalWidget's `live`
        // accessors), falling back to mock RAW_STORES data (evalWidget's `mock` accessors, which
        // only cover the original 6 fields) only when no live data is available yet.
        const isLive = !!liveSites;
        const src = liveSites || fs;
        const items = src
          .map((s) => ({ site: s, value: evalWidget(s, w, isLive) }))
          .filter((row) => Number.isFinite(row.value))
          .sort((a, b) => b.value - a.value)
          .slice(0, 8)
          .map(({ site, value }) => ({ label: site.name, value: Math.abs(value), disp: (Math.round(value * 100) / 100).toLocaleString('en-GB'), color: C.teal }));
        out.chartCards.push({
          title: w.name,
          el: items.length
            ? <HBars items={items} />
            : <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>This custom widget cannot be derived for the selected store scope.</div>,
          removable: true,
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
      if (!kpiT) debugWarn('[portal-v2] KPIs stat cards rendering with mock RAW_STORES data (no live totals available).');
      // "vs last month" comparator for the delta ticks below (8 Jul 2026) — null when unavailable
      // (earliest stored month, a multi-month range selected, or the prev-month fetch failed), in
      // which case deltaTick() falls back to {delta: null, dir: null} and the tile shows no arrow.
      const kpiPrevT = livePrevSites ? computeTotals(livePrevSites) : null;
      out.statCards = [
        // 3rd tile ADDED 16 Jul 2026 (Michael: "total occupancy in sqft, it is a column in the
        // occupancy statistics excel"). kpiT.occA already existed (computeTotals() sums each site's
        // occA) — just surfacing the same portfolio total already used elsewhere (e.g. Dashboard's
        // "Rented Area by Store" chart average) as its own tile here too. 'ft' deltaTick kind added
        // 8 Jul 2026 alongside DataTable's totals-row deltas, so "vs last month" works the same way
        // as every other tile on this card.
        kpiT
          ? { title: 'Total Store Occupancy', live: true, tip: 'Reports: OccupancyStatistics (Occupancy, Total Occupancy sqft); RentRoll (Rate per ft²).\nFields: Occupied, TotalUnits, OccupiedArea (falls back to Area × Occupied) (OccupancyStatistics); dcStdRate, Area/Area1, bRented (RentRoll).\nCalculation: Occupancy = Occupied ÷ TotalUnits × 100. Rate = Σ dcStdRate ÷ Σ area × 12. Total Occupancy (sqft) = Σ OccupiedArea.\nNote: OccupiedArea is SiteLink\'s own average of day 10, day 20, and month-end — not a live figure.', tiles: [{ value: (kpiT.occPC ?? 0).toFixed(1) + '%', label: 'Occupancy', ...deltaTick(kpiT.occPC, kpiPrevT && kpiPrevT.occPC, 'pct') }, { value: '£' + (kpiT.rate ?? 0).toFixed(2), label: 'Rate per ft²', ...deltaTick(kpiT.rate, kpiPrevT && kpiPrevT.rate, 'money') }, { value: intFmt(kpiT.occA ?? 0) + ' ft²', label: 'Total Occupancy (sqft)', ...deltaTick(kpiT.occA, kpiPrevT && kpiPrevT.occA, 'ft') }], note: intFmt(kpiT.occ ?? 0) + ' / ' + intFmt(kpiT.tot ?? 0) + ' units occupied' }
          : { title: 'Total Store Occupancy', tiles: [{ value: occPct.toFixed(1) + '%', label: 'Occupancy', delta: '2%', dir: 'up' }, { value: '£28.46', label: 'Rate per ft²', delta: '£0.22', dir: 'up' }, { value: intFmt(agg.area) + ' ft²', label: 'Total Occupancy (sqft)', delta: '820', dir: 'up' }], note: intFmt(agg.occupied) + ' / ' + intFmt(agg.total) + ' units occupied' },
        kpiT
          // Renamed 8 Jul 2026 (Michael: KPI page widget name, "Indoor Self Storage" -> "Self Storage")
          // -- display label only, no key/logic reads this string (grep-confirmed).
          // Tile relabelled "Occupancy" -> "Unit Occupancy %" 21 Jul 2026 (Michael: "move the unit
          // occupancy to the self storage widget to save space") — this tile's underlying figure
          // (ssOccPC = Occupied ÷ TotalUnits, self storage units only) already WAS unit occupancy;
          // it just wasn't labelled as such. Made that explicit instead of adding a duplicate tile,
          // and dropped the Unit Occupancy % column from the Occupancy by Store table below to match.
          ? { title: 'Self Storage', live: true, tip: 'Reports: OccupancyStatistics (Occupancy); RentRoll (Rate per ft²) — self storage units only.\nFields: Occupied, TotalUnits (OccupancyStatistics); dcStdRate, Area/Area1, sTypeName="Indoor Self Storage" (RentRoll).\nCalculation: Unit Occupancy % = Occupied ÷ TotalUnits × 100. Rate = Σ dcStdRate ÷ Σ area × 12. Both scoped to self storage units only.', tiles: [{ value: (kpiT.ssOccPC ?? 0).toFixed(1) + '%', label: 'Unit Occupancy %', ...deltaTick(kpiT.ssOccPC, kpiPrevT && kpiPrevT.ssOccPC, 'pct') }, { value: '£' + (kpiT.ssRate ?? 0).toFixed(2), label: 'Rate per ft²', ...deltaTick(kpiT.ssRate, kpiPrevT && kpiPrevT.ssRate, 'money') }] }
          : { title: 'Self Storage', tiles: [{ value: (occPct + 1.1).toFixed(1) + '%', label: 'Unit Occupancy %', delta: '2%', dir: 'up' }, { value: '£29.74', label: 'Rate per ft²', delta: '£0.20', dir: 'up' }] },
        kpiT
          ? { title: 'Offices Occupancy', live: true, tip: 'Reports: OccupancyStatistics (Occupancy); RentRoll (rent, Area) — offices only.\nFields: Occupied, TotalUnits (OccupancyStatistics); dcRent, Area/Area1, sTypeName="Offices" (RentRoll).\nCalculation: Occupancy = Occupied ÷ TotalUnits × 100. Rate = Σ dcRent ÷ Σ area × 12 (actual rent, not standard rate, unlike Total/Self Storage).', tiles: [{ value: (kpiT.officesOccPC ?? 0).toFixed(1) + '%', label: 'Occupancy', ...deltaTick(kpiT.officesOccPC, kpiPrevT && kpiPrevT.officesOccPC, 'pct') }, { value: '£' + (kpiT.officesRate ?? 0).toFixed(2), label: 'Rate per ft²', ...deltaTick(kpiT.officesRate, kpiPrevT && kpiPrevT.officesRate, 'money') }] }
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
          ? { title: 'Scheduled Reservations vs Scheduled Move-outs', live: true, tip: 'Reports: ReservationList (Reservations); ScheduledMoveOuts (Move-outs).\nFields: dCancelled, dNeeded, QTCancellationTypeID, QTRentalTypeID (ReservationList); dSchedOut (ScheduledMoveOuts).\nCalculation: Reservations = active waiting-list rows (not cancelled, dNeeded in the future, QTRentalTypeID = 2). Move-outs = ScheduledMoveOuts rows with dSchedOut not yet passed (excludes stale past-dated rows SiteLink never clears from this report).\nFreshness: latest stored snapshot from the most recent portal pull, not the selected period and not real-time intraday.', tiles: [
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
        // UnitTypeID spans multiple sizes, so an exact figure isn't possible).
        // VERIFIED 21 Jul 2026 (Rich's portal review, task #359 — "Is reserved sqft working?"): this
        // comment used to also claim it inherited the ~3x active-reservations overcount (Task #25)
        // — that was stale/incorrect (lib/reportMap.js's per-type breakdown was always built from the
        // same already-QTRentalTypeID-filtered rows as the main reservations count, so it was never
        // actually 3x over). What WAS genuinely missing and has now been fixed: the smaller
        // already-converted-to-tenant exclusion that Reserved Scheduled Sqft's sibling
        // "activeReservations" already had (~51 rows portfolio-wide) — both now share the same
        // occupied-tenant-ID filter (see lib/buildPayload.js). Still an ESTIMATE by construction
        // (unit-type-average area, not each reservation's real unit size) — treat as directional.
        // CHANGED 6 Jul 2026 (Michael): dropped the old hardcoded "always show June + July side by
        // side" two-tile design — now that the global PERIOD selector actually works, this widget
        // just shows ONE tile for whatever month/range is currently selected, same as every other
        // widget (was previously force-showing July even while viewing June, which made no sense).
        (() => {
          if (liveSites && liveSites.length) {
            const sqft = liveSites.reduce((a, s) => a + (s.reservedSqftEstimate || 0), 0);
            return { title: 'Reserved Scheduled Sqft', live: true, tip: 'Reports: ReservationList (reservation count by UnitTypeID); RentRoll (avg area per UnitTypeID).\nFields: UnitTypeID (ReservationList); Area/Area1, UnitTypeID (RentRoll).\nCalculation: Σ active reservations per UnitTypeID × that type\'s average unit area across the site. Estimate only — ReservationList has no area field of its own.\nFreshness: latest stored reservation snapshot from the most recent portal pull, not a real-time intraday figure.', tiles: [{ value: intFmt(sqft) + ' ft²', label: 'Reserved', delta: null, dir: null }] };
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
          ? { title: 'Debtor Levels', live: true, tip: `Reports: PastDueBalances (overdue units/£, 30+ days); OccupancyStatistics (occupied units/rent).\nFields: ChargeBalance (or RentBal+LateFeeBal+POSBal+OtherChargesBal+TaxesBal), DaysLate (PastDueBalances); Occupied, ActualOccupied (OccupancyStatistics).\nCalculation: % Tenants = overdue (30+ day) accounts ÷ occupied units × 100. % Rent Roll = overdue (30+ day) £ ÷ occupied rent × 100. Lower is better.${kpiT.occ ? '' : '\nNote: no occupied units exist in the selected store scope, so % Tenants cannot be derived.'}${kpiT.occActualRent ? '' : '\nNote: no occupied rent exists in the selected store scope, so % Rent Roll cannot be derived.'}`, tiles: [{ value: kpiT.occ ? (kpiT.debtorTenantPct ?? 0).toFixed(1) + '%' : 'N/A', label: '% Tenants', ...(kpiT.occ ? deltaTick(kpiT.debtorTenantPct, kpiPrevT && kpiPrevT.debtorTenantPct, 'pct', true) : { delta: null, dir: null }) }, { value: kpiT.occActualRent ? (kpiT.debtorRentRollPct ?? 0).toFixed(1) + '%' : 'N/A', label: '% Rent Roll', ...(kpiT.occActualRent ? deltaTick(kpiT.debtorRentRollPct, kpiPrevT && kpiPrevT.debtorRentRollPct, 'pct', true) : { delta: null, dir: null }) }, { value: money(kpiT.debtorTotal ?? 0), label: 'Total', ...deltaTick(kpiT.debtorTotal, kpiPrevT && kpiPrevT.debtorTotal, 'moneyWhole', true) }] }
          : { title: 'Debtor Levels', tiles: [{ value: '1.8%', label: '% Tenants', delta: '0%', dir: null }, { value: '0.6%', label: '% Rent Roll', delta: '0%', dir: null }, { value: money(2790 * f), label: 'Total', delta: '£93', dir: 'up' }] },
        // Move-ins & Move-outs: was present on the legacy portal's KPIs page (missed when this page
        // was first built — it only existed on the Dashboard page here) — same live-data pattern as
        // the Dashboard's copy: sum each site's moveIns/moveOuts/netArea (ManagementSummary).
        (() => {
          // REFORMATTED 21 Jul 2026 (Rich's portal review, task #358): "Format the below so the sqft
          // is in one line. Have net move ins where sqft in is. Then sqft below in a line." Was 5
          // tiles in one wrapped row mixing counts (Move-ins/Move-outs) with areas (Sqft In/Sqft Out/
          // Net ft²). Now: line 1 = counts only (Move-ins, Move-outs, Net Move-ins — a NEW count tile,
          // moveIns − moveOuts, taking the position Sqft In used to sit in); line 2 = all three sqft
          // figures together. The forced line break is a `rowBreak` tile (flex-basis:100% spacer, see
          // the statCards render loop) rather than relying on the flex-wrap happening to land there.
          // COMPACT 21 Jul 2026 (Michael, same day: "the move in move outs widget is so much longer
          // than other widgets... find a way to condense this"). Two forced rows of tiles makes this
          // card roughly 2x the height of its 1-row neighbours (Debtor Levels, Move-In Rental Rate) —
          // and since the stat-card grid stretches every card in a row to match its tallest member,
          // that height difference was showing up as empty white space INSIDE those shorter neighbour
          // cards too, not just as this card being tall. Two changes: `compact: true` below shrinks
          // this card's own tile text/spacing (see statCards mapping + render loop) rather than
          // dropping any of the 6 datapoints Michael has asked for across tasks #135/#358; the stat-
          // card grid container also switched to alignItems:'start' so cards no longer stretch to
          // match a taller row-mate — fixes the same "ugly white space" for any other uneven row too.
          if (!liveSites) return { title: 'Move-ins & Move-outs', compact: true, tiles: [
              { value: intFmt(112 * f), label: 'Move-ins', delta: '12', dir: 'up' }, { value: intFmt(86 * f), label: 'Move-outs', delta: '1', dir: 'up' },
              { value: '+' + intFmt(26 * f), label: 'Net Move-ins', delta: '11', dir: 'up' },
              { rowBreak: true },
              { value: intFmt(1980 * f) + ' ft²', label: 'Sqft In', delta: '140', dir: 'up' }, { value: intFmt(-60 * f) + ' ft²', label: 'Sqft Out', delta: '20', dir: 'down' },
              { value: intFmt(2040 * f) + ' ft²', label: 'Net ft²', delta: '160', dir: 'up' },
            ] };
          const moveIns = liveSites.reduce((a, s) => a + (s.moveIns || 0), 0);
          const moveOuts = liveSites.reduce((a, s) => a + (s.moveOuts || 0), 0);
          const netArea = liveSites.reduce((a, s) => a + (s.netArea || 0), 0);
          // Gross Sqft In/Out — ADDED 9 Jul 2026 (Michael: "we currently display just a net sqft
          // number, can you get gross sqft in and out please. Take from move in & out report"). Both
          // were already computed by reportMap.js's move_ins_outs parser (moved_in_area/moved_out_area)
          // but only the NET (in minus out) ever made it past lib/buildPayload.js. moveOutArea shown as
          // a negative number (ft² that LEFT occupied stock) so it reads consistently with Net ft² =
          // Sqft In + Sqft Out.
          const moveInArea = liveSites.reduce((a, s) => a + (s.moveInAreaSum || 0), 0);
          const moveOutArea = liveSites.reduce((a, s) => a + (s.moveOutAreaSum || 0), 0);
          // "vs last month" comparators — same livePrevSites source as kpiPrevT above, just reduced
          // directly since this card isn't computeTotals()-derived.
          const prevMoveIns = livePrevSites ? livePrevSites.reduce((a, s) => a + (s.moveIns || 0), 0) : null;
          const prevMoveOuts = livePrevSites ? livePrevSites.reduce((a, s) => a + (s.moveOuts || 0), 0) : null;
          const prevNetArea = livePrevSites ? livePrevSites.reduce((a, s) => a + (s.netArea || 0), 0) : null;
          const prevMoveInArea = livePrevSites ? livePrevSites.reduce((a, s) => a + (s.moveInAreaSum || 0), 0) : null;
          const prevMoveOutArea = livePrevSites ? livePrevSites.reduce((a, s) => a + (s.moveOutAreaSum || 0), 0) : null;
          const netMoveIns = moveIns - moveOuts;
          const prevNetMoveIns = (prevMoveIns != null && prevMoveOuts != null) ? prevMoveIns - prevMoveOuts : null;
          return { title: 'Move-ins & Move-outs', live: true, compact: true, tip: 'Reports: ManagementSummary (Move-ins, Move-outs counts); MoveInsAndMoveOuts (Sqft In, Sqft Out).\nFields: sDesc rows matching "Move In"/"Move Out", iMCount (ManagementSummary); MovedInArea, MovedOutArea (MoveInsAndMoveOuts).\nCalculation: Net Move-ins = Move-ins − Move-outs (unit count). Net ft² = Σ MovedInArea − Σ MovedOutArea (Sqft Out shown negative).', tiles: [
              { value: intFmt(moveIns), label: 'Move-ins', ...deltaTick(moveIns, prevMoveIns, 'count') },
              { value: intFmt(moveOuts), label: 'Move-outs', ...deltaTick(moveOuts, prevMoveOuts, 'count', true) },
              { value: (netMoveIns >= 0 ? '+' : '') + intFmt(netMoveIns), label: 'Net Move-ins', ...deltaTick(netMoveIns, prevNetMoveIns, 'count') },
              { rowBreak: true },
              { value: intFmt(moveInArea) + ' ft²', label: 'Sqft In', ...deltaTick(moveInArea, prevMoveInArea, 'ft') },
              { value: intFmt(-moveOutArea) + ' ft²', label: 'Sqft Out', ...deltaTick(-moveOutArea, prevMoveOutArea != null ? -prevMoveOutArea : null, 'ft') },
              { value: intFmt(netArea) + ' ft²', label: 'Net ft²', ...deltaTick(netArea, prevNetArea, 'ft') },
            ] };
        })(),
        // Move-In Rental Rate — added 6 Jul 2026 from Michael's uploaded MoveInsAndMoveOuts export
        // ("rental rate (13) / area" — column 13, MovedInRentalRate, ÷ MovedInArea). Σ rate ÷ Σ area
        // × 12, same sum-then-divide/annualise convention as every other rate/ft² widget — the rate
        // achieved specifically on THIS month's new move-ins, as distinct from the whole-book Rate/
        // Real Rate widgets elsewhere.
        (() => {
          if (!liveSites) return { title: 'Move-In Rental Rate', tiles: [{ value: '£24.60', label: 'Per ft² (selected period move-ins)', delta: '£0.80', dir: 'up' }] };
          const moveInRate = (sites) => { const area = sites.reduce((a, s) => a + (s.moveInAreaSum || 0), 0); return area ? R2(sites.reduce((a, s) => a + (s.moveInRateSum || 0), 0) / area * 12) : 0; };
          const moveInArea = liveSites.reduce((a, s) => a + (s.moveInAreaSum || 0), 0);
          const rate = moveInRate(liveSites);
          const prevRate = livePrevSites ? moveInRate(livePrevSites) : null;
          return moveInArea
            ? { title: 'Move-In Rental Rate', live: true, tip: 'Report: MoveInsAndMoveOuts.\nFields: MovedInRentalRate, MovedInArea.\nCalculation: Σ MovedInRentalRate ÷ Σ MovedInArea × 12. Rate achieved on move-ins within the selected period only, not the whole portfolio.', tiles: [{ value: '£' + rate.toFixed(2), label: 'Per ft² (selected period move-ins)', ...deltaTick(rate, prevRate, 'money') }] }
            : { title: 'Move-In Rental Rate', live: true, tip: 'Report: MoveInsAndMoveOuts.\nFields: MovedInRentalRate, MovedInArea.\nCalculation: Σ MovedInRentalRate ÷ Σ MovedInArea × 12. Rate achieved on move-ins within the selected period only, not the whole portfolio.\nNote: no moved-in area exists in the selected store scope/period, so no move-in rental rate can be derived.', tiles: [{ value: 'N/A', label: 'No move-ins in scope', delta: null, dir: null }] };
        })(),
        // Move-in Variance vs Standard Rate — RESOURCED 21 Jul 2026 (Rich's portal review, task #360).
        // Was reading Discounts' dcVariance (this-period £avg per move-in); Rich flagged this as wrong
        // and confirmed the correct source is MoveInsAndMoveOuts' own MovedInVariance/StandardRate
        // columns, expressed as a % ("you take the variance vs standard rate"), per his supplied
        // Move_in_Move_out PSF and Variance.xlsx reference workbook. "Actual" subtracts a natural 8.33%
        // (=13÷12−1) baseline variance from monthly vs 4-weekly billing-cycle differences — Rich's own
        // words, and the same constant independently found in task #308's Bicester rate-annualization
        // probe — so it isn't mistaken for a real pricing gap. Delta wired the same way as every
        // sibling card on this page (kpiPrevT.moveInVarStdRateActualPct, computed by computeTotals()).
        kpiT
          ? (kpiT.moveInVarianceCount
              ? { title: 'Move-in Variance vs Standard Rate', live: true, tip: 'Report: MoveInsAndMoveOuts.\nFields: MovedInVariance, StandardRate (MoveIn rows only).\nCalculation: Σ MovedInVariance ÷ Σ StandardRate, minus a natural 8.33% baseline variance from monthly vs 4-weekly billing-cycle differences (not a data error — see Rich\'s reference workbook). "Actual" is the baseline-adjusted figure.', tiles: [{ value: (kpiT.moveInVarStdRateActualPct >= 0 ? '+' : '') + kpiT.moveInVarStdRateActualPct.toFixed(1) + '%', label: `Actual (raw ${kpiT.moveInVarStdRatePct.toFixed(1)}%, n=${kpiT.moveInVarianceCount ?? 0})`, ...deltaTick(kpiT.moveInVarStdRateActualPct, kpiPrevT && kpiPrevT.moveInVarStdRateActualPct) }] }
              : { title: 'Move-in Variance vs Standard Rate', live: true, tip: 'Report: MoveInsAndMoveOuts.\nFields: MovedInVariance, StandardRate (MoveIn rows only).\nCalculation: Σ MovedInVariance ÷ Σ StandardRate, minus a natural 8.33% baseline variance from monthly vs 4-weekly billing-cycle differences (not a data error — see Rich\'s reference workbook). "Actual" is the baseline-adjusted figure.\nNote: no move-ins exist in the selected store scope/period, so no variance can be derived.', tiles: [{ value: 'N/A', label: 'No move-ins in scope', delta: null, dir: null }] })
          : { title: 'Move-in Variance vs Standard Rate', tiles: [{ value: '-4.2%', label: 'Actual (raw 4.1%, n=11)', delta: null, dir: null }] },
        // Increase in Sqft Rented — REMOVED 6 Jul 2026 (Michael). Still available as the "Net ft²"
        // tile on the Move-ins & Move-outs card above (mio.net_area) if needed again.
        // Autobill Conversion — REMOVED from the KPI page 16 Jul 2026 (Michael's manual audit).
        // Still lives on the Ancillaries page (same metric/tile, kpiT.autobillPC) — this was a
        // straight duplicate between the two pages, not a data bug.
        // Customer Churn — REBUILT 23 Jul 2026 (Michael: cutover moved to end of August, do the real
        // fix rather than just a tooltip). Previously always read `liveHistory` (portfolio.history — a
        // single already-summed portfolio-wide series, per-site granularity discarded server-side by
        // buildHistory() in lib/buildPayload.js) and always ended its trailing-12-month window at
        // whatever the LATEST stored month happened to be — so neither the store filter nor the period
        // selector could ever move the number, exactly matching what Michael saw ("almost as if it does
        // not change"). Fixed by reading `liveMonthly` instead (portfolio.monthly — per-site-per-month
        // records, already fetched into this page for the MoM per-store overlay feature, task #373, so
        // this needs no new API call) and: 1) anchoring the trailing-12-month window at
        // monthKeyOf(monthTo) instead of the latest stored month — same anchor convention already used
        // by the Marketing YoY series (curMonthKey) and the MoM per-store overlay (selectedMonthKey)
        // elsewhere on this page, so it now moves with the period selector; 2) filtering each month's
        // per-site records by the same `selected` store-checkbox state `liveSites` above already uses,
        // so picking a store now actually changes the result. Legacy formula itself is unchanged
        // (confirmed 2 Jul 2026): Σ move-outs ÷ average occupied units over the trailing 12 months × 100.
        (() => {
          const anchorKey = monthKeyOf(monthTo);
          const monthKeys = liveMonthly ? Object.keys(liveMonthly).sort().filter((mk) => mk <= anchorKey) : [];
          const last12Keys = monthKeys.length >= 12 ? monthKeys.slice(-12) : null;
          const scoped = (recs) => (!recs) ? [] : (pageHasSelectedStores ? recs.filter((r) => pageSelectedNames.has(r.name)) : recs);
          if (last12Keys) {
            let moveOutsSum = 0, occSum = 0;
            for (const mk of last12Keys) {
              const recs = scoped(liveMonthly[mk]);
              moveOutsSum += recs.reduce((a, r) => a + (r.moveOuts || 0), 0);
              occSum += recs.reduce((a, r) => a + (r.occ || 0), 0);
            }
            const avgOcc = occSum / last12Keys.length;
            const churnPct = avgOcc ? R2(moveOutsSum / avgOcc * 100) : 0;
            return { title: 'Customer Churn', live: true, tip: 'Report: OccupancyStatistics (occupied units); MoveInsAndMoveOuts (move-outs).\nCalculation: Σ move-outs ÷ average occupied units, over the trailing 12 months ending at the selected period, × 100. Respects the store filter and moves with the period selector.', tiles: [{ value: churnPct.toFixed(1) + '%', label: 'Rolling 12-month', delta: null, dir: null }], hasViz: true, el: <Donut pct={churnPct} color={C.teal} /> };
          }
          if (liveMonthly) {
            debugWarn(`[portal-v2] Customer Churn unavailable — only ${monthKeys.length} month(s) of history stored at/before ${anchorKey} (need 12). Run npm run backfill 12 (or more).`);
            return { title: 'Customer Churn', live: true, tiles: [{ value: 'N/A', label: 'Need 12 months history', delta: null, dir: null }], hasViz: true, el: <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>Customer churn needs 12 stored months of history.</div> };
          }
          return { title: 'Customer Churn', tiles: [{ value: '78.88%', label: 'Rolling 12-month', delta: '1%', dir: 'down' }], hasViz: true, el: <Donut pct={78.88} color={C.teal} /> };
        })(),
      ];
      // Occupancy by Store table — REBUILT 21 Jul 2026 (Rich's portal review, tasks #356/#357).
      // Previously two separate widgets covered overlapping ground: this "Occupied Area (% of MLA) by
      // Store" bar chart (area-based occupancy only), and the "Unit Mix Occupancy" table elsewhere on
      // this page (unit-based, grouped by SIZE not by store). Rich: "Can we add economic occupancy
      // into this section please... I would include [unit occupancy] here to save space and then mark
      // clearly what is area and what is unit occupancy. I would also title it differently after
      // that." Consolidated into ONE per-store table with all three clearly-labeled occupancy
      // measures, replacing the chart entirely (still sortable/all-stores like the chart it replaces):
      //   - Area Occupancy % (areaPCmla = occA/totA, Maximum Lettable Area basis) — physical sqft.
      //   - Unit Occupancy % (occPC = occ/tot) — physical unit count, ignores unit size entirely.
      //   - Economic Occupancy % (task #356) = Σ ActualOccupied ÷ Σ GrossPotential × 100, per Rich's
      //     supplied Economic occupancy Tracker.xlsx — blends vacancy loss AND rate/discount loss into
      //     one number (a fully-occupied site discounting heavily still shows well below 100% here,
      //     unlike Area/Unit Occupancy which only see empty vs full). Sourced from fields already
      //     pulled for other widgets (OccupancyStatistics' ActualOccupied/GrossPotential — see
      //     lib/buildPayload.js's recordFor()/aggregateTotals() comments) — no new report pull.
      // FIXED 21 Jul 2026 (live spot-check while re-verifying Rich's portal review, task #379): every
      // row was showing Unit Occupancy % = 0.0% — this read s.occPct, a field that doesn't exist on
      // the site record (the real per-site field is occPC, see recordFor() in lib/buildPayload.js line
      // 129 and the comment right above this block). s.occPct was always undefined, so `|| 0` silently
      // masked it. occPct only ever exists as a LOCAL/destination variable name elsewhere in this file
      // (e.g. line 1594's `occPct: s.occPC || 0` on the Portfolio Occupancy table) — never as a field
      // ON s itself. Copy-paste mixed up the two naming conventions.
      const liveOccByStoreRows = liveSites ? liveSites.map((s) => ({
        name: s.name, areaPct: s.areaPCmla || 0, unitPct: s.occPC || 0, econPct: s.economicOccPct || 0,
      })) : null;
      if (!liveOccByStoreRows) debugWarn('[portal-v2] Occupancy by Store table rendering with mock data (no live sites available).');
      const occByStoreRows = liveOccByStoreRows || fs.map((s) => ({
        name: s.name, areaPct: s.occPct, unitPct: s.occPct, econPct: Math.max(0, s.occPct - 6 - (s.occupied % 5)),
      }));
      const occByStoreTotals = (() => {
        const avg = (k) => occByStoreRows.length ? +(occByStoreRows.reduce((a, r) => a + (r[k] || 0), 0) / occByStoreRows.length).toFixed(1) : 0;
        // Area/Unit occupancy totals mirror the portfolio-level sum-then-divide figures (kpiT.areaPC/
        // occPC) when live, rather than a plain average-of-per-store-%s; economicOccPct likewise.
        return liveOccByStoreRows && kpiT
          ? { areaPct: kpiT.areaPCmla ?? avg('areaPct'), unitPct: kpiT.occPC ?? avg('unitPct'), econPct: kpiT.economicOccPct ?? avg('econPct') }
          : { areaPct: avg('areaPct'), unitPct: avg('unitPct'), econPct: avg('econPct') };
      })();
      // Unit Occupancy % column REMOVED 21 Jul 2026 (Michael: "move the unit occupancy to the self
      // storage widget to save space") — dropped from this table to narrow it back down to two
      // columns; the figure now lives as its own tile on the "Self Storage" stat card above instead
      // (relabelled "Unit Occupancy %" there — see that card's comment). Row data (unitPct) is left
      // computed above, just no longer rendered as a column, so it's a one-line change to bring back.
      out.tables.push({
        // NARROWED (task #395) — only 2 data columns, so this now sits 2-up instead of full-width.
        title: `Occupancy by Store (${liveScopeLabel})`, live: !!liveOccByStoreRows, pageSize: 12, totals: occByStoreTotals, totalsLabel: 'Portfolio',
        tip: 'Report: OccupancyStatistics.\nFields: OccupiedArea/Area/TotalUnits (Area %); ActualOccupied/GrossPotential (Economic %).\nCalculation: Area Occupancy % = Σ OccupiedArea ÷ Σ(Area × TotalUnits) × 100 (Maximum Lettable Area basis). Economic Occupancy % = Σ ActualOccupied ÷ Σ GrossPotential × 100 — reflects discounting as well as vacancy, unlike Area Occupancy. (Unit Occupancy % — plain Occupied ÷ Total Units — now lives on the Self Storage card above.)',
        columns: [
          { key: 'name', label: 'Store', type: 'text' },
          { key: 'areaPct', label: 'Area Occupancy %', type: 'pct', align: 'right', color: 'threshold' },
          { key: 'econPct', label: 'Economic Occupancy %', type: 'pct', align: 'right', color: 'threshold' },
        ],
        rows: occByStoreRows,
      });
      // Economic Occupancy Detail table — MOVED to the bottom of this page 21 Jul 2026 (Michael:
      // "compress the economic occupancy detail, by bulk/driveup/enterprise and but this widget to
      // the bottom") — build logic relocated to just before this branch's closing brace, after
      // Indoor Self Storage Occupancy — by Store, so it renders last among this page's tables. See
      // that comment (bottom of the 'kpis' branch) for the full history and the compression change.
      // Units / Rate per ft² by Customer Type: live-wired from totals.customerType (lib/buildPayload.js
      // sums RentRoll's per-site business/residential units, area and rent first, then divides once).
      const custT = kpiT?.customerType;
      const custTypeUnitsTotal = ((custT?.business?.units || 0) + (custT?.residential?.units || 0));
      const custTypeRateAreaTotal = liveSites
        ? liveSites.reduce((sum, s) => sum + ((s.customerType?.business?.area || 0) + (s.customerType?.residential?.area || 0)), 0)
        : 0;
      const hasCustTypeSplit = !!(custT && custTypeUnitsTotal > 0);
      const hasCustTypeRate = !!(custT && custTypeRateAreaTotal > 0);
      // Rate Increases by Store: converted from a time trend (needed 12mo history we don't have) to
      // a per-store comparison over the CURRENTLY SELECTED live period. TenantRentChangeHistory's
      // increases count is already captured per site (rec.rateChanges.increases), so this doesn't
      // need extra history and fits the same "which store is the outlier" comparison philosophy as
      // every other dashboard/KPI chart.
      const liveRateIncBars = liveSites ? liveSites.map((s) => ({ label: s.name, value: (s.rateChanges && s.rateChanges.increases) || 0, disp: intFmt((s.rateChanges && s.rateChanges.increases) || 0), color: C.blue })) : null;
      if (!hasCustTypeSplit || !hasCustTypeRate || !liveRateIncBars) debugWarn('[portal-v2] KPIs chart cards have incomplete live inputs (customerType and/or rateChanges unavailable).');
      // Pinned summary bar (legacy parity): Rate Increases ends with a "Total" bar (legacy labels
      // that chart's summary bar "Total", not "Average"). The equivalent %-of-MLA summary now lives
      // in the Occupancy by Store table's totals row (occByStoreTotals.areaPct) above.
      const rateIncTotal = liveRateIncBars
        ? liveRateIncBars.reduce((a, b) => a + b.value, 0)
        : fs.reduce((a, s) => a + Math.round((38 * f) / fs.length) + (s.occupied % 5), 0);
      out.chartCards = [
        // 'Occupied Area (% of MLA) by Store' chart REMOVED 21 Jul 2026 (tasks #356/#357) — replaced
        // by the 'Occupancy by Store' table above, which shows this same Area Occupancy % alongside
        // Unit Occupancy % and the new Economic Occupancy %, per Rich's consolidation request.
        { title: 'Units by Customer Type', tip: 'Report: RentRoll.\nFields: bCorporate, bCommercial, sCompany.\nCalculation: A unit is "Business" if bCorporate or bCommercial is set, or sCompany is non-blank; otherwise "Personal". Share = each segment\'s occupied units ÷ total occupied units × 100.\nNote: when the selected store scope has no occupied units with a customer-type classification, no split can be derived truthfully.', el: hasCustTypeSplit ? <VBars items={[{ label: 'Personal', value: custT.residential.pct, disp: custT.residential.pct + '%', color: C.blue }, { label: 'Business', value: custT.business.pct, disp: custT.business.pct + '%', color: C.blue2 }]} opts={{ max: 100 }} /> : liveSites ? <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>No customer-type split is available for the selected store scope.</div> : <VBars items={[{ label: 'Personal', value: 81, disp: '81%', color: C.blue }, { label: 'Business', value: 19, disp: '19%', color: C.blue2 }]} opts={{ max: 100 }} /> },
        { title: 'Rate per ft² by Customer Type', tip: 'Report: RentRoll.\nFields: dcStdRate, Area/Area1, bCorporate, bCommercial, sCompany.\nCalculation: Rate = Σ dcStdRate ÷ Σ area × 12, computed separately for the Business and Personal segments.\nNote: when the selected store scope has no classified occupied area, no customer-type rate split can be derived truthfully.', el: hasCustTypeRate ? <VBars items={[{ label: 'Personal', value: custT.residential.rate, disp: '£' + custT.residential.rate.toFixed(2), color: C.blue }, { label: 'Business', value: custT.business.rate, disp: '£' + custT.business.rate.toFixed(2), color: C.teal }]} opts={{ max: 40 }} /> : liveSites ? <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>No customer-type rate split is available for the selected store scope.</div> : <VBars items={[{ label: 'Personal', value: 29.1, disp: '£29.10', color: C.blue }, { label: 'Business', value: 31.4, disp: '£31.40', color: C.teal }]} opts={{ max: 40 }} /> },
        { title: `Rate Increases by Store (${liveScopeLabel})`, tip: 'Report: TenantRentChangeHistory.\nFields: dcOldRate, dcNewRate.\nCalculation: Count of rows where dcNewRate > dcOldRate, posted in the selected period, per site.', el: <StoreBarChart items={liveRateIncBars || fs.map((s) => ({ label: s.name, value: Math.round((38 * f) / fs.length) + (s.occupied % 5), disp: intFmt(Math.round((38 * f) / fs.length) + (s.occupied % 5)), color: C.blue }))} opts={{ average: { label: 'Total', value: rateIncTotal, disp: intFmt(rateIncTotal) } }} /> },
        // RELABELED 21 Jul 2026 (Rich's portal review, task #360). This chart was previously titled
        // "Move-in Variance vs Standard Rate (Whole Book...)" — Rich flagged that title's metric as
        // "just taken from the mgmt summary" and pointed to a differently-sourced, move-in-specific %
        // as the correct "Move-in Variance vs Standard Rate" (now the stat tile above, sourced from
        // MoveInsAndMoveOuts). Rich also called this whole-book data itself "interesting" though, so
        // it's kept, just renamed to describe what it actually is: every currently-occupied unit,
        // bucketed by how far its rent sits below/above standard rate (not move-in-scoped). Data/logic
        // unchanged — kpiT.varFromStdRate (ManagementSummary's hidden VarFromStdRate table), a live
        // snapshot regardless of month, same "as of now, not true history" caveat as RentRoll/
        // OccupancyStatistics elsewhere in this app.
        // FIXED 16 Jul 2026 (Michael, external verification against real SiteLink exports): this used
        // to silently fall back to hardcoded sample numbers (145/74/61/33/1) whenever a past month was
        // selected, with no on-screen indication they were fake — confirmed live to have fooled a
        // separate verification pass into treating them as real June figures. Root cause: VarFromStdRate
        // extraction was only added to the parser 9 Jul 2026, so any month locked in before then (every
        // month through June 2026) genuinely has no stored data for this field — not a bug to fix, a
        // permanent gap (SiteLink has no historical "as of" mode and raw_response wasn't retained early
        // enough to reparse). Now shows an honest "not available" state instead of invented numbers.
        (() => {
          const buckets = kpiT?.varFromStdRate;
          const hasData = !!(buckets && buckets.length);
          if (!hasData) debugWarn('[portal-v2] Units Below Standard Rate (whole-book): no varFromStdRate stored for the selected period (only captured for months locked since 9 Jul 2026).');
          const data = hasData ? buckets.map((b) => ({ label: b.bucket, value: b.count, disp: intFmt(b.count), color: C.blue })) : [];
          return {
            title: 'Units Below Standard Rate (Whole Book)',
            tip: 'Report: ManagementSummary.\nFields: sVarFromStdRateCat, VarFromStdRateCount (hidden VarFromStdRate table).\nCalculation: Count of currently-occupied units per bucket of (rent − standard rate) ÷ standard rate. Live snapshot of the whole book, not scoped to move-ins or the selected period (see the separate "Move-in Variance vs Standard Rate" tile for the move-in-specific figure).\nNote: not available for months locked before 9 Jul 2026 — this field didn\'t exist in the pipeline yet, not a data error.',
            el: hasData
              ? <VBars items={data} opts={{ max: Math.max(...data.map((d) => d.value)) * 1.15 }} />
              : <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>Not available for this period — only captured for months locked since 9 Jul 2026.</div>,
          };
        })(),
        // Occupancy by Floor (10 Jul 2026, roadmap #132/#139). liveFloorOcc is independent of the
        // month/range selector and everything else on this page, same as the Snapshot page's
        // liveSnapshot. The underlying unit_floor_status rows can now come from either the manual
        // UnitStatus XLSX path or the preferred live UnitsInformation API importer added on 21 Jul
        // 2026. Covers however many sites have been imported so far, so the title says exactly how
        // many rather than implying full-portfolio coverage it doesn't have yet.
        (() => {
          const floors = liveFloorFloors;
          const mockFloors = [{ floor: 1, occPct: 88.2 }, { floor: 2, occPct: 91.5 }, { floor: 3, occPct: 79.4 }];
          const hasScopedFloorData = !!(floors && floors.length);
          const hasFloorDataset = liveFloorOcc !== null;
          const rows = (hasScopedFloorData ? floors : mockFloors).map((b) => ({
            label: b.floor === 0 ? 'Ground' : `Floor ${b.floor}`,
            value: b.occPct,
            disp: b.occPct.toFixed(1) + '%',
            color: b.occPct >= 85 ? C.green : b.occPct >= 75 ? C.amber : C.red,
          }));
          if (!hasScopedFloorData) {
            if (hasFloorDataset) debugWarn('[portal-v2] Occupancy by Floor chart has no imported rows for the selected store scope.');
            else debugWarn('[portal-v2] Occupancy by Floor chart rendering with mock data — import floor data for the selected site(s), or clear the store filter to view all imported sites.');
          }
          const title = 'Occupancy by Floor';
          return {
            title,
            tip: 'Source: unit_floor_status (loaded from SiteLink UnitStatus export or UnitsInformation API import).\nFields: floor, occupied, rentable.\nCalculation: Occupied ÷ total rentable units, grouped by floor. Respects the selected store checkbox filter; with no store selected, shows all imported sites.',
            el: hasScopedFloorData
              ? <VBars items={rows} opts={{ max: 100 }} />
              : hasFloorDataset
                ? <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>No imported floor data for the selected store scope.</div>
                : <VBars items={rows} opts={{ max: 100 }} />,
          };
        })(),
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
      const hasUnitMixData = !!(liveUnitMixRows && liveUnitMixRows.length);
      if (!hasUnitMixData) {
        if (liveSites) debugWarn('[portal-v2] Unit Mix Occupancy table has no live unit-mix rows for the selected store scope.');
        else debugWarn('[portal-v2] Unit Mix Occupancy table rendering with mock data (no live unitMix available).');
      }
      const unitMixRows = hasUnitMixData
        ? liveUnitMixRows
        : liveSites
          ? [{ size: '(no unit mix data for selected store scope)', total: null, occupied: null, available: null, area: null, occPct: null }]
          : unitDefs.map(([size, type, baseUnits, baseArea]) => {
              const total = Math.round(baseUnits * 12 * f);
              const occPct2 = 70 + ((baseUnits * 7 + baseArea) % 30);
              const occ = Math.round((total * occPct2) / 100);
              return { size, type, total, occupied: occ, available: total - occ, area: Math.round(baseArea * 12 * f), occPct: +occPct2.toFixed(1) };
            });
      // Totals row: sums per column, occupancy % re-derived from the summed units (sum-then-divide).
      const unitMixTotals = hasUnitMixData ? (() => {
        const s = (k) => unitMixRows.reduce((a, r) => a + (r[k] || 0), 0);
        const tot = s('total'), occ = s('occupied');
        return { total: tot, occupied: occ, available: s('available'), area: s('area'), occPct: tot ? +(occ / tot * 100).toFixed(1) : 0 };
      })() : (liveSites ? null : (() => {
        const s = (k) => unitMixRows.reduce((a, r) => a + (r[k] || 0), 0);
        const tot = s('total'), occ = s('occupied');
        return { total: tot, occupied: occ, available: s('available'), area: s('area'), occPct: tot ? +(occ / tot * 100).toFixed(1) : 0 };
      })());
      out.tables.push({
        // NARROWED 21 Jul 2026 (Michael: "units by customer type and unit mix occupancy also need to
        // be narrowed... and put next to eachother") — pairs 2-up with Units by Customer Type below.
        title: `Unit Mix Occupancy (${liveScopeLabel})`, live: hasUnitMixData, pageSize: 12, totals: unitMixTotals, totalsLabel: 'Total',
        tip: 'Report: OccupancyStatistics.\nFields: Area, TotalArea, Occupied, TotalUnits (Indoor Self Storage rows only).\nCalculation: Grouped by rounded per-unit Area; the first column is the size bucket, while Total Area is the summed area of all units in that bucket. Occupancy % = Σ Occupied ÷ Σ TotalUnits × 100 per size bucket (sum-then-divide, not a per-site average).',
        columns: hasUnitMixData ? [
          { key: 'size', label: 'Unit Size', type: 'text' },
          { key: 'total', label: 'Total Units', type: 'int', align: 'right' }, { key: 'occupied', label: 'Occupied', type: 'int', align: 'right' },
          { key: 'available', label: 'Available', type: 'int', align: 'right' }, { key: 'area', label: 'Total Area (ft²)', type: 'ft', align: 'right' },
          { key: 'occPct', label: 'Occupancy %', type: 'pct', align: 'right', color: 'threshold' },
        ] : liveSites ? [
          { key: 'size', label: 'Unit Size', type: 'text' },
          { key: 'total', label: 'Total Units', type: 'int', align: 'right' }, { key: 'occupied', label: 'Occupied', type: 'int', align: 'right' },
          { key: 'available', label: 'Available', type: 'int', align: 'right' }, { key: 'area', label: 'Total Area (ft²)', type: 'ft', align: 'right' },
          { key: 'occPct', label: 'Occupancy %', type: 'pct', align: 'right', color: 'threshold' },
        ] : [
          { key: 'size', label: 'Unit Size', type: 'text' }, { key: 'type', label: 'Type', type: 'text' },
          { key: 'total', label: 'Total Units', type: 'int', align: 'right' }, { key: 'occupied', label: 'Occupied', type: 'int', align: 'right' },
          { key: 'available', label: 'Available', type: 'int', align: 'right' }, { key: 'area', label: 'Total Area (ft²)', type: 'ft', align: 'right' },
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
        const rateArea = (ct.residential?.area || 0) + (ct.business?.area || 0);
        return { name: s.name, personal, business, personalPct: tot ? +(personal / tot * 100).toFixed(1) : null, rate: rateArea ? (s.rate || 0) : null };
      }) : null;
      if (!liveCustTypeRows) debugWarn('[portal-v2] Units by Customer Type table rendering with mock RAW_STORES data (no live sites available).');
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
        return { personal: p, business: b, personalPct: (p + b) ? +(p / (p + b) * 100).toFixed(1) : null, rate: occSum ? rate : null };
      })();
      out.tables.push({
        // NARROWED 21 Jul 2026 (see Unit Mix Occupancy above — same request, paired with it).
        title: `Units by Customer Type — by Store (${liveScopeLabel})`, live: !!liveCustTypeRows, pageSize: 10, totals: custTypeTotals, totalsLabel: 'Total',
        tip: 'Report: RentRoll.\nFields: bCorporate, bCommercial, sCompany, dcStdRate, Area/Area1.\nCalculation: Personal/Business occupied unit counts per site; Rate = Σ dcStdRate ÷ Σ area × 12 (same portfolio Total Rate shown on the Rates per ft² table).',
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
      if (!liveOfficesRows || !liveSSRows) debugWarn('[portal-v2] Offices/Indoor Self Storage Occupancy tables rendering with mock data (no live sites available).');
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
      // NARROWED (task #395) — 4 columns each, and these two are natural siblings (same officeSSColumns
      // shape), so they now sit side by side as a pair instead of each spanning the full page width.
      out.tables.push({
        title: `Offices Occupancy — by Store (${liveScopeLabel})`, live: !!liveOfficesRows, pageSize: 10,
        tip: 'Reports: OccupancyStatistics (Offices unit type); RentRoll (rent, Area).\nFields: Occupied, TotalUnits (OccupancyStatistics); dcRent, Area/Area1, sTypeName="Offices" (RentRoll).\nCalculation: Rate = Σ dcRent ÷ Σ area × 12 (actual rent, not standard rate). Sites with no Offices unit type show 0/£0.00.',
        columns: officeSSColumns, rows: officesRows, totalsLabel: 'Total',
        totals: occRateTotals(officesRows, kpiT?.officesOcc, kpiT?.officesTot, kpiT?.officesRate),
      });
      out.tables.push({
        title: `Indoor Self Storage Occupancy — by Store (${liveScopeLabel})`, live: !!liveSSRows, pageSize: 10,
        tip: 'Reports: OccupancyStatistics (Indoor Self Storage unit type); RentRoll (standard rate, Area).\nFields: Occupied, TotalUnits (OccupancyStatistics); dcStdRate, Area/Area1, sTypeName="Indoor Self Storage" (RentRoll).\nCalculation: Rate = Σ dcStdRate ÷ Σ area × 12.',
        columns: officeSSColumns, rows: ssRows, totalsLabel: 'Total',
        totals: occRateTotals(ssRows, kpiT?.ssOcc, kpiT?.ssTot, kpiT?.ssRate),
      });
      // Occupied Area by % of CLA — by Store: CONVERTED from a table to a StoreBarChart 16 Jul 2026
      // (Michael's manual audit) — same per-store comparison pattern as its sibling "Occupied Area
      // (% of MLA) by Store" above. area <- occA, cla <- claA (Current Lettable Area, from
      // lib/reportMap.js's occupancy parser), claPct <- areaPC (same occA/claA-with-occA/totA-
      // fallback rule used everywhere else, e.g. recordFor() in lib/buildPayload.js).
      const liveClaRows = liveSites ? liveSites.map((s) => ({
        name: s.name, area: s.occA || 0, cla: s.claA || 0, claPct: s.areaPC || 0,
      })) : null;
      if (!liveClaRows) debugWarn('[portal-v2] Occupied Area by % of CLA chart rendering with mock RAW_STORES data (no live sites available).');
      const claRowsAll = liveClaRows || fs.map((s) => ({ name: s.name, region: s.region, area: s.area, cla: Math.round(s.area / (s.claPct / 100)), claPct: s.claPct }));
      // Portfolio bar: % of CLA re-derived from the sums (kpiT.claPC on the live path) — same
      // sum-then-divide convention as every other portfolio summary on this page.
      const claTotals = (() => {
        const area = claRowsAll.reduce((a, r) => a + (r.area || 0), 0), cla = claRowsAll.reduce((a, r) => a + (r.cla || 0), 0);
        return { area, cla, claPct: kpiT ? (kpiT.claPC ?? 0) : (cla ? +(area / cla * 100).toFixed(1) : 0) };
      })();
      out.chartCards.push({
        title: `Occupied Area by % of CLA — by Store (${liveScopeLabel})`,
        tip: 'Report: OccupancyStatistics.\nFields: OccupiedArea (falls back to Area × Occupied), Area, TotalUnits, Unrentable.\nCalculation: % of CLA = Σ OccupiedArea ÷ Σ(Area × (TotalUnits − Unrentable)) × 100 per site. Portfolio bar = weighted across the shown store scope (sum-then-divide).\nNote: OccupiedArea is SiteLink\'s own average of day 10, day 20, and month-end — not a live figure.',
        el: <StoreBarChart items={claRowsAll.map((s) => ({ label: s.name, disp: (s.claPct || 0).toFixed(1) + '%', value: s.claPct || 0, color: (s.claPct || 0) >= 85 ? C.green : (s.claPct || 0) >= 75 ? C.amber : C.red }))} opts={{ zero: false, average: { label: 'Portfolio', value: claTotals.claPct, disp: claTotals.claPct.toFixed(1) + '%' } }} />,
      });
    }

    else if (page === 'economicOccupancy') {
      if (!econDetailData) debugWarn('[portal-v2] Economic Occupancy page rendering with no data (no live sites available).');
      if (econDetailData && econDetailData.rows.length) {
        out.tables.push({
          title: 'Economic Occupancy Detail — ' + econDetailData.scope, live: true, pageSize: 30,
          tip: 'Report: OccupancyStatistics.\nFields: TotalArea, OccupiedArea (falls back to Area × Occupied), GrossPotential, ActualOccupied — grouped by unit Type and summed across every size within that type.\nCalculation: Asking Rent PSF = Σ GrossPotential ÷ Σ TotalArea × 12. In-Place Rent PSF = Σ ActualOccupied ÷ Σ OccupiedArea × 12. In-Place Discount = (In-Place − Asking) ÷ Asking × 100. Occupancy % = Σ OccupiedArea ÷ Σ TotalArea × 100. Economic Occupancy % = Σ ActualOccupied ÷ Σ GrossPotential × 100.\nMoM columns compare against last month\'s snapshot for the same store selection.',
          columns: [
            { key: 'type', label: 'Unit Type', type: 'text' },
            { key: 'askingPSF', label: 'Asking Rent PSF', type: 'money2', align: 'right' },
            { key: 'askingMoM', label: 'MoM', type: 'text', align: 'right' },
            { key: 'inPlacePSF', label: 'In-Place Rent PSF', type: 'money2', align: 'right' },
            { key: 'inPlaceMoM', label: 'MoM', type: 'text', align: 'right' },
            { key: 'discountPct', label: 'In-Place Discount', type: 'pct', align: 'right' },
            { key: 'discountMoM', label: 'MoM', type: 'text', align: 'right' },
            { key: 'occPct', label: 'Occupancy %', type: 'pct', align: 'right', color: 'threshold' },
            { key: 'occMoM', label: 'MoM', type: 'text', align: 'right' },
            { key: 'econPct', label: 'Economic Occupancy %', type: 'pct', align: 'right', color: 'threshold' },
            { key: 'econMoM', label: 'MoM', type: 'text', align: 'right' },
          ],
          rows: econDetailData.rows,
        });
      }
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
        const validStayCount = finT.stayCount || 0;
        const avgStay = validStayCount ? Math.round((finT.stayDaysSum || 0) / validStayCount) : null;
        const avgCustValue = validStayCount ? R2((((finT.stayRentSum || 0) / validStayCount) * (avgStay / 30.43))) : null;
        custInsights = avgStay != null && avgCustValue != null
          ? { title: 'Customer Insights', live: true, tip: 'Report: RentRoll.\nFields: dLeaseDate, dcRent, bRented.\nCalculation: Avg Stay = Σ(days since dLeaseDate as of the stored pull snapshot) ÷ occupied units with a valid lease-date-derived stay length. Avg Customer Value = (Σ dcRent ÷ those same occupied units) × (Avg Stay ÷ 30.43) — a lifetime value estimate, not just monthly rent.\nNote: corrected 16 Jul 2026 — this previously said "Report: ManagementSummary (days occupied)", but avg length of stay is actually sourced from RentRoll\'s dLeaseDate (lib/reportMap.js\'s rent_roll parser).', tiles: [{ value: money(avgCustValue), label: 'Avg customer value', delta: null, dir: null }, { value: avgStay + ' days', label: 'Avg length of stay', delta: null, dir: null }] }
          : { title: 'Customer Insights', live: true, tip: 'Report: RentRoll.\nFields: dLeaseDate, dcRent, bRented.\nCalculation: Avg Stay = Σ(days since dLeaseDate as of the stored pull snapshot) ÷ occupied units with a valid lease-date-derived stay length. Avg Customer Value = (Σ dcRent for those same customers) ÷ valid-customer count × (Avg Stay ÷ 30.43) — a lifetime value estimate, not just monthly rent.\nNote: no occupied customers with a valid lease-date-derived stay length exist in the selected store scope, so neither average can be derived truthfully.', tiles: [{ value: 'N/A', label: 'Avg customer value', delta: null, dir: null }, { value: 'N/A', label: 'Avg length of stay', delta: null, dir: null }] };
      } else {
        debugWarn('[portal-v2] Financials Customer Insights rendering with mock data (no live totals available).');
        custInsights = { title: 'Customer Insights', tiles: [{ value: money(3921), label: 'Avg customer value', delta: '£38', dir: 'down' }, { value: '721 days', label: 'Avg length of stay', delta: '2 days', dir: 'down' }] };
      }
      // Past Due Balances: totals.debtorTotal / debtorRentRollPct — same Debtor Levels source
      // already used on the Dashboard/KPIs (PastDueBalances, sum-then-divide). Tile label calls out
      // "(30+ days)" explicitly (widget name review, 2 Jul 2026) since debtorTotal is the
      // 30-days-overdue figure, not every positive balance — the same distinction that was a
      // confirmed bug on the Debtor Levels widget (see lib/buildPayload.js's `debtors` comment).
      const pastDue = finT
        ? { title: 'Past Due Balances', live: true, tip: `Reports: PastDueBalances (overdue, 30+ days); OccupancyStatistics (occupied rent).\nFields: ChargeBalance (or RentBal+LateFeeBal+POSBal+OtherChargesBal+TaxesBal), DaysLate (PastDueBalances); ActualOccupied (OccupancyStatistics).\nCalculation: Total overdue = Σ balances where DaysLate > 30. % of rent roll = overdue (30+ day) £ ÷ Σ ActualOccupied × 100.${finT.occActualRent ? '' : '\nNote: no occupied rent exists in the selected store scope, so % of rent roll cannot be derived.'}`, tiles: [{ value: money(finT.debtorTotal ?? 0), label: 'Total overdue (30+ days)', delta: null, dir: null }, { value: finT.occActualRent ? (finT.debtorRentRollPct ?? 0).toFixed(1) + '%' : 'N/A', label: '% of rent roll', delta: null, dir: null }] }
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
      // Coloring REMOVED 8 Jul 2026 (Michael: "change all the values in the tables to grey/black but
      // keep the color on the changes at the bottom") — the sign-based red/green rule this used to be
      // (added 3 Jul 2026, "verified against Michael's screenshot") turned out to not match legacy at
      // all: legacy's per-cell color tracks something else entirely (not the value's own sign — most
      // of these values are positive but legacy still shows a mix of red/green), and rather than guess
      // legacy's real per-column rule, Michael opted to drop per-value coloring entirely here. Every
      // cell now renders in the same plain grey/black as any other table. The totals-row "vs last
      // month" chips (DataTable's totalsPrev handling) are untouched — that color is intentionally kept.
      const revCols = [
        { key: 'desc', label: 'Description', type: 'text' }, { key: 'invoiced', label: 'Invoiced', type: 'money', align: 'right' }, { key: 'taxInvoiced', label: 'Tax Invoiced', type: 'money', align: 'right' },
        { key: 'taxAdj', label: 'Tax Adj', type: 'money', align: 'right' }, { key: 'netTax', label: 'Net Tax', type: 'money', align: 'right' }, { key: 'deferred', label: 'Deferred Rev', type: 'money', align: 'right' },
        { key: 'deferredPrev', label: 'Deferred Prev', type: 'money', align: 'right' }, { key: 'adj', label: 'Adjustments', type: 'money', align: 'right' }, { key: 'adjPrev', label: 'Adj Prev', type: 'money', align: 'right' }, { key: 'truePeriod', label: 'True Period', type: 'money', align: 'right' },
      ];
      const hasTrueRevenueData = !!(finT?.trueRevenueByDesc?.length && finT?.trueRevenueByType?.length);
      if (!hasTrueRevenueData) {
        if (finT) debugWarn('[portal-v2] True Revenue tables have no live rows for the selected period/store scope.');
        else debugWarn('[portal-v2] True Revenue tables rendering with mock data (no live true_revenue data yet — run npm run pull after adding true_revenue to the pipeline).');
      }
      // Totals rows (legacy parity: both True Revenue tables end with a totals row — the legacy
      // labels it with the month, ours with "Total" — summing every money column).
      const revTotals = (rows) => {
        const out2 = {};
        for (const c of revCols) if (c.key !== 'desc') out2[c.key] = R2(rows.reduce((a, r) => a + (+r[c.key] || 0), 0));
        return out2;
      };
      const revRows = finT?.trueRevenueByDesc?.length
        ? finT.trueRevenueByDesc
        : finT
          ? [{ desc: '(no true revenue rows for selected scope/period)', invoiced: null, taxInvoiced: null, taxAdj: null, netTax: null, deferred: null, deferredPrev: null, adj: null, adjPrev: null, truePeriod: null }]
          : mockRev;
      const revTypeRows = finT?.trueRevenueByType?.length
        ? finT.trueRevenueByType
        : finT
          ? [{ desc: '(no true revenue unit-type rows for selected scope/period)', invoiced: null, taxInvoiced: null, taxAdj: null, netTax: null, deferred: null, deferredPrev: null, adj: null, adjPrev: null, truePeriod: null }]
          : mockRevByType;
      // "vs last month" totals-row deltas (8 Jul 2026) — same livePrevSites snapshot/pattern as the
      // Dashboard tables above. No mock fallback here (unlike revRows/revTypeRows): if there's no real
      // previous-month data, the totals row just shows no chip rather than a fabricated comparison.
      const finTPrev = livePrevSites ? computeTotals(livePrevSites) : null;
      const revRowsPrev = finTPrev?.trueRevenueByDesc?.length ? finTPrev.trueRevenueByDesc : null;
      const revTypeRowsPrev = finTPrev?.trueRevenueByType?.length ? finTPrev.trueRevenueByType : null;
      out.tables = [
        // pageSize bumped 3 Jul 2026 (Michael: "many missing unit types on True Revenue") — rows
        // weren't actually missing, they were paginated (12/page on a ~50-row ChargeDesc table) and
        // the Unit Types table was additionally fragmenting near-duplicate labels like "Drive Up" /
        // "DriveUp" / "Drive up" into separate rows (fixed in lib/reportMap.js's groupBy). Bumped
        // pageSize so the (now-deduped, ~10-14 row) Unit Types table fits on one page, and the
        // ChargeDesc table shows more before needing Next.
        // KEPT WIDE 21 Jul 2026 (Michael: "financials keep wide across the entire screen") — the one
        // explicit exception to the narrow-everything pass just above; Financials' True Revenue tables
        // stay full width, unlike every other page's tables.
        { title: `True Revenue (${liveScopeLabel})`, live: !!finT?.trueRevenueByDesc?.length, pageSize: 25, wide: true, tip: 'Report: True Revenue custom report, Table1.\nFields: InvoicedThisPeriod, InvoicedTax1ThisPeriod, NetTax1ThisPeriod, TruePeriod, ChargeDesc (ReportID 781861, "Daily Prorate").\nCalculation: Grouped by ChargeDesc (Rent, StoreProtect, fees, etc.), summed. Tax Adj is derived: InvoicedTax1ThisPeriod minus NetTax1ThisPeriod (Tax Invoiced − Net Tax), not a raw column.', columns: revCols, rows: revRows, totals: finT?.trueRevenueByDesc?.length ? revTotals(revRows) : null, totalsPrev: revRowsPrev && revTotals(revRowsPrev), totalsLabel: 'Total' },
        { title: `True Revenue — Unit Types (${liveScopeLabel})`, live: !!finT?.trueRevenueByType?.length, pageSize: 20, wide: true, tip: 'Report: True Revenue custom report, Table1.\nFields: InvoicedThisPeriod, InvoicedTax1ThisPeriod, NetTax1ThisPeriod, TruePeriod, UnitType (ReportID 781861, "Daily Prorate").\nCalculation: Same data as the "True Revenue" table, grouped by UnitType instead of ChargeDesc. Tax Adj is derived: InvoicedTax1ThisPeriod minus NetTax1ThisPeriod, not a raw column.', columns: revCols, rows: revTypeRows, totals: finT?.trueRevenueByType?.length ? revTotals(revTypeRows) : null, totalsPrev: revTypeRowsPrev && revTotals(revTypeRowsPrev), totalsLabel: 'Total' },
      ];
    }

    else if (page === 'ancillaries') {
      // Insurance Roll: live-wired from /api/portfolio's totals (lib/buildPayload.js sums premium/
      // insured/rent/occ across sites first, then divides once — InsuranceRoll report, per-site
      // fields already existed as s.insurance.{premium,insured,penetration}).
      const ancT = liveSites ? computeTotals(liveSites) : null;   // recomputed client-side so the store filter applies
      if (!ancT) debugWarn('[portal-v2] Ancillaries Insurance Roll stat card rendering with mock data (no live totals available).');
      // Every top-row stat card below is computed from `liveSites` (the unscoped /api/portfolio call),
      // which lib/buildPayload.js's buildPayload() builds from the CURRENT in-progress month (recordFor
      // (..., idx[code][cur], true) — see buildPayload.js line ~588), not any previous-month override.
      // FIXED 10 Jul 2026 (exhaustive bug audit): this comment previously claimed a "prevByCode
      // override" made Autobill Conversion/Insurance Conversion/Merchandise Sales compute off the
      // previous COMPLETE month, so monthTag intentionally read liveMonths[length-2] to label them.
      // No such override exists anywhere in buildPayload.js — it was REVERTED on 7 Jul 2026 (see that
      // file's buildPayload() header comment: "Enquiries/Move-ins/Move-outs and the OTHER flow/count
      // metrics... now show the CURRENT in-progress month's own real (partial) data... instead of
      // being silently overridden", applied portfolio-wide, not just to those 3 named metrics). So
      // these 3 cards were showing THIS month's real data mislabeled with LAST month's name (e.g.
      // showing July's partial Autobill/Insurance/Merchandise figures under a "Jun 2026" tag) —
      // confirmed live right now, 10 Jul 2026 being mid-July. Fixed monthTag to read the LAST stored
      // month (the current one), matching what ancT/moveInsSum/merchSalesSum actually are.
      // FIXED AGAIN 10 Jul 2026 (pre-go-live audit): the fix above only covers the DEFAULT view. ancT/
      // moveInsSum/merchSalesSum all derive from `liveSites`, which the global PERIOD selector (6 Jul
      // 2026) swaps to whatever month/range is picked via fetchLiveRange() — but monthTag kept
      // hardcoding the LATEST stored month regardless, so picking any past month or range re-introduces
      // the exact same mislabeling under a more common trigger (just touching the header's period
      // control). Built from monthFrom/monthTo directly instead — mirrors monthLbl/rangeLabel's own
      // formatting (defined later in this function, out of scope here) since those aren't declared yet
      // at this point in buildPage()'s top-to-bottom execution.
      const monthTag = (() => {
        const fmtMonth = (i) => { const [y, m] = monthKeyOf(i).split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'short', year: 'numeric' }); };
        return monthFrom === monthTo ? fmtMonth(monthTo) : fmtMonth(monthFrom) + ' – ' + fmtMonth(monthTo);
      })();
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
      const autobillNewCustomers = liveSites ? liveSites.reduce((a, s) => a + (s.autobillNewTotal || 0), 0) : 0;
      // Autobill Conversion: totals.autobillPC (RentRoll iAutoBillType in [1,2] ÷ all occupied
      // tenants, sum-then-divide) — audited 2 Jul 2026 (npm run audit): the [1,2]="on autobill"
      // assumption checks out cleanly against the live value distribution.
      const autobillCard = ancT
        // FIXED 7 Jul 2026 (exhaustive bug audit): was .toFixed(0) here vs .toFixed(1) on the
        // Dashboard/KPIs copy of this identical metric (line ~1119) — same source field
        // (totals.autobillPC, already rounded to 1dp in computeTotals()), just displayed with one
        // fewer decimal, so the same underlying number showed as e.g. "86%" here vs "86.4%" there.
        ? (autobillNewCustomers
            ? { title: 'Autobill Conversion', live: true, tip: 'Reports: MoveInsAndMoveOuts (move-ins); RentRoll (autobill status).\nFields: TenantID (MoveInsAndMoveOuts); TenantID, iAutoBillType (RentRoll).\nCalculation: New autobilled customers ÷ total new move-ins in the selected period, sampled daily across the month and averaged (autobill_daily table) rather than a single point-in-time read.', tiles: [{ value: (ancT.autobillPC ?? 0).toFixed(1) + '%', label: monthTag, delta: null, dir: null }], hasViz: true, el: <Donut pct={ancT.autobillPC ?? 0} color={C.blue} /> }
            : { title: 'Autobill Conversion', live: true, tip: 'Reports: MoveInsAndMoveOuts (move-ins); RentRoll (autobill status).\nFields: TenantID (MoveInsAndMoveOuts); TenantID, iAutoBillType (RentRoll).\nCalculation: New autobilled customers ÷ total new move-ins in the selected period, sampled daily across the month and averaged (autobill_daily table) rather than a single point-in-time read.\nNote: no new customers exist in the selected store scope/period, so no autobill conversion rate can be derived.', tiles: [{ value: 'N/A', label: monthTag, delta: null, dir: null }], hasViz: true, el: <Donut pct={0} color={C.blue} /> })
        : { title: 'Autobill Conversion', tiles: [{ value: '57%', label: 'Jul 2026', delta: '16%', dir: 'down' }], hasViz: true, el: <Donut pct={57} color={C.blue} /> };
      // Insurance Conversion: new insured customers (insNewCount above) ÷ new move-ins for the month —
      // the standard "did the new customer take out insurance" conversion rate. CORRECTED 6 Jul 2026:
      // previously read 873% (!) using mg.insured_moveins/ia.new_policies as the numerator — confirmed
      // wrong (ManagementSummary's "Insurance" activity row is not scoped to new move-ins specifically,
      // it's some larger/different count).
      // CORRECTION 9 Jul 2026 (exhaustive sweep + "sort out the bug"): the line removed above claimed
      // "insNewCount is real cross-referenced data, can never exceed moveInsSum" — that's false, and
      // saying so is what let this go unnoticed. insNewCount is NOT TenantID-cross-referenced against
      // moveInsSum at all — see reportMap.js's insurance_roll comment: InsuranceRoll has no TenantID
      // column (confirmed via probe:insurance-roll-columns) and its LedgerID doesn't overlap with
      // MoveInsAndMoveOuts' TenantIDs either (confirmed via check:merch-insurance-live) — both
      // cross-reference attempts were dead ends. insNewCount is instead just InsuranceRoll's own rows
      // filtered by `iActive` and `dMovedIn` falling in this period's window — a totally independent
      // proxy for "new customer this month" from a different report, with no shared key to moveInsSum
      // (MoveInsAndMoveOuts' move-in count). Nothing mathematically guarantees insNewCount ≤ moveInsSum;
      // confirmed live at 7/29 sites this period (e.g. Bicester 120%, Mitcham 125%) where the two
      // reports simply disagree on which individual customers are "new" even though each total can be
      // correct on its own terms. Not fixable by better arithmetic — would need SiteLink to expose a
      // real per-tenant key on InsuranceRoll, which it doesn't. Clamping at 100% below: a conversion
      // rate over 100% is never a meaningful answer, so treat any overshoot as "~everyone insured"
      // rather than show a nonsensical number. insNewCount itself is left un-clamped — Insurance
      // Premiums (New Customers) further down divides it into insNewPremium/insNewCoverage, which need
      // to stay internally consistent with each other, not with moveInsSum.
      const insConvPct = liveSites && moveInsSum ? Math.min(100, +(insNewCount / moveInsSum * 100).toFixed(0)) : null;
      const insuranceConvCard = insConvPct != null
        ? { title: 'Insurance Conversion', live: true, tip: 'Reports: InsuranceRoll (new insured customers); MoveInsAndMoveOuts (new move-ins).\nFields: iActive, dMovedIn (InsuranceRoll); MoveIn (MoveInsAndMoveOuts).\nCalculation: Insured new customers (active policies where dMovedIn falls in the period) ÷ new move-ins × 100, capped at 100%.\nNote: the two reports define "new" independently, so this can occasionally read high before capping.', tiles: [{ value: insConvPct + '%', label: monthTag, delta: null, dir: null }], hasViz: true, el: <Gauge pct={insConvPct} /> }
        : liveSites
          ? { title: 'Insurance Conversion', live: true, tip: 'Reports: InsuranceRoll (new insured customers); MoveInsAndMoveOuts (new move-ins).\nFields: iActive, dMovedIn (InsuranceRoll); MoveIn (MoveInsAndMoveOuts).\nCalculation: Insured new customers (active policies where dMovedIn falls in the period) ÷ new move-ins × 100, capped at 100%.\nNote: no move-ins exist in the selected store scope/period, so no conversion rate can be derived.', tiles: [{ value: 'N/A', label: monthTag, delta: null, dir: null }], hasViz: true, el: <Gauge pct={0} /> }
        : { title: 'Insurance Conversion', tiles: [{ value: '57%', label: 'Jul 2026', delta: '7%', dir: 'up' }], hasViz: true, el: <Gauge pct={57} /> };
      const insuranceRollCard = ancT
        ? { title: 'Insurance Roll', live: true, tip: `Reports: InsuranceRoll (premiums, insured); RentRoll (rent roll); OccupancyStatistics (occupied units).\nFields: dcPremium, iActive (InsuranceRoll); dcRent, bRented (RentRoll); Occupied, TotalUnits (OccupancyStatistics).\nCalculation: Premiums = Σ dcPremium (active policies). % Rent Roll = premiums ÷ rent roll × 100. % Insured = insured units ÷ occupied units × 100.${ancT.rent ? '' : '\nNote: no rent roll exists in the selected store scope, so % Rent Roll cannot be derived.'}${ancT.occ ? '' : '\nNote: no occupied units exist in the selected store scope, so % Insured cannot be derived.'}`, tiles: [{ value: money(ancT.insurancePremium ?? 0), label: 'Premiums', delta: null, dir: null }, { value: ancT.rent ? (ancT.insurancePctRoll ?? 0).toFixed(1) + '%' : 'N/A', label: '% Rent Roll', delta: null, dir: null }, { value: ancT.occ ? (ancT.insurancePctInsured ?? 0).toFixed(1) + '%' : 'N/A', label: '% Insured', delta: null, dir: null }] }
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
        ? { title: 'Insurance Premiums (New Customers)', live: true, tip: 'Reports: InsuranceRoll (new insured customers); MoveInsAndMoveOuts (move-ins).\nFields: iActive, dMovedIn, dcCoverage, dcPremium (InsuranceRoll); MoveIn (MoveInsAndMoveOuts).\nCalculation: Contents avg = Σ dcCoverage ÷ count of new insured customers (active policies with dMovedIn in the period). Premiums weekly = (Σ dcPremium on new insured customers ÷ all move-ins this period) ÷ 4.', tiles: [{ value: money(insNewCoverage / insNewCount), label: 'Contents avg', delta: null, dir: null }, { value: '£' + (avgNewPremiumPerMoveIn / 4).toFixed(2), label: 'Premiums weekly', delta: null, dir: null }] }
        : liveSites
          ? { title: 'Insurance Premiums (New Customers)', live: true, tip: 'Reports: InsuranceRoll (new insured customers); MoveInsAndMoveOuts (move-ins).\nFields: iActive, dMovedIn, dcCoverage, dcPremium (InsuranceRoll); MoveIn (MoveInsAndMoveOuts).\nCalculation: Contents avg = Σ dcCoverage ÷ count of new insured customers (active policies with dMovedIn in the period). Premiums weekly = (Σ dcPremium on new insured customers ÷ all move-ins this period) ÷ 4.\nNote: no new insured customers exist in the selected store scope/period, so Contents avg cannot be derived. Premiums weekly is zero only if move-ins exist but none took insurance.', tiles: [{ value: 'N/A', label: 'Contents avg', delta: null, dir: null }, { value: moveInsSum ? '£0.00' : 'N/A', label: 'Premiums weekly', delta: null, dir: null }] }
        // FIXED 10 Jul 2026 (audit): "Contents avg" is a per-new-customer AVERAGE (insNewCoverage /
        // insNewCount on the live path, never scaled by store count), not a portfolio total — was
        // incorrectly scaled by the store-filter factor `f` here, unlike its own sibling tile
        // ("Premiums weekly", a fixed £7.68) and the equivalent average on Merchandise Income per New
        // Customer just below, both of which correctly leave the average unscaled.
        : { title: 'Insurance Premiums (New Customers)', tiles: [{ value: money(8294), label: 'Contents avg', delta: '£516', dir: 'up' }, { value: '£7.68', label: 'Premiums weekly', delta: '£0.09', dir: 'up' }] };
      // Merchandise Income per New Customer — REVERTED 21 Jul 2026 (Rich's portal review, task #361:
      // "Merchandise sales/new customer *NOT occupied unit"). CHANGED 15 Jul 2026 (task #230) had
      // switched the denominator to Total Occupied Units because dividing by this month's move-ins
      // landed at £9.12 vs a legacy figure of £1.12 (and scoping the numerator to just new-move-in
      // tenants' own purchases still landed at £7.51) — neither matched legacy's mystery number, so
      // occupied-units was picked as a closer-order-of-magnitude approximation using only validated
      // data. Rich's explicit, direct correction overrides that "match legacy" heuristic: the
      // intended metric IS merchandise sales ÷ new customers, full stop, regardless of how it
      // compares to legacy's unexplained figure (which was never fully reverse-engineered — see the
      // task #230 history above/in git log for the two approaches tried and ruled out). Reverted to
      // the original ALL-merchandise-sales ÷ THIS PERIOD'S move-ins formula (moveInsSum, already
      // computed above for the Insurance Premiums card) and restored the "New Customer" naming.
      const merchPerNewCust = (liveSites && moveInsSum) ? { title: 'Merchandise Income per New Customer', live: true, tip: 'Reports: FinancialSummary (POS charges); MoveInsAndMoveOuts (move-ins).\nFields: Charge, sChgCategory="POS" (FinancialSummary); MoveIn (MoveInsAndMoveOuts).\nCalculation: Σ Charge (POS category, all customers) ÷ Σ move-ins this period.\nNote: per Rich (21 Jul 2026) this is deliberately ALL merchandise revenue over new-customer count, not scoped to occupied units or to new customers\' own purchases only.', tiles: [{ value: '£' + (merchSalesSum / moveInsSum).toFixed(2), label: 'Income per new customer', delta: null, dir: null }] }
        : liveSites ? { title: 'Merchandise Income per New Customer', live: true, tip: 'Reports: FinancialSummary (POS charges); MoveInsAndMoveOuts (move-ins).\nFields: Charge, sChgCategory="POS" (FinancialSummary); MoveIn (MoveInsAndMoveOuts).\nCalculation: Σ Charge (POS category, all customers) ÷ Σ move-ins this period.\nNote: no move-ins exist in the selected store scope/period, so no per-new-customer value can be derived.', tiles: [{ value: 'N/A', label: 'Income per new customer', delta: null, dir: null }] }
        : { title: 'Merchandise Income per New Customer', tiles: [{ value: '£9.12', label: 'Income per new customer', delta: '£0.60', dir: 'down' }] };
      const merchSalesCard = liveSites
        ? { title: 'Merchandise Sales', live: true, tip: 'Report: FinancialSummary.\nFields: Charge, sChgCategory="POS".\nCalculation: Σ Charge where sChgCategory = "POS", across the current store scope for the selected period.', tiles: [{ value: money(merchSalesSum), label: monthTag, delta: null, dir: null }] }
        : { title: 'Merchandise Sales', tiles: [{ value: money(209 * f), label: 'May 2026', delta: '£21', dir: 'up' }] };
      out.statCards = [autobillCard, insuranceConvCard, insuranceRollCard, insPremNewCard, merchPerNewCust, merchSalesCard];
      // Insurance Roll by Store: live-wired per-site comparison bars (same portfolio-comparison
      // pattern as the dashboard, per Michael 2 Jul 2026 — store-vs-store, not a trend line).
      const liveInsBars = liveSites ? liveSites
        .filter((s) => (s.occ || 0) > 0)
        .map((s) => {
          const penetration = (s.insurance && s.insurance.penetration) || 0;
          return { label: s.name, value: penetration, disp: penetration.toFixed(1) + '%', color: penetration >= 70 ? C.green : penetration >= 50 ? C.amber : C.red };
        }) : null;
      if (!liveInsBars || !liveInsBars.length) {
        if (liveSites) debugWarn('[portal-v2] Insurance Roll chart has no stores with occupied units in the selected store scope.');
        else debugWarn('[portal-v2] Insurance Roll chart rendering with mock data (no live sites available).');
      }
      // Pinned "Average" bar (legacy parity): portfolio % insured = Σ insured units ÷ Σ occupied
      // units (ancT.insurancePctInsured, sum-then-divide) on the live path; mean of mock values otherwise.
      const insBarItems = (liveInsBars && liveInsBars.length) ? liveInsBars : fs.map((s) => ({ label: s.name, value: +(68 + (s.occupied % 22)).toFixed(1), disp: (+(68 + (s.occupied % 22)).toFixed(1)) + '%', color: C.blue }));
      const avgInsured = ancT ? (ancT.insurancePctInsured ?? 0) : (insBarItems.length ? insBarItems.reduce((a, b) => a + b.value, 0) / insBarItems.length : 0);
      out.chartCards = [
        {
          title: 'Insurance % Insured by Store',
          tip: 'Reports: InsuranceRoll (insured); OccupancyStatistics (occupied units).\nFields: iActive (InsuranceRoll); Occupied (OccupancyStatistics).\nCalculation: Insured units ÷ occupied units × 100 per store. Portfolio bar = sum-then-divide across the shown store scope. Stores with no occupied units are excluded because no penetration rate can be derived for them.',
          el: (liveInsBars && !liveInsBars.length)
            ? <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>No stores with occupied units exist in the selected store scope.</div>
            : <StoreBarChart items={insBarItems} opts={{ average: { label: 'Portfolio', value: avgInsured, disp: avgInsured.toFixed(1) + '%' } }} />,
        },
      ];
      // Insurance Roll (All Stores) table: live-wired from s.insurance (premium/insured/penetration)
      // and s.rent (already computed elsewhere) for the % Rent Roll column.
      const liveInsRows = liveSites ? liveSites.map((s) => {
        const ins = s.insurance || {};
        return {
          name: s.name,
          premiums: ins.premium || 0,
          pctRoll: s.rent ? +((ins.premium || 0) / s.rent * 100).toFixed(1) : null,
          insured: ins.insured || 0,
          pctInsured: s.occ ? (ins.penetration || 0) : null,
        };
      }) : null;
      if (!liveInsRows) debugWarn('[portal-v2] Insurance Roll table rendering with mock RAW_STORES data (no live sites available).');
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
          pctRoll: ancT ? (ancT.rent ? (ancT.insurancePctRoll ?? 0) : null) : (insRowsAll.length ? +(insRowsAll.reduce((a, r) => a + ((r.pctRoll != null) ? r.pctRoll : 0), 0) / insRowsAll.length).toFixed(1) : 0),
          pctInsured: ancT ? (ancT.occ ? (ancT.insurancePctInsured ?? 0) : null) : (insRowsAll.length ? +(insRowsAll.reduce((a, r) => a + ((r.pctInsured != null) ? r.pctInsured : 0), 0) / insRowsAll.length).toFixed(1) : 0),
        };
      })();
      // "vs last month" totals-row delta (task #121, added 10 Jul 2026) — same livePrevSites snapshot
      // pattern used on Dashboard/Financials. s.insurance.{premium,insured} is set outside recordFor()'s
      // `if(full)` gate (see lib/buildPayload.js), so it's present on the light livePrevSites records too.
      const ancTPrev = livePrevSites ? computeTotals(livePrevSites) : null;
      const insTotalsPrev = (ancT && ancTPrev) ? {
        premiums: livePrevSites.reduce((a, s) => a + ((s.insurance && s.insurance.premium) || 0), 0),
        insured: livePrevSites.reduce((a, s) => a + ((s.insurance && s.insurance.insured) || 0), 0),
        pctRoll: ancTPrev.rent ? (ancTPrev.insurancePctRoll ?? 0) : null,
        pctInsured: ancTPrev.occ ? (ancTPrev.insurancePctInsured ?? 0) : null,
      } : null;
      out.tables.push({
        // NARROWED 21 Jul 2026 — only table on this page, so it just renders narrower with empty
        // space alongside rather than pairing with another table.
        title: `Insurance Roll (${liveScopeLabel})`, live: !!liveInsRows, pageSize: 12, totals: insTotals, totalsPrev: insTotalsPrev, totalsLabel: 'Total',
        tip: 'Reports: InsuranceRoll (premium, insured); RentRoll (rent); OccupancyStatistics (occupied units).\nFields: dcPremium, iActive (InsuranceRoll); dcRent, bRented (RentRoll); Occupied (OccupancyStatistics).\nCalculation: % Rent Roll = premiums ÷ rent × 100. % Insured = insured ÷ occupied units × 100. Totals row is sum-then-divide.',
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
        enquiriesByChannel = { title: 'Enquiries by Channel', live: true, tip: 'Report: InquiryTracking.\nFields: sInquiryType, dPlaced.\nCalculation: Counts where sInquiryType matches and dPlaced falls in the selected period, summed across sites. The displayed Web and Total counts follow the live legacy Marketing page and exclude EMail.', tiles: [
          { value: intFmt(enqSum('phone')), label: 'Phone', delta: null, dir: null },
          { value: intFmt(enqSum('walkin')), label: 'Walk-ins', delta: null, dir: null },
          { value: intFmt(liveSites.reduce((a, s) => a + enquiryWebVisible(s.enquiries), 0)), label: 'Web', delta: null, dir: null },
          { value: intFmt(liveSites.reduce((a, s) => a + enquiryTotalVisible(s.enquiries), 0)), label: 'Visible Total', delta: null, dir: null },
        ] };
        // CORRECTED 6 Jul 2026: was reading `conversions` (Enquiry -> Move-In, a different metric
        // entirely — see buildPayload.js) despite the "Reservation" title. Now uses
        // `reservationConversions`, the actual Enquiry -> Reservation figure.
        const totalEnq = liveSites.reduce((a, s) => a + enquiryVisibleConversionBase(s.enquiries), 0);
        const totalConverted = liveSites.reduce((a, s) => a + enquiryVisibleConversionNumerator(s.enquiries), 0);
        const convPct = totalEnq ? +(totalConverted / totalEnq * 100).toFixed(1) : null;
        // FIXED 10 Jul 2026 (audit): missing `live: true` — sibling card enquiriesByChannel two lines
        // up has it, this one never did, so this card never showed the green LIVE badge even while
        // displaying genuine live data (statCards.map()'s `live: !!c.live` had nothing to read).
        // REBUILT 17 Jul 2026 (task #310): dropped per-lead cohort-matching entirely (email hash, then
        // phone added task #301, then a same/previous-month lookback window added task #303 — several
        // iterations 6-17 Jul trying to trace one lead from its enquiry row to a later reservation
        // row). Michael pinned down legacy's real June 2026 portfolio rate at 19.8% (confirmed live on
        // the legacy portal) — no cohort-matched version got anywhere close (low single digits to
        // ~10%), but a plain COUNT RATIO does (reservation-stage rows this period ÷ enquiries this
        // period). So legacy isn't tracking individual leads here at all — same "sum two aggregates,
        // divide once" pattern as the Enquiry -> Move-In tile. Also fixes the live/in-progress month
        // always reading artificially low, since a period-ratio needs no cross-month data to exist yet.
        enquiryToReservation = convPct != null
          ? { title: 'Enquiry → Reservation', live: true, tip: 'Report: InquiryTracking.\nFields: sInquiryType, iInquiryConvertedToLease, dPlaced.\nCalculation: visible converted enquiries ÷ visible enquiries for the selected period, using the same Phone/Web/Walk-in rows shown on the legacy Marketing page (Email excluded from the displayed Marketing conversion basis).', tiles: [{ value: convPct + '%', label: 'Conversion rate', delta: null, dir: null }], hasViz: true, el: <Gauge pct={convPct} /> }
          : { title: 'Enquiry → Reservation', live: true, tip: 'Report: InquiryTracking.\nFields: sInquiryType, iInquiryConvertedToLease, dPlaced.\nCalculation: visible converted enquiries ÷ visible enquiries for the selected period, using the same Phone/Web/Walk-in rows shown on the legacy Marketing page (Email excluded from the displayed Marketing conversion basis).\nNote: no visible enquiries exist in the selected store scope/period, so no conversion rate can be derived.', tiles: [{ value: 'N/A', label: 'Conversion rate', delta: null, dir: null }], hasViz: true, el: <Gauge pct={0} /> };
      } else {
        debugWarn('[portal-v2] Marketing Enquiries widgets rendering with mock RAW_STORES data (no live sites available).');
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
      // FIXED 23 Jul 2026 (production-readiness audit): this chart used to compare
      // `activeReservations` (ReservationList live backlog snapshot, "open right now") against
      // `moveIns` (ManagementSummary period flow, "completed during the selected month/range"). That
      // mixed two different time bases inside one visual, so the Reservations bar could stay frozen on
      // a past-month selection while Move-ins changed with the picker. We already carry the correct
      // period-scoped reservation-flow metric (`reservationsMade`, from InquiryTracking reservation-
      // stage rows within the selected window) specifically for historical/date-aware comparisons.
      // Use that here so both bars respect the same selected period.
      const resVsMoveIns = liveSites ? { res: liveSites.reduce((a, s) => a + (s.reservationsMade || 0), 0), mi: liveSites.reduce((a, s) => a + (s.moveIns || 0), 0) } : null;
      if (!resVsMoveIns) debugWarn('[portal-v2] Reservations Made vs Move-ins chart rendering with mock data (no live sites available).');
      out.chartCards = [
        resVsMoveIns
          ? { title: 'Reservations Made vs Move-ins', tip: 'Reports: InquiryTracking (Reservations made); ManagementSummary (Move-ins).\nFields: sRentalType = "Reservation", dPlaced (InquiryTracking); sDesc rows matching "Move In", iMCount (ManagementSummary).\nCalculation: Reservations = reservation-stage InquiryTracking rows whose dPlaced falls in the selected period. Move-ins = completed move-ins in the same selected period. Both bars are date-scoped flow counts, not a live backlog snapshot or a conversion rate.', el: <VBars items={[{ label: 'Reservations', value: resVsMoveIns.res, disp: intFmt(resVsMoveIns.res), color: C.blue }, { label: 'Move-ins', value: resVsMoveIns.mi, disp: intFmt(resVsMoveIns.mi), color: C.teal }]} opts={{ max: Math.max(resVsMoveIns.res, resVsMoveIns.mi) * 1.15 }} /> }
          : { title: 'Reservations Made vs Move-ins', el: <VBars items={[{ label: 'Reservations', value: 52 * f, disp: intFmt(52 * f), color: C.blue }, { label: 'Move-ins', value: 112 * f, disp: intFmt(112 * f), color: C.teal }]} opts={{ max: 130 * f }} /> },
      ];
      // Marketing Year-on-Year (task #130/#136, 13 Jul 2026 — Michael picked "YoY trend chart" via
      // AskUserQuestion) — trailing 12 months ending at the latest STORED month, overlaid against the
      // same 12 calendar months one year earlier (dashed line), for total Enquiries and Enquiry ->
      // Reservation conversion %. Deliberately keyed off the latest stored month rather than the
      // PERIOD selector's own from/to — a YoY trend is inherently "last 12 months vs the 12 before
      // that" regardless of which single month/range happens to be selected elsewhere on this page
      // (same reasoning as Customer Churn's trailing h12 on the KPIs page). Reads liveHistory (the
      // full unscoped stored history, already fetched for Month-on-Month/Customer Churn) rather than a
      // new API call — lead_funnel has ~10 years of backfilled history (task #185), so a same-month-
      // last-year match almost always exists; guarded with the sortedKeys/haveLastYear check below
      // rather than assumed.
      const yoySeries = (() => {
        if (!liveMonthly) return null;
        const sortedKeys = Object.keys(liveMonthly).sort(); // 'YYYY-MM-01' strings sort chronologically as-is
        if (sortedKeys.length < 13) return null;
        const latest = sortedKeys[sortedKeys.length - 1];
        const [ly, lm] = latest.split('-').map(Number);
        const thisYearMonths = [];
        for (let i = 11; i >= 0; i--) {
          const d = new Date(ly, lm - 1 - i, 1);
          thisYearMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`);
        }
        const lastYearMonths = thisYearMonths.map((mk) => { const [y, m] = mk.split('-').map(Number); return `${y - 1}-${String(m).padStart(2, '0')}-01`; });
        if (!lastYearMonths.every((mk) => liveMonthly[mk])) return null;
        const scopedMonthlyRows = (mk) => {
          const rows = liveMonthly[mk] || [];
          return pageHasSelectedStores ? rows.filter((r) => pageSelectedNames.has(r.name)) : rows;
        };
        const monthlyVisibleCounts = (mk) => {
          const rows = scopedMonthlyRows(mk);
          const enquiries = rows.reduce((a, r) => a + enquiryTotalVisible(r.enquiries), 0);
          const convBase = rows.reduce((a, r) => a + enquiryVisibleConversionBase(r.enquiries), 0);
          const converted = rows.reduce((a, r) => a + enquiryVisibleConversionNumerator(r.enquiries), 0);
          return {
            enquiries,
            convPct: convBase ? +(converted / convBase * 100).toFixed(1) : null,
          };
        };
        const thisYearCounts = thisYearMonths.map(monthlyVisibleCounts);
        const lastYearCounts = lastYearMonths.map(monthlyVisibleCounts);
        return {
          labels: thisYearMonths.map((mk) => { const [y, m] = mk.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'short' }) + " '" + String(y).slice(2); }),
          enqThis: thisYearCounts.map((r) => r.enquiries), enqLast: lastYearCounts.map((r) => r.enquiries),
          convThis: thisYearCounts.map((r) => r.convPct), convLast: lastYearCounts.map((r) => r.convPct),
        };
      })();
      const yoyConversionRenderable = !!(yoySeries && !yoySeries.convThis.some((v) => v == null) && !yoySeries.convLast.some((v) => v == null));
      const haveSomeLiveHistory = !!(liveMonthly && Object.keys(liveMonthly).length);
      if (!yoySeries) {
        if (haveSomeLiveHistory) debugWarn('[portal-v2] Marketing YoY charts unavailable for this scope — insufficient stored history for a same-month-last-year comparison.');
        else debugWarn('[portal-v2] Marketing YoY charts rendering with mock data (need >=13 months of stored history with a same-month-last-year match — run npm run backfill if this persists).');
      } else if (!yoyConversionRenderable) {
        debugWarn('[portal-v2] Marketing YoY conversion chart unavailable for this scope — at least one compared month has no visible enquiry base, so a truthful conversion line cannot be drawn.');
      }
      out.chartCards.push(
        yoySeries
          ? { title: 'Enquiries — Year on Year', tip: 'Report: InquiryTracking.\nFields: sInquiryType, dPlaced.\nCalculation: Total visible enquiries per stored month (sum of Phone/Walk-in/Web counts; Email excluded to match the displayed legacy Marketing basis). Solid = trailing 12 months; dashed = same 12 months a year earlier.', el: <LineChart series={[{ name: 'This year', color: C.blue, values: yoySeries.enqThis }, { name: 'Last year', color: C.blue, dashed: true, values: yoySeries.enqLast }]} opts={{ labels: yoySeries.labels, zero: true }} />, wide: true }
          : haveSomeLiveHistory
            ? { title: 'Enquiries — Year on Year', el: <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>Not enough stored history yet for a year-on-year comparison.</div>, wide: true }
            : { title: 'Enquiries — Year on Year', el: <LineChart series={[{ name: 'This year', color: C.blue, values: seq(1300 * f, 14 * f, 60 * f, 12) }, { name: 'Last year', color: C.blue, dashed: true, values: seq(1150 * f, 12 * f, 55 * f, 12) }]} opts={{ labels: momLabels(), zero: true }} />, wide: true },
        yoySeries && yoyConversionRenderable
          ? { title: 'Enquiry → Reservation Conversion — Year on Year', tip: 'Report: InquiryTracking.\nFields: sInquiryType, iInquiryConvertedToLease, dPlaced.\nCalculation: visible converted enquiries ÷ visible enquiries for each stored month, using the same Phone/Web/Walk-in basis shown on the legacy Marketing page (Email excluded from the displayed Marketing conversion basis). Solid = trailing 12 months; dashed = same 12 months a year earlier.', el: <LineChart series={[{ name: 'This year', color: C.teal, values: yoySeries.convThis }, { name: 'Last year', color: C.teal, dashed: true, values: yoySeries.convLast }]} opts={{ labels: yoySeries.labels }} />, wide: true }
          : yoySeries
            ? { title: 'Enquiry → Reservation Conversion — Year on Year', el: <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>At least one compared month has no visible enquiries, so a truthful year-on-year conversion line cannot be drawn.</div>, wide: true }
            : haveSomeLiveHistory
              ? { title: 'Enquiry → Reservation Conversion — Year on Year', el: <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>Not enough stored history yet for a year-on-year comparison.</div>, wide: true }
              : { title: 'Enquiry → Reservation Conversion — Year on Year', el: <LineChart series={[{ name: 'This year', color: C.teal, values: seq(36, 0.3, 3, 12) }, { name: 'Last year', color: C.teal, dashed: true, values: seq(33, 0.3, 3, 12) }]} opts={{ labels: momLabels() }} />, wide: true },
      );
      // Leads by Store: live-wired from each site's `enquiries` object — same authoritative source
      // (lib/reportMap.js's lead_funnel/InquiryTracking parser, locked spec Michael 1 Jul 2026) as
      // the Enquiries by Channel / Enquiry -> Reservation cards above, just per-store instead of
      // summed across the portfolio. No region field on live data (same gap as every other live
      // table on this page), so that column is dropped for live rows.
      const liveLeadRows = liveSites ? liveSites.map((s) => {
        const e = s.enquiries || {};
        const total = enquiryTotalVisible(e);
        const convBase = enquiryVisibleConversionBase(e);
        const converted = enquiryVisibleConversionNumerator(e);
        return { name: s.name, phone: e.phone || 0, web: enquiryWebVisible(e), walkin: e.walkin || 0, total, conv: convBase ? +(converted / convBase * 100).toFixed(1) : null };
      }) : null;
      if (!liveLeadRows) debugWarn('[portal-v2] Leads by Store table rendering with mock RAW_STORES data (no live sites available).');
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
        const conv = enqSum ? (() => {
          const totalBase = liveSites.reduce((a, s) => a + enquiryVisibleConversionBase(s.enquiries), 0);
          const totalConverted = liveSites.reduce((a, s) => a + enquiryVisibleConversionNumerator(s.enquiries), 0);
          return totalBase ? +((totalConverted / totalBase) * 100).toFixed(1) : null;
        })() : (total ? +(leadRowsAll.reduce((a, r) => a + ((r.conv != null ? r.conv : 0) * (r.total || 0)), 0) / total).toFixed(1) : null);
        return { phone, web, walkin, total, conv };
      })();
      // "vs last month" totals-row delta (task #121, added 10 Jul 2026) — same enqSum() pattern, just
      // over livePrevSites instead of liveSites. s.enquiries is set outside recordFor()'s `if(full)`
      // gate (it's a flow metric, see lib/buildPayload.js), so it's present on livePrevSites too.
      const enqSumPrev = livePrevSites ? (k) => livePrevSites.reduce((a, s) => a + ((s.enquiries && s.enquiries[k]) || 0), 0) : null;
      const leadTotalsPrev = (liveLeadRows && enqSumPrev) ? (() => {
        const totalBase = livePrevSites.reduce((a, s) => a + enquiryVisibleConversionBase(s.enquiries), 0);
        const totalConverted = livePrevSites.reduce((a, s) => a + enquiryVisibleConversionNumerator(s.enquiries), 0);
        return {
          phone: enqSumPrev('phone'), web: livePrevSites.reduce((a, s) => a + enquiryWebVisible(s.enquiries), 0), walkin: enqSumPrev('walkin'), total: livePrevSites.reduce((a, s) => a + enquiryTotalVisible(s.enquiries), 0),
          conv: totalBase ? +((totalConverted / totalBase) * 100).toFixed(1) : null,
        };
      })() : null;
      // Tooltip FIXED 21 Jul 2026 (full portal audit) — still described the old per-lead email-
      // matching conversion methodology, which was fully removed 17 Jul 2026 (task #310) in favor of
      // a plain period-ratio. The sibling "Enquiry → Reservation" card's tooltip two blocks up was
      // updated when that change landed; this table's tip was simply missed. conv is the same visible
      // Phone/Web/Walk-in period-ratio the Marketing KPI above uses, excluding Email from the legacy-
      // parity displayed basis.
      out.tables.push({
        // NARROWED 21 Jul 2026 — only table on this page, renders narrower rather than edge to edge.
        title: `Leads by Store (${liveScopeLabel})`, live: !!liveLeadRows, pageSize: 12, totals: leadTotals, totalsPrev: leadTotalsPrev, totalsLabel: 'Total',
        tip: 'Report: InquiryTracking.\nFields: sInquiryType, iInquiryConvertedToLease, dPlaced.\nCalculation: Inquiry counts by visible channel per site. Conversion % = visible converted enquiries ÷ visible enquiries for that site and period, using the same Phone/Web/Walk-in basis shown on the legacy Marketing page (Email excluded from the displayed Marketing conversion basis). Totals row is sum-then-divide.',
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
      const scopedOk = !!(scopedHistory && scopedHistory.length >= 1);
      // FIXED AGAIN 22 Jul 2026 (Michael: "still show startin in sept 2020 not the current month,
      // when 1m is selected"). The earlier fallback to full history solved the old fake-mock-data
      // problem, but it still meant a single selected month (<2 points) snapped back to the whole
      // stored history for 5 of the 6 MoM charts. LineChart no longer needs >=2 points here
      // (xFor() already guards len-1 with Math.max(..., 1)), so a genuine one-point selected-month
      // chart is preferable to showing unrelated years of history. Keep the full-history fallback
      // only for the true "no scoped history at all" case now.
      const haveAnyLiveHistory = !!(liveHistory && liveHistory.length >= 1);
      const scopedMissingHistory = haveAnyLiveHistory && !scopedOk;
      const liveHist = scopedOk ? scopedHistory : null;
      if (!haveAnyLiveHistory) debugWarn('[portal-v2] Month-on-Month charts rendering with mock data (no stored history at all yet — run npm run pull a few more times, or npm run backfill).');
      else if (scopedMissingHistory) debugWarn('[portal-v2] Month-on-Month: selected period has no stored history yet.');
      // FIXED 15 Jul 2026 (pre-go-live audit finding): this used to be appended straight onto the
      // visible chart TITLE ('(full history — selected period too narrow)'), which meant every user
      // saw a debug-sounding string in all-caps (titles render text-transform:uppercase) on every one
      // of these 6 charts on every page load, since the default '1M' period is <2 months by
      // definition. debugWarn above already covers the developer-facing signal; the user-facing note
      // now lives only in the tooltip (tip), worded plainly, not shouted in the header.
      const momTip = scopedMissingHistory ? '\nNo stored history exists for the selected period yet.' : '';
      const hLabels = liveHist ? liveHist.map((h) => { const [y, m] = h.month.split('-'); return new Date(+y, +m - 1, 1).toLocaleString('en-GB', { month: 'short' }) + " '" + y.slice(2); }) : L;
      // FIXED 21 Jul 2026 (Rich's portal review, task #352): Rich — "Month on month: Revenue collected
      // - what is the intention here? I have selected 1 store and still see portfolio numbers in
      // this." At the time, `liveHistory` (one portfolio-wide total per stored month — see
      // lib/buildPayload.js's buildHistory()) looked like the only history available, so a store
      // filter genuinely had nothing per-site to select from, and this was flagged to Michael as a
      // real schema/backfill project (new per-site-per-month table, cron changes, a backfill-depth
      // decision) — out of scope before cutover.
      // CORRECTED 21 Jul 2026 (Michael: "the mom page should show portfolio wide graphs as default,
      // but if i click on the individual store or stores it should show the lines for those
      // individual stores... all overlaid and easily comparable"): that "needs new infra" call was
      // wrong. Re-read lib/buildPayload.js's buildPayload() end to end before writing anything this
      // time — `monthly` (portfolio.monthly, fetched into this page's `liveMonthly` state since the
      // very first version of the global range selector, task #50, but never once READ anywhere on
      // this page until now) is already a LIGHT per-site record for EVERY stored month, built by the
      // exact same recordFor() as the full-detail `sites[]` array. `full` only gates recordFor()'s
      // HEAVY per-unit arrays (unit mix, channels) — the plain scalar fields every one of these 6
      // charts needs (rent, occA, ss.occA, ssRate, revenue.collected, insurancePremiumSum) are computed
      // unconditionally. So true per-site MoM history already existed in the payload, sitting unused —
      // this was a wiring gap, not a missing backend capability. momSeriesFor() below reads it.
      const momAnySel = pageHasSelectedStores;
      // momFilterNote — NARROWED 21 Jul 2026: used to fire for ANY active filter (region or store),
      // since neither reached trend history. Individual store selection now genuinely works (see
      // momSeriesFor below), so the only real gap left is region-ONLY filtering — liveMonthly's
      // per-site records carry no region field (same disclosed gap as every other live per-site widget
      // on this page), so picking a region without checking a specific store still can't scope these
      // charts.
      // Once live data is loaded, region filtering is intentionally unavailable (no authoritative
      // region field on the live records yet). Ignore any stale region state here too, otherwise the
      // MoM page can warn about a "region filter" that the live charts are not actually applying.
      const momFilterNote = (effectiveRegion !== 'All' && !momAnySel)
        ? 'Region filter doesn\'t reach trend history yet — select individual store(s) above (not just a region) to see their lines here.'
        : null;
      // momSelectedSites — the {code,name} pairs for whichever stores are checked, sorted by code
      // (matching this page's other per-site orderings). Null when none are checked, so every chart's
      // normal single portfolio-wide line is completely unaffected by this feature by default, exactly
      // as Michael asked ("portfolio wide graphs as default").
      const momSelectedCodes = (momAnySel && liveSites) ? new Set(liveSites.map((s) => s.code)) : null;
      const momSelectedSites = (momSelectedCodes && liveSitesRaw)
        ? liveSitesRaw.filter((s) => momSelectedCodes.has(s.code)).sort((a, b) => a.code.localeCompare(b.code))
        : null;
      // A small, distinct palette for overlaid per-store lines — cycles if more stores are selected
      // than colors (the store picker is a checkbox list, not built for dozens at once in practice).
      const momPalette = ['#2757E8', '#12B76A', '#F79009', '#EE46BC', '#7A5AF8', '#0E9384', '#D92D20', '#667085'];
      // momSeriesFor(getter) — builds one LineChart series per selected store from liveMonthly,
      // reading getter(record) off each site's record for each month liveHist itself is charting (so a
      // per-store overlay always covers exactly the same months/range the portfolio line would).
      // Returns null ("no override, use the normal single portfolio-wide series") when no store is
      // selected or liveMonthly hasn't loaded yet — every call site below falls back to its original
      // single-series portfolio line in that case, unchanged from before this feature existed.
      const momSeriesFor = (getter) => {
        if (!momSelectedSites || !momSelectedSites.length || !liveMonthly) return null;
        const monthKeys = (liveHist || []).map((h) => h.month);
        const series = momSelectedSites.map((s, i) => {
          const values = monthKeys.map((mk) => {
            const rec = (liveMonthly[mk] || []).find((r) => r.code === s.code);
            const value = rec ? getter(rec) : null;
            return Number.isFinite(value) ? value : null;
          });
          return Number.isFinite(values[0]) && values.every((v) => Number.isFinite(v))
            ? { name: s.name, color: momPalette[i % momPalette.length], values }
            : null;
        }).filter(Boolean);
        return series.length ? series : null;
      };
      const momSingleMonthSeriesFor = (getter, fallbackName, fallbackColor, fallbackValue) => {
        if (!isSingleSelectedMonth || !selectedMonthDayLabels || !selectedMonthDayLabels.length) return null;
        if (momSelectedSites && momSelectedSites.length && liveMonthly) {
          const series = momSelectedSites.map((s, i) => {
            const rec = (liveMonthly[selectedMonthKey] || []).find((r) => r.code === s.code);
            const value = rec ? getter(rec) : null;
            return Number.isFinite(value)
              ? { name: s.name, color: momPalette[i % momPalette.length], values: selectedMonthDayLabels.map(() => value) }
              : null;
          }).filter(Boolean);
          return series.length ? series : null;
        }
        return [{ name: fallbackName, color: fallbackColor, values: selectedMonthDayLabels.map(() => fallbackValue || 0) }];
      };
      // momChartEl(storeSeries, fallbackSeries, opts) — ADDED 24 Jul 2026 (task #427/#430, live bug
      // confirmed on production). Every one of the 6 charts below used to do
      // `perStoreSeries() || [{ name: 'Portfolio', ...literal portfolio-wide values }]` — so if a store
      // WAS selected but momSeriesFor/momSingleMonthSeriesFor couldn't build its line (e.g. the store
      // is missing data for even one month in the selected range — a newly-added site like Edmonton
      // that didn't exist for the whole window is the case that surfaced this), the chart silently fell
      // all the way through to that hardcoded portfolio-wide fallback, generically labeled
      // "Portfolio"/"ft²"/"Rate"/"Premiums" with nothing indicating the swap happened. Confirmed live:
      // selecting Edmonton alone on the 12M view showed byte-for-byte the same values as "All stores".
      // Fix: only use the literal portfolio fallback when NO store filter is active at all (its
      // original, intended use, unchanged). When a filter IS active but the real per-store series
      // couldn't be built, show an honest empty state instead of fabricated numbers — same visual
      // treatment as the existing "No stored history exists yet" state a few hundred lines down, not a
      // new pattern. (A properly gapped per-store line — plotting the months a partial-history store
      // DOES have data for — is a reasonable future enhancement, but needs LineChart itself to support
      // null gaps in its polyline/area rendering, which today it does not; not worth risking on cutover
      // day for a component with 8 other call sites elsewhere on the portal.)
      const momChartEl = (storeSeries, fallbackSeries, opts) => {
        if (storeSeries) return <LineChart series={storeSeries} opts={opts} />;
        if (momAnySel) return <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>No complete data for the selected store(s) over this period.</div>;
        return <LineChart series={fallbackSeries} opts={opts} />;
      };
      // Revenue Collected — daily-within-current-month view (17 Jul 2026, task #312, Michael: "the
      // rev collected on the mom page only shows '20-'24 [when] i have it 1m... make it show the
      // current month only and how it changes daily"). Root cause of the '20-'24 symptom: selecting
      // the PERIOD selector's '1M' preset scopes monthFrom===monthTo, i.e. exactly ONE stored month —
      // below the >=2 points scopedOk requires (see momUsingFullHistory above), so it was silently
      // falling back to liveHist's full multi-year stored history instead, and cramming 60+ month
      // labels into one 620px-wide chart left only a handful of legible YEAR labels visible.
      // Rather than widen that fallback, this gives '1M' something genuinely better for Revenue
      // Collected specifically: real DAY-BY-DAY figures for the live current month, sourced from
      // daily_financial_snapshot (the same table Cockpit Charting already accumulates one row per
      // site per day for — see lib/pullCockpit.js/lib/cockpitData.js) instead of one point per
      // calendar month. Scoped to ONLY this one chart because it's the only MoM metric with any
      // daily-granularity source at all — Rent Roll/Insurance Roll/Occupied Area/SS Rate below are
      // each pulled just once per MONTH (RentRoll/InsuranceRoll/OccupancyStatistics have no daily
      // pull), so '1M' on those still falls back to full history exactly as before; there's no daily
      // data to show for them.
      // total_credit was ADDED to daily_financial_snapshot alongside this fix (see schema.sql) so the
      // daily figure can match the SAME "Charge minus Credit" definition as the monthly version
      // (buildPayload.js's revenue.collected) instead of just raw total_charge on its own — existing
      // days pulled before the migration read total_credit as 0 until Michael runs it and new daily
      // rows accumulate (no raw response is kept for this pipeline to backfill from, see schema.sql's
      // migration comment).
      const selectedMonthKey = monthKeyOf(monthTo);
      const isSingleSelectedMonth = monthFrom === monthTo;
      const momCockpit = (liveMomCockpit && liveMomCockpit.month === selectedMonthKey) ? liveMomCockpit : null;
      // selectedMonthDayLabels (24 Jul 2026, freshness audit): the five "static repeated across the
      // month" MoM charts (Rent Roll / Insurance Roll / Occupied Area / SS Occupied Area / SS Rate)
      // should stop at the MAIN portfolio payload's last completed day, not the browser date. But
      // Revenue Collected is sourced from the separate cockpit daily snapshot and can legitimately be
      // fresher than the main payload. Keep two caps: one for the main monthly payload-backed charts,
      // one for the cockpit daily curve itself.
      const selectedMonthDayLabels = monthDayLabels(selectedMonthKey, null, rangePullAt || lastPullAt);
      const revenueMonthDayLabels = monthDayLabels(selectedMonthKey, momCockpit && momCockpit.curve, null);
      // Fill the selected month's daily curve out to one point per calendar day: before the first
      // available snapshot, values are 0; after that, any missing dates carry the most recent
      // cumulative total forward. For the CURRENT month, stop at yesterday (the last complete day).
      // For a closed past month, stop at that month's calendar end.
      const paddedDailyCurve = padDailyMonthCurve(momCockpit && momCockpit.curve, selectedMonthKey, () => ({
        total_charge: 0,
        total_credit: 0,
        total_payment: 0,
        sites: [],
      }), null);
      const cockpitOk = !!(paddedDailyCurve && paddedDailyCurve.length);
      const dailyOk = isSingleSelectedMonth && cockpitOk;
      if (isSingleSelectedMonth && !cockpitOk) debugWarn(`[portal-v2] Month-on-Month: single-month view selected for ${selectedMonthKey} but no daily_financial_snapshot rows exist for that month yet.`);
      // ADDED 21 Jul 2026 (Rich's portal review, task #354: "MoM: Need to make these smaller like in
      // the portal to see more in a single fold"). momChartHeight shrinks all 6 trend charts on this
      // page specifically (via LineChart's new opts.height, default 150) — every other page's charts
      // (Marketing YoY, Cockpit Charting, etc.) are untouched since they don't pass this option.
      const momChartHeight = 95;
      const momSingleMonthOpts = (extra = {}) => ({
        labels: selectedMonthDayLabels,
        height: momChartHeight,
        niceAxis: true,
        ...extra,
      });
      // FIXED 21 Jul 2026 (Michael, verifying task #352 live: "Revenue collected - what is the
      // intention here? I have selected 1 store and still see portfolio numbers in this"). Fixed by
      // summing only the selected sites' figures when the store-checkbox filter is active, matched
      // from site NAME (what `selected` is keyed by) to site CODE (what sites[] is keyed by) via
      // liveSites — the same shadow-filtered array every other live widget on this page already reads.
      // dailySeriesFor() below (task #373, same day) goes further — a per-store OVERLAY (one line per
      // selected store) rather than this blended sum, same as the other 5 charts now get via
      // momSeriesFor(). dailyRevenue/dailyRevNote stay as the fallback for whenever dailySeriesFor()
      // can't build per-store lines (liveSitesRaw not loaded yet), same graceful-degradation pattern
      // used everywhere else on this page.
      const dailyRevenueSeries = (() => {
        if (!paddedDailyCurve) return [];
        if (!momSelectedCodes) return paddedDailyCurve.map((c) => (c.total_charge || 0) - (c.total_credit || 0));
        const lastByCode = new Map();
        return paddedDailyCurve.map((c) => {
          for (const site of (c.sites || [])) {
            if (momSelectedCodes.has(site.code)) lastByCode.set(site.code, (site.total_charge || 0) - (site.total_credit || 0));
          }
          let sum = 0;
          for (const code of momSelectedCodes) sum += lastByCode.get(code) || 0;
          return sum;
        });
      })();
      const dailyRevNote = momAnySel ? null : momFilterNote;
      // dailySeriesFor() — the daily-cockpit equivalent of momSeriesFor() above, since Revenue
      // Collected's '1M' view reads liveCockpit.curve (daily_financial_snapshot) instead of liveMonthly
      // (see the big comment block above this one explaining why this one chart has its own daily
      // source). lib/cockpitData.js's readCockpitData() already returns each day's per-site sites[]
      // breakdown "for the store filter to slice client-side" (that file's own comment) — same
      // situation as liveMonthly, data already there, just never read per-store before today.
      const dailySeriesFor = () => {
        if (!momSelectedSites || !momSelectedSites.length) return null;
        const series = momSelectedSites.map((s, i) => ({
          name: s.name,
          color: momPalette[i % momPalette.length],
          values: (() => {
            let lastValue = 0;
            let seen = false;
            const values = paddedDailyCurve.map((c) => {
              const site = (c.sites || []).find((x) => x.code === s.code);
              if (site) {
                lastValue = (site.total_charge || 0) - (site.total_credit || 0);
                seen = true;
              }
              return lastValue;
            });
            return seen ? values : null;
          })(),
        })).filter((series) => Array.isArray(series.values));
        return series.length ? series : null;
      };
      const revCollectedCard = dailyOk
        ? { title: 'Revenue Collected', tip: 'Report: FinancialSummary.\nFields: Charge, Credit — pulled once per day for the selected month (daily_financial_snapshot), broken out per store.\nCalculation: Σ Charge − Σ Credit, per day, from the selected month\'s first day through the last complete day. Missing snapshot dates are filled by carrying the most recent cumulative total forward.\nNote: only Revenue Collected has a daily source today — the other five charts on this page still show one point per calendar month rather than daily, though they now split by selected store(s) the same way this one does.', note: dailyRevNote, el: <LineChart series={dailySeriesFor() || [{ name: momAnySel ? 'Selected store(s) (daily)' : 'Portfolio (daily)', color: C.blue, values: dailyRevenueSeries }]} opts={{ labels: revenueMonthDayLabels || paddedDailyCurve.map((c) => String(new Date(c.date).getDate())), zero: true, height: momChartHeight, niceAxis: true, unit: '£', unitPrefix: true }} /> }
        : { title: 'Revenue Collected', tip: 'Report: FinancialSummary.\nFields: Charge, Credit.\nCalculation: Σ Charge − Σ Credit, per stored month — one line per selected store if any are checked, else portfolio-wide.\nNote: corrected 16 Jul 2026 — this previously said "Report: ManagementSummary", but Charge/Credit are FinancialSummary fields (lib/reportMap.js\'s financial parser).' + momTip, note: momFilterNote, el: momChartEl(momSeriesFor((r) => r.revenue && r.revenue.collected), [{ name: 'Portfolio', color: C.blue, values: (liveHist || []).map((h) => h.revenue || 0) }], { labels: hLabels, zero: true, height: momChartHeight, niceAxis: true, unit: '£', unitPrefix: true }) };
      // NOTE (widget name review, 2 Jul 2026): this trend is named "Revenue Collected" (Charge minus
      // Credit, from the `financial`/ManagementSummary report), NOT "True Revenue" — that more
      // accurate tax/deferred-adjusted figure now lives on the Financials page's True Revenue
      // tables, sourced from the CustomReportByReportID "Daily Pro Rate" report, which is only
      // pulled for the current month (no per-month history retained yet), so it can't drive a
      // multi-month trend line until a historical backfill (Task #43) captures it going forward.
      // Chart width — NARROWED 21 Jul 2026 (Michael, with a legacy-portal screenshot attached: "make
      // the graphs narrower, like the legacy portal as shown"), reversing the full-width choice below
      // from 7 Jul. That original change was a real response to a real problem (all-time labels
      // overlapping in a ~340px column); Michael's new instruction, backed by the legacy screenshot's
      // dense 3-column grid, asks for the opposite. Removing wide:true lets these 6 cards fall into
      // the page's existing auto-fit grid (gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))',
      // ~line 3816) exactly like every non-MoM chart card already does — same mechanism, no new layout
      // code needed. The original crowding concern is handled differently now instead of by brute-
      // forcing full width: opts.niceAxis (see niceAxisTicks() above LineChart) gives each chart a
      // small, fixed number of round ticks (~4-6) instead of raw data labels, and seeing more history
      // is still done via the date-range presets (1M/3M/6M/12M/YTD/All) above, not by widening the
      // chart itself.
      // 7 Jul 2026 (superseded by the above; kept so the history is visible): "make them all one row
      // at a time like the top one so its easy to see all time regardless" — previously only "Revenue
      // Collected" had wide:true, so the other five were squeezed into a ~340px grid column and their
      // all-time labels overlapped/crowded, LOOKING like only ~1 year was shown even though the
      // underlying data/labels were already complete.
      out.chartCards = liveHist ? [
        revCollectedCard,
        { title: 'Rent Roll', tip: 'Report: RentRoll.\nFields: dcRent, bRented.\nCalculation: Σ dcRent on occupied (bRented) units, per stored month — one line per selected store if any are checked, else portfolio-wide.\nNote: in 1M view, this selected month\'s stored value is repeated across the month so the chart runs from day 1 through the last complete day.' + momTip, note: momFilterNote, el: momChartEl(momSingleMonthSeriesFor((r) => r.rent, 'Portfolio', C.teal, (liveHist[0] && liveHist[0].rent) || 0) || momSeriesFor((r) => r.rent), [{ name: 'Portfolio', color: C.teal, values: liveHist.map((h) => h.rent || 0) }], isSingleSelectedMonth && selectedMonthDayLabels ? momSingleMonthOpts({ zero: true, unit: '£', unitPrefix: true }) : { labels: hLabels, zero: true, height: momChartHeight, niceAxis: true, unit: '£', unitPrefix: true }) },
        { title: 'Insurance Roll', tip: 'Report: InsuranceRoll.\nFields: dcPremium, iActive.\nCalculation: Σ dcPremium on active policies, per stored month — one line per selected store if any are checked, else portfolio-wide.\nNote: in 1M view, this selected month\'s stored value is repeated across the month so the chart runs from day 1 through the last complete day.' + momTip, note: momFilterNote, el: momChartEl(momSingleMonthSeriesFor((r) => r.insurancePremiumSum, 'Premiums', C.blue, (liveHist[0] && liveHist[0].insurancePremium) || 0) || momSeriesFor((r) => r.insurancePremiumSum), [{ name: 'Premiums', color: C.blue, values: liveHist.map((h) => h.insurancePremium || 0) }], isSingleSelectedMonth && selectedMonthDayLabels ? momSingleMonthOpts({ zero: true, unit: '£', unitPrefix: true }) : { labels: hLabels, zero: true, height: momChartHeight, niceAxis: true, unit: '£', unitPrefix: true }) },
        { title: 'Total Occupied Area', tip: 'Report: OccupancyStatistics.\nFields: OccupiedArea (falls back to Area × Occupied if not present).\nCalculation: Σ OccupiedArea, per stored month — one line per selected store if any are checked, else portfolio-wide.\nNote: OccupiedArea is SiteLink\'s own average of day 10, day 20, and month-end, not a true daily figure. In 1M view, that selected month\'s stored value is repeated across the month.' + momTip, note: momFilterNote, el: momChartEl(momSingleMonthSeriesFor((r) => r.occA, 'ft²', C.blue, (liveHist[0] && liveHist[0].occA) || 0) || momSeriesFor((r) => r.occA), [{ name: 'ft²', color: C.blue, values: liveHist.map((h) => h.occA || 0) }], isSingleSelectedMonth && selectedMonthDayLabels ? momSingleMonthOpts({ unit: 'ft²' }) : { labels: hLabels, height: momChartHeight, niceAxis: true, unit: 'ft²' }) },
        { title: 'Self Storage Occupied Area', tip: 'Report: OccupancyStatistics.\nFields: OccupiedArea (falls back to Area × Occupied), UnitType ("Indoor Self Storage" rows only).\nCalculation: Σ OccupiedArea, self storage units only, per stored month — one line per selected store if any are checked, else portfolio-wide.\nNote: OccupiedArea is SiteLink\'s own average of day 10, day 20, and month-end, not a true daily figure. In 1M view, that selected month\'s stored value is repeated across the month.' + momTip, note: momFilterNote, el: momChartEl(momSingleMonthSeriesFor((r) => r.ss && r.ss.occA, 'ft²', C.teal, (liveHist[0] && liveHist[0].ssOccA) || 0) || momSeriesFor((r) => r.ss && r.ss.occA), [{ name: 'ft²', color: C.teal, values: liveHist.map((h) => h.ssOccA || 0) }], isSingleSelectedMonth && selectedMonthDayLabels ? momSingleMonthOpts({ unit: 'ft²' }) : { labels: hLabels, height: momChartHeight, niceAxis: true, unit: 'ft²' }) },
        { title: 'Self Storage Rate per ft²', tip: 'Report: RentRoll.\nFields: dcStdRate, Area/Area1, sTypeName ("Indoor Self Storage" rows only).\nCalculation: Σ dcStdRate ÷ Σ area × 12, self storage units only, per stored month — one line per selected store if any are checked, else portfolio-wide.\nNote: in 1M view, this selected month\'s stored value is repeated across the month so the chart runs from day 1 through the last complete day.' + momTip, note: momFilterNote, el: momChartEl(momSingleMonthSeriesFor((r) => r.ssRate, 'Rate', C.blue, (liveHist[0] && liveHist[0].ssRate) || 0) || momSeriesFor((r) => r.ssRate), [{ name: 'Rate', color: C.blue, values: liveHist.map((h) => h.ssRate || 0) }], isSingleSelectedMonth && selectedMonthDayLabels ? momSingleMonthOpts({ unit: '£', unitPrefix: true, axisDecimals: 2 }) : { labels: hLabels, height: momChartHeight, niceAxis: true, unit: '£', unitPrefix: true, axisDecimals: 2 }) },
      ] : scopedMissingHistory ? [
        { title: 'Revenue Collected', el: <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>No stored history exists yet for the selected period.</div> },
        { title: 'Rent Roll', el: <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>No stored history exists yet for the selected period.</div> },
        { title: 'Insurance Roll', el: <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>No stored history exists yet for the selected period.</div> },
        { title: 'Total Occupied Area', el: <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>No stored history exists yet for the selected period.</div> },
        { title: 'Self Storage Occupied Area', el: <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>No stored history exists yet for the selected period.</div> },
        { title: 'Self Storage Rate per ft²', el: <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>No stored history exists yet for the selected period.</div> },
      ] : [
        { title: 'Revenue Collected', el: <LineChart series={[{ name: 'Portfolio', color: C.blue, values: seq(48000 * f, 900 * f, 2200 * f, 12) }]} opts={{ labels: L, zero: true, niceAxis: true, unit: '£', unitPrefix: true }} /> },
        { title: 'Rent Roll', el: <LineChart series={[{ name: 'Portfolio', color: C.teal, values: seq(1200000 * f, 12000 * f, 24000 * f, 12) }]} opts={{ labels: L, zero: true, niceAxis: true, unit: '£', unitPrefix: true }} /> },
        { title: 'Insurance Roll', el: <LineChart series={[{ name: 'Premiums', color: C.blue, values: seq(4200 * f, 90 * f, 260 * f, 12) }]} opts={{ labels: L, zero: true, niceAxis: true, unit: '£', unitPrefix: true }} /> },
        { title: 'Total Occupied Area', el: <LineChart series={[{ name: 'ft²', color: C.blue, values: seq(600000 * f, 3400 * f, 9000 * f, 12) }]} opts={{ labels: L, niceAxis: true, unit: 'ft²' }} /> },
        { title: 'Self Storage Occupied Area', el: <LineChart series={[{ name: 'ft²', color: C.teal, values: seq(540000 * f, 3000 * f, 8000 * f, 12) }]} opts={{ labels: L, niceAxis: true, unit: 'ft²' }} /> },
        { title: 'Self Storage Rate per ft²', el: <LineChart series={[{ name: 'Rate', color: C.blue, values: seq(27.2, 0.22, 0.4, 12) }]} opts={{ labels: L, niceAxis: true, unit: '£', unitPrefix: true, axisDecimals: 2 }} /> },
      ];
    }

    else if (page === 'unitmix') {
      // Unit Mix Detail — new page (3 Jul 2026) built from the RentalActivity report Michael
      // uploaded (Grp_RentalActivity_*.xlsx), confirmed live-pullable for all 27 sites via
      // npm run probe:rental-activity-report. One row per (unit type, unit size) across the whole
      // portfolio (totals.rentalActivityByTypeSize, sum-then-divide rollup — see lib/buildPayload.js).
      const umT = liveSites ? computeTotals(liveSites) : null;
      const umRows = umT?.rentalActivityByTypeSize?.length ? umT.rentalActivityByTypeSize : null;
      if (!umRows) {
        if (umT) debugWarn('[portal-v2] Unit Mix Detail page has no live rental-activity rows for the selected period/store scope.');
        else debugWarn('[portal-v2] Unit Mix Detail page rendering with mock data (no live rental_activity data yet — run npm run pull after adding rental_activity to the pipeline).');
      }
      // FIXED 10 Jul 2026 (audit): rows were missing totalArea/occupiedArea (only had per-unit `area`).
      // The rollup below (line ~1978) only accumulates o.totalArea/o.occupiedArea `if (r.totalArea !=
      // null)` / `if (r.occupiedArea != null)` — since these were always undefined here, every mock
      // row's contribution was silently dropped, leaving Rate Realization Gap's totalDollarPerArea/
      // occupiedDollarPerArea/gapPct at 0 for the whole page whenever live rental_activity data isn't
      // loaded yet, even though totalDollarPerArea/occupiedDollarPerArea below were already hand-
      // authored correctly. Added totalArea = area*totalUnits, occupiedArea = area*occupied (same
      // convention as the live rollup and lib/reportMap.js's occupancy parser) — verified these
      // reproduce the existing hand-authored totalDollarPerArea/occupiedDollarPerArea values exactly
      // (e.g. row 1: 8555/4640*12 = 22.13, 7100/4320*12 = 19.73).
      const mockUM = [
        { type: 'Drive Up', unitSize: '8x20', area: 160, totalUnits: 29, occupied: 27, vacant: 2, standardRate: 295, occupiedRent: 7100, movedIn: 3, movedOut: 5, transfers: 1, netTransferred: 0, net: -2, occPct: 93.1, vacPct: 6.9, totalArea: 4640, occupiedArea: 4320, totalDollarPerArea: 22.13, occupiedDollarPerArea: 19.73, grossPotential: 8555, vacantArea: 320, netArea: -320 },
        { type: 'Indoor Self Storage', unitSize: '5x5', area: 25, totalUnits: 19, occupied: 18, vacant: 1, standardRate: 85, occupiedRent: 1397, movedIn: 2, movedOut: 2, transfers: 1, netTransferred: -1, net: 0, occPct: 94.7, vacPct: 5.3, totalArea: 475, occupiedArea: 450, totalDollarPerArea: 40.8, occupiedDollarPerArea: 37.25, grossPotential: 1615, vacantArea: 25, netArea: -25 },
        { type: 'Indoor Self Storage', unitSize: '3x3', area: 9, totalUnits: 4, occupied: 3, vacant: 1, standardRate: 41, occupiedRent: 91, movedIn: 1, movedOut: 0, transfers: 0, netTransferred: 0, net: 1, occPct: 75, vacPct: 25, totalArea: 36, occupiedArea: 27, totalDollarPerArea: 54.7, occupiedDollarPerArea: 40.4, grossPotential: 164, vacantArea: 9, netArea: 9 },
        { type: 'Enterprise', unitSize: '20x20', area: 400, totalUnits: 2, occupied: 2, vacant: 0, standardRate: 697, occupiedRent: 1394, movedIn: 0, movedOut: 0, transfers: 0, netTransferred: 0, net: 0, occPct: 100, vacPct: 0, totalArea: 800, occupiedArea: 800, totalDollarPerArea: 20.9, occupiedDollarPerArea: 20.9, grossPotential: 1394, vacantArea: 0, netArea: 0 },
        { type: 'Office', unitSize: '10x10', area: 100, totalUnits: 6, occupied: 5, vacant: 1, standardRate: 210, occupiedRent: 950, movedIn: 1, movedOut: 1, transfers: 0, netTransferred: 0, net: 0, occPct: 83.3, vacPct: 16.7, totalArea: 600, occupiedArea: 500, totalDollarPerArea: 25.2, occupiedDollarPerArea: 22.8, grossPotential: 1260, vacantArea: 100, netArea: 0 },
      ];
      // Collapsed to ONE ROW PER UNIT TYPE (6 Jul 2026, Michael: "you have every piece of unit
      // showing... change that so it only shows one mail box, one indoor self storage... as a
      // total" — the report's natural grain is per (type, unit SIZE), giving 50+ rows; this page
      // should show the type-level total instead). Sum-then-recompute, same rule as every other
      // rollup in this file — rates/percentages are never averaged from already-divided per-size
      // figures.
      const byTypeSize = umRows || (umT
        ? [{ type: '(no rental activity rows for selected scope/period)', unitSize: null, area: null, totalUnits: 0, occupied: 0, vacant: 0, standardRate: null, occupiedRent: 0, movedIn: 0, movedOut: 0, transfers: 0, netTransferred: 0, net: 0, occPct: null, vacPct: null, totalArea: 0, occupiedArea: 0, totalDollarPerArea: null, occupiedDollarPerArea: null, grossPotential: 0, vacantArea: 0, netArea: 0 }]
        : mockUM);
      // Extracted into a named function (task #121, 10 Jul 2026) — was an inline IIFE, but the same
      // grouping needs to run a second time below over the PREVIOUS month's rentalActivityByTypeSize
      // for the totals-row "vs last month" deltas, and hand-duplicating this logic would risk it
      // drifting out of sync with itself over time.
      const groupByType = (bySize) => {
        const g = {};
        for (const r of bySize) {
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
      };
      // FIXED 16 Jul 2026 (deep re-audit #3): Parking and Mailbox units are conventionally priced
      // per space/box, not per square foot — confirmed live via this exact page: Parking showed
      // £3,531.71/ft²/yr actual (£5,697.67 list) and Mailbox £248.39/ft²/yr, versus every genuinely
      // area-priced type sitting in a sane £13-38/ft²/yr range. SiteLink's own recorded Area for
      // these types isn't a meaningful square-footage figure (they're not sized/sold by ft² at all),
      // so dividing rent by it produces a nonsensical number rather than a real rate. Blanking the
      // £/ft² fields for these types only — unit counts, occupancy %, Avg List Rate (£/mo), Gross
      // Potential and Actual Revenue are all real £/mo or count figures and stay as-is.
      const NOT_AREA_PRICED_TYPES = new Set(['Parking', 'Mailbox']);
      const rows = groupByType(byTypeSize).map((r) => NOT_AREA_PRICED_TYPES.has(r.type) ? { ...r, totalDollarPerArea: null, occupiedDollarPerArea: null } : r);
      // "vs last month" totals-row deltas (task #121, 10 Jul 2026) — same computeTotals(livePrevSites)
      // pattern used elsewhere, run through the SAME groupByType() so the comparison is apples-to-apples.
      const umTPrev = livePrevSites ? computeTotals(livePrevSites) : null;
      const umRowsPrev = umTPrev?.rentalActivityByTypeSize?.length ? umTPrev.rentalActivityByTypeSize : null;
      const rowsPrev = (umRows && umRowsPrev) ? groupByType(umRowsPrev) : null;

      // 1. Unit Type Breakdown table (direct match for a widget in Michael's KPI reference doc we
      // didn't have anywhere yet — Occupancy Statistics doesn't carry a standalone rate column at
      // this grain; RentalActivity does).
      const breakdownCols = [
        { key: 'type', label: 'Type', type: 'text' },
        { key: 'totalUnits', label: 'Total', type: 'int', align: 'right' }, { key: 'occupied', label: 'Occupied', type: 'int', align: 'right' },
        { key: 'vacant', label: 'Vacant', type: 'int', align: 'right' }, { key: 'occPct', label: 'Occupancy %', type: 'pct', align: 'right', color: 'threshold' },
        { key: 'standardRate', label: 'Avg List Rate', type: 'money', align: 'right' }, { key: 'occupiedDollarPerArea', label: 'Actual £/ft²', type: 'money2', align: 'right' },
      ];
      const breakdownTotals = umRows ? { totalUnits: rows.reduce((a, r) => a + r.totalUnits, 0), occupied: rows.reduce((a, r) => a + r.occupied, 0), vacant: rows.reduce((a, r) => a + r.vacant, 0) } : (umT ? null : { totalUnits: rows.reduce((a, r) => a + r.totalUnits, 0), occupied: rows.reduce((a, r) => a + r.occupied, 0), vacant: rows.reduce((a, r) => a + r.vacant, 0) });
      const breakdownTotalsPrev = rowsPrev ? { totalUnits: rowsPrev.reduce((a, r) => a + r.totalUnits, 0), occupied: rowsPrev.reduce((a, r) => a + r.occupied, 0), vacant: rowsPrev.reduce((a, r) => a + r.vacant, 0) } : null;

      // 3. Rate Realization Gap — list vs actual achieved £/ft², both already annualised, so this
      // compares cleanly at ANY grain (type-level here) without needing a single unit's raw area.
      const gapRows = rows.map((r) => ({ ...r, gapPct: r.totalDollarPerArea == null ? null : (r.totalDollarPerArea ? R2((r.occupiedDollarPerArea - r.totalDollarPerArea) / r.totalDollarPerArea * 100) : null) }));
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
      const turnoverTotals = umRows ? { movedIn: rows.reduce((a, r) => a + r.movedIn, 0), movedOut: rows.reduce((a, r) => a + r.movedOut, 0), net: rows.reduce((a, r) => a + r.net, 0) } : (umT ? null : { movedIn: rows.reduce((a, r) => a + r.movedIn, 0), movedOut: rows.reduce((a, r) => a + r.movedOut, 0), net: rows.reduce((a, r) => a + r.net, 0) });
      const turnoverTotalsPrev = rowsPrev ? { movedIn: rowsPrev.reduce((a, r) => a + r.movedIn, 0), movedOut: rowsPrev.reduce((a, r) => a + r.movedOut, 0), net: rowsPrev.reduce((a, r) => a + r.net, 0) } : null;

      // 5. Gross Potential vs Actual Revenue — the upside sitting in vacant units at list rate.
      const captureRows = rows.map((r) => ({ ...r, capturePct: r.grossPotential ? R2(r.occupiedRent / r.grossPotential * 100) : null }));
      const captureCols = [
        { key: 'type', label: 'Type', type: 'text' },
        { key: 'grossPotential', label: 'Gross Potential', type: 'money', align: 'right' }, { key: 'occupiedRent', label: 'Actual Revenue', type: 'money', align: 'right' },
        { key: 'capturePct', label: 'Capture %', type: 'pct', align: 'right', color: 'threshold' },
      ];

      // Vacant Units by Size chart + Transfer Flow table — REMOVED 6 Jul 2026 (Michael).
      out.statCards = [];
      out.chartCards = [];
      out.tables = [
        // NARROWED 21 Jul 2026 (Michael: "make all the big tables narrower... put them next to
        // eachother", no exceptions) — all 4 tables on this page are narrow now, so they pack 2-up:
        // Unit Type Breakdown pairs with Rate Realization Gap, Turnover by Unit Type pairs with Gross
        // Potential vs Actual Revenue.
        { title: `Unit Type Breakdown (${liveScopeLabel})`, live: !!umRows, pageSize: 20, tip: 'Report: RentalActivity.\nFields: Type, TotalUnits, Occupied, OccupiedRent, OccupiedArea.\nCalculation: Grouped by unit type. Occupancy % = Occupied ÷ TotalUnits × 100. Actual £/ft² = OccupiedRent ÷ OccupiedArea × 12.\nBlank £/ft² for Parking/Mailbox — those are priced per space/box, not per ft².', columns: breakdownCols, rows, totals: breakdownTotals, totalsPrev: breakdownTotalsPrev, totalsLabel: 'Total' },
        { title: `Rate Realization Gap (${liveScopeLabel})`, live: !!umRows, pageSize: 20, tip: 'Report: RentalActivity.\nFields: OccupiedDollarPerArea (actual rate), TotalDollarPerArea (list rate).\nCalculation: Gap % = (OccupiedDollarPerArea − TotalDollarPerArea) ÷ TotalDollarPerArea × 100, per unit type.\nParking/Mailbox excluded — priced per space/box, not per ft², so a £/ft² comparison isn\'t meaningful.', columns: gapCols, rows: gapRows },
        { title: `Turnover by Unit Type (${liveScopeLabel})`, live: !!umRows, pageSize: 20, tip: 'Report: RentalActivity.\nFields: Type, MovedIn, MovedOut, Transfers, NetTransferred, Net.\nCalculation: Move-ins, move-outs and transfers grouped by unit type, for the previous complete month. Type-level detail — the KPI page card is portfolio-wide only.', columns: turnoverCols, rows, totals: turnoverTotals, totalsPrev: turnoverTotalsPrev, totalsLabel: 'Total' },
        { title: `Gross Potential vs Actual Revenue (${liveScopeLabel})`, live: !!umRows, pageSize: 20, tip: 'Report: RentalActivity.\nFields: GrossPotential, OccupiedRent.\nCalculation: Capture % = OccupiedRent ÷ GrossPotential (list rate on all units) × 100.', columns: captureCols, rows: captureRows },
      ];
    }

    else if (page === 'discountSummary') {
      // Discount Summary — new page (9 Jul 2026, Michael: "add page 'Discount Summary' under
      // performance"). Which discount plans are currently in use, by how many customers, and how
      // much £ discount — from the standalone Discounts SOAP method (confirmed real against the live
      // WSDL; "DiscountSummary"/"UnitStatus" from SiteLink's own report picker are NOT callable API
      // methods). "Monthly flow" definition per Michael's decision (2nd AskUserQuestion, 9 Jul 2026):
      // anyone with a discounted charge posted during the selected month, not a right-now snapshot —
      // the only version that can be pulled automatically on a schedule and gives a real reproducible
      // number for any past month. Unit/customer counts are deduplicated per unit (a unit on a ~28-day
      // billing cycle can post 2 charge rows inside one calendar month — confirmed live, not a bug);
      // £ totals sum every charge line as-is. See lib/reportMap.js's `discounts` comment for the full
      // source investigation.
      const dsT = liveSites ? computeTotals(liveSites) : null;
      const dsRows = dsT?.discountPlans?.length ? dsT.discountPlans : null;
      if (!dsRows) {
        if (dsT) debugWarn('[portal-v2] Discount Summary page has no live discount-plan rows for the selected period/store scope.');
        else debugWarn('[portal-v2] Discount Summary page rendering with mock data (no live discounts data yet — run npm run pull after adding the discounts report to the pipeline).');
      }
      const mockDS = [
        { plan: 'Variances from Standard Rate: Non-Expiring', units: 71, discount: 3442.43 },
        { plan: '50% OFF 12 Weeks', units: 21, discount: 1731.65 },
        { plan: '50% OFF 8 Weeks', units: 8, discount: 582.04 },
        { plan: '10% OFF 12 Months.', units: 4, discount: 39.13 },
      ];
      const planRows = dsRows || (dsT
        ? [{ plan: '(no discount-plan rows for selected scope/period)', units: null, discount: null }]
        : mockDS);
      // FIXED 21 Jul 2026 (task #396, portal audit — "Discount Summary potential double-counting
      // across plans"): this used to be planRows.reduce((a,r)=>a+r.units,0) — summing EACH plan's own
      // already-per-plan-deduped unit count. That's correct for each plan's own row (a unit really is
      // on both plans if it switched mid-month), but double-counts any unit that carries discounted
      // charge lines under MORE than one plan in the same month when rolled up into this portfolio-
      // wide total, despite this tile's tooltip claiming "deduplicated by sUnitName". dsT.
      // discountUnitsOnPlan is a genuine cross-plan Set built in lib/reportMap.js's discounts.parse(),
      // summed across sites in computeTotals()/aggregateTotals() — the real distinct-unit count.
      // Mock path (no live data) keeps the old sum-of-plan-rows approximation — the 4 mock plan rows
      // don't model any unit belonging to 2 plans at once, so there's nothing to double-count there.
      // Gated on dsRows (not just dsT) to match this tile's own `live: !!dsRows` flag below — dsRows
      // is null whenever live discountPlans came back empty, in which case the whole page (including
      // this number) falls back to mock, same as before; only actually-live months use the real
      // cross-plan total.
      const totalUnits = dsRows ? (dsT.discountUnitsOnPlan ?? 0) : (dsT ? null : planRows.reduce((a, r) => a + r.units, 0));
      const totalDiscount = dsRows ? R2(planRows.reduce((a, r) => a + r.discount, 0)) : (dsT ? null : R2(planRows.reduce((a, r) => a + r.discount, 0)));
      out.statCards = [
        { title: 'Units on a Discount Plan', live: !!dsRows, tip: 'Report: Discounts.\nFields: sUnitName, dcDiscount.\nCalculation: Distinct units with at least one discounted charge line in the selected period, deduplicated by sUnitName across every plan (a unit on 2 plans at once counts once here, not twice — a billing cycle can also post 2 rows/month for the same plan, also deduplicated).', tiles: [{ value: intFmt(totalUnits), label: liveScopeLabel, delta: null, dir: null }] },
        { title: 'Total £ Discount', live: !!dsRows, tip: 'Report: Discounts.\nFields: dcDiscount.\nCalculation: Σ dcDiscount across every charge line in the selected period (not deduplicated — every discount line genuinely happened).', tiles: [{ value: money(totalDiscount), label: liveScopeLabel, delta: null, dir: null }] },
      ];
      out.chartCards = [
        { title: 'Units by Discount Plan', tip: 'Report: Discounts.\nFields: sConcessionPlan, sUnitName.\nCalculation: Distinct units per sConcessionPlan in the selected period, deduplicated by sUnitName.', el: dsRows ? <VBars items={planRows.map((r) => ({ label: r.plan.length > 22 ? r.plan.slice(0, 21) + '…' : r.plan, value: r.units, disp: intFmt(r.units), color: C.blue }))} opts={{ max: Math.max(...planRows.map((r) => r.units)) * 1.15 }} /> : dsT ? <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>No discount-plan rows for the selected store scope and period.</div> : <VBars items={planRows.map((r) => ({ label: r.plan.length > 22 ? r.plan.slice(0, 21) + '…' : r.plan, value: r.units, disp: intFmt(r.units), color: C.blue }))} opts={{ max: Math.max(...planRows.map((r) => r.units)) * 1.15 }} /> },
      ];
      out.tables = [
        // NARROWED (task #395) — only 3 columns; the only table on this page, so it just renders
        // narrower on a wide screen rather than stretching edge to edge.
        { title: `Discount Plans (${liveScopeLabel})`, live: !!dsRows, pageSize: 20,
          tip: 'Report: Discounts.\nFields: sConcessionPlan, sUnitName, dcDiscount.\nCalculation: Plan name, deduplicated unit count, and Σ dcDiscount per plan — a monthly flow, not a right-now snapshot.',
          columns: [
            { key: 'plan', label: 'Plan', type: 'text' },
            { key: 'units', label: 'Units (Customers)', type: 'int', align: 'right' },
            { key: 'discount', label: '£ Discount', type: 'money', align: 'right' },
          ],
          rows: planRows, totals: { units: totalUnits, discount: totalDiscount }, totalsLabel: 'Total' },
      ];
    }

    else if (page === 'snapshot') {
      // Weekly/Daily Snapshot — new page (9 Jul 2026, Michael: "add page 'Weekly/Daily snapshot under
      // overview", "check original brief on timings of API"). Michael's decision (3rd AskUserQuestion,
      // 9 Jul 2026): a live-style period query (yesterday / last 7 days / quarter-to-date), not a
      // day-by-day accumulating trend chart. Backed by its own snapshot_payload row, refreshed by
      // `npm run pull:snapshot` (or GET /api/pull-snapshot), independent of the main monthly pull.
      // Reservation Backlog ("forward move-ins", Michael's pick) card REMOVED 14 Jul 2026 (Michael) —
      // was a "Coming soon" placeholder pending confirmation of a usable target-move-in-date field on
      // InquiryTracking, which still doesn't exist. See the tables[] block below for the removal note.
      // 21 Jul 2026: briefly switched all three periods to run through TODAY (Michael), reverted the
      // same day (Michael: "no today needs to show yesterday") once "today" turned out to mean
      // "frozen at whatever this morning's one-a-day pull saw" — see lib/pullSnapshot.js's header.
      const snap = liveSnapshot ? liveSnapshot[snapshotPeriod] : null;
      if (!snap) debugWarn('[portal-v2] Weekly/Daily Snapshot page rendering with mock data (no snapshot_payload yet — run npm run pull:snapshot).');
      const periodLabel = { daily: 'Yesterday', weekly: 'Last 7 days', quarterly: 'Quarter to date' }[snapshotPeriod];
      const fmtRange = (r) => {
        if (!r) return '';
        const f = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
        return r.start === r.end ? f(r.start) : `${f(r.start)} – ${f(r.end)}`;
      };
      const mockSnap = {
        range: (() => {
          const y = new Date(); y.setDate(y.getDate() - 1);
          const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          if (snapshotPeriod === 'daily') return { start: ymdLocal(y), end: ymdLocal(y) };
          if (snapshotPeriod === 'weekly') { const s = new Date(y); s.setDate(s.getDate() - 6); return { start: ymdLocal(s), end: ymdLocal(y) }; }
          const q = new Date(y.getFullYear(), Math.floor(y.getMonth() / 3) * 3, 1);
          return { start: ymdLocal(q), end: ymdLocal(y) };
        })(),
        totals: { daily: { enquiries: 14, reservations: 5, moveIns: 3, moveOuts: 2, sqftIn: 312, sqftOut: 168 }, weekly: { enquiries: 96, reservations: 31, moveIns: 22, moveOuts: 17, sqftIn: 2150, sqftOut: 1340 }, quarterly: { enquiries: 1180, reservations: 402, moveIns: 268, moveOuts: 231, sqftIn: 27400, sqftOut: 21860 } }[snapshotPeriod],
        sites: null,
      };
      const rawTotals = snap ? snap.totals : mockSnap.totals;
      const range = snap ? snap.range : mockSnap.range;
      const nameForCode = (code, fallbackName = null) => fallbackName || SITE_NAME_BY_CODE[code] || (liveSitesRaw || []).find((s) => s.code === code)?.name || code;
      // FIXED 23 Jul 2026 (production-readiness audit): the Snapshot page's per-store table already
      // respected the global store filter via name→code mapping, but the headline cards and the
      // table's totals row still read snap.totals (the FULL unfiltered portfolio payload) directly.
      // Selecting one store therefore produced an immediate contradiction: rows for the chosen store,
      // but headline figures/totals for every store combined. Re-scope all snapshot totals from the
      // same filtered site rows whenever snapshot per-site data is present, falling back to the
      // payload totals only when there is no site array to recompute from yet.
      const selectedNames = page === 'snapshot' ? pageSelectedNames : new Set();
      const anySelectedSnapshot = selectedNames.size > 0;
      const snapshotSiteRows = (snap && Array.isArray(snap.sites) ? snap.sites : [])
        .slice().sort((a, b) => a.code.localeCompare(b.code))
        .filter((s) => !anySelectedSnapshot || selectedNames.has(nameForCode(s.code, s.store)))
        .map((s) => ({ store: nameForCode(s.code, s.store), enquiries: s.enquiries, reservations: s.reservations, moveIns: s.moveIns, moveOuts: s.moveOuts, sqftIn: s.sqftIn, sqftOut: s.sqftOut }));
      const totals = snapshotSiteRows.length
        ? {
            enquiries: snapshotSiteRows.reduce((a, r) => a + (r.enquiries || 0), 0),
            reservations: snapshotSiteRows.reduce((a, r) => a + (r.reservations || 0), 0),
            moveIns: snapshotSiteRows.reduce((a, r) => a + (r.moveIns || 0), 0),
            moveOuts: snapshotSiteRows.reduce((a, r) => a + (r.moveOuts || 0), 0),
            sqftIn: snapshotSiteRows.reduce((a, r) => a + (r.sqftIn || 0), 0),
            sqftOut: snapshotSiteRows.reduce((a, r) => a + (r.sqftOut || 0), 0),
          }
        : (anySelectedSnapshot && snap && Array.isArray(snap.sites))
          ? { enquiries: 0, reservations: 0, moveIns: 0, moveOuts: 0, sqftIn: 0, sqftOut: 0 }
          : rawTotals;
      out.statCards = [
        // Enquiries & Reservations — MERGED 21 Jul 2026 (Michael). Was two separate cards; removed the
        // standalone "Reservations" one earlier the same day because it sat right next to Reserved
        // Scheduled Sqft's live "Reservations (as of now)" tile and read as an accidental duplicate.
        // Then Michael asked for "the number of enquiries and reservations from the prior day"
        // specifically — a real, different metric (NEW reservations MADE yesterday, from
        // InquiryTracking/lead_funnel's reservation_stage_count) from Reserved Scheduled Sqft's live
        // OPEN waiting-list count (a stock, not a flow). Keeps both concepts, but as two tiles on ONE
        // card instead of two separate cards, so it reads as "yesterday's flow" rather than "two
        // reservation numbers."
        // Reserved sqft tile ADDED 21 Jul 2026 (Michael, same-day follow-up: "reserved scheduled sqft
        // is still showing 460, remove the 460 and move the sqft to the enquiries and reservations
        // widget but for the appropriate amount of sqft based on the enquiries and reservation from
        // the last complete day"). Removes the standalone Reserved Scheduled Sqft card entirely (was
        // below this one) instead of just relocating its live "as of now" figure — Michael specifically
        // wants sqft scoped to the period, same as the other two tiles here, not the live stock total.
        // Neither underlying report can give that exactly: ReservationList (the sqft estimate's only
        // source — see lib/buildPayload.js's reservedSqftEstimate) has NO date field on its rows at
        // all, confirmed via every reference to it in this codebase, so it's structurally impossible
        // to ask it for "sqft reserved yesterday" directly; InquiryTracking (the source of the
        // period-scoped Reservations count on this card) has no area/size field on ITS rows either,
        // confirmed the same way. No single report has both a date and an area. Best available
        // estimate: take the LIVE portfolio's blended average area-per-reservation
        // (reservedSqftEstimate ÷ activeReservations, across whatever reservations are currently open
        // portfolio-wide, from lib/buildPayload.js) and apply that rate to the period-scoped
        // Reservations count already on this card — i.e. assume the period's new reservations have
        // roughly the live book's overall unit-type mix. A genuine estimate, not a measured figure —
        // labelled as such below and in the tooltip, same honesty standard as reservedSqftEstimate's
        // own "ESTIMATE only" comment in buildPayload.js. Falls back to a representative ~70 sqft/
        // reservation ratio (matching this card's own prior mock numbers) when liveSites isn't
        // available yet, same as every other mock branch on this page.
        (() => {
          const avgSqftPerRes = normalizedReservationSqftPerReservation(liveSites);
          const estSqft = Math.round(totals.reservations * avgSqftPerRes);
          return { title: 'Enquiries & Reservations', live: !!snap, tip: 'Report: InquiryTracking.\nFields: dPlaced, sInquiryType, iInquiryConvertedToLease.\nCalculation: Enquiries = visible placed enquiries within the selected window (' + periodLabel.toLowerCase() + '), summed across sites, using the same Phone/Web/Walk-in basis shown on the legacy Marketing page (Email excluded from the displayed basis). Reservations = visible converted enquiries on that same basis for the same window. Snapshot windows always stop at the last complete day, not intraday today.\nReserved sqft: ESTIMATE, not a direct measurement — Reservations (this card) × a blended average reservation size. The portal now prefers current-month move-in area per customer (closest available dated proxy), falling back to the live reservation-book estimate only when that looks plausible. Neither source has both a reservation date and unit area, so this remains an estimate rather than a directly measured period total.', tiles: [{ value: intFmt(totals.enquiries), label: 'Enquiries', delta: null, dir: null }, { value: intFmt(totals.reservations), label: 'Reservations', delta: null, dir: null }, { value: intFmt(estSqft) + ' ft²', label: 'Reserved sqft (est.)', delta: null, dir: null }] };
        })(),
        // Reservation Backlog card REMOVED 14 Jul 2026 (Michael) — was a "Coming soon" placeholder
        // pending a usable target-move-in-date field on InquiryTracking (still not confirmed to exist —
        // see lib/pullSnapshot.js's header comment). reservationBacklog stays null on every snapshot
        // record so this can come back easily if that field is ever found.
        { title: 'Move-ins / Move-outs', live: !!snap, tip: 'Report: MoveInsAndMoveOuts.\nFields: MoveIn, MoveOut.\nCalculation: Count of rows flagged MoveIn and rows flagged MoveOut within the selected window, summed across sites.', tiles: [{ value: intFmt(totals.moveIns), label: 'Move-ins', delta: null, dir: null }, { value: intFmt(totals.moveOuts), label: 'Move-outs', delta: null, dir: null }] },
        { title: 'Sqft In / Out', live: !!snap, tip: 'Report: MoveInsAndMoveOuts.\nFields: MovedInArea, MovedOutArea.\nCalculation: Σ MovedInArea (rows flagged MoveIn) and Σ MovedOutArea (rows flagged MoveOut) for the selected window, summed across sites; Out shown negative.', tiles: [{ value: intFmt(totals.sqftIn) + ' ft²', label: 'In', delta: null, dir: null }, { value: '-' + intFmt(totals.sqftOut) + ' ft²', label: 'Out', delta: null, dir: null }] },
        // Reserved Scheduled Sqft — the standalone card that used to sit here (task #353, then #367)
        // was REMOVED 21 Jul 2026 (Michael: "reserved scheduled sqft is still showing 460, remove the
        // 460 and move the sqft to the enquiries and reservations widget..."). Its live "Reservations
        // (as of now)" tile is gone from this page entirely; its sqft concept now lives as an
        // estimated, period-scoped third tile on the Enquiries & Reservations card above instead — see
        // that card's comment for the full reasoning. The live "as of now" version of this figure still
        // exists unchanged on the KPIs page's own Reserved Scheduled Sqft card, for anyone who wants the
        // un-scoped, right-now total specifically.
      ];
      const siteRows = snapshotSiteRows.map((s) => ({ store: s.store, enquiries: s.enquiries, reservations: s.reservations, moveIns: s.moveIns, moveOuts: s.moveOuts, sqftIn: s.sqftIn, sqftOut: s.sqftOut }));
      out.tables = [
        // NARROWED 21 Jul 2026 — only table on this page, renders narrower rather than edge to edge.
        { title: `Per-Store Breakdown — ${periodLabel} (${fmtRange(range)})`, live: !!snap, pageSize: 29,
          tip: 'Report: InquiryTracking; MoveInsAndMoveOuts.\nFields: dPlaced, sInquiryType, iInquiryConvertedToLease (InquiryTracking); MoveIn, MovedInArea, MovedOutArea (MoveInsAndMoveOuts).\nCalculation: Per-site counts/sums for the selected window. Snapshot enquiries/reservations follow the same visible Phone/Web/Walk-in basis shown on the legacy Marketing page (Email excluded from the displayed basis), refreshed via the daily snapshot pull (npm run pull:snapshot).',
          columns: [
            { key: 'store', label: 'Store', type: 'text' },
            { key: 'enquiries', label: 'Enquiries', type: 'int', align: 'right' },
            { key: 'reservations', label: 'Reservations', type: 'int', align: 'right' },
            { key: 'moveIns', label: 'Move-ins', type: 'int', align: 'right' },
            { key: 'moveOuts', label: 'Move-outs', type: 'int', align: 'right' },
            { key: 'sqftIn', label: 'Sqft In', type: 'int', align: 'right' },
            { key: 'sqftOut', label: 'Sqft Out', type: 'int', align: 'right' },
          ],
          rows: siteRows.length
            ? siteRows
            : [{ store: (snap && Array.isArray(snap.sites) && anySelectedSnapshot) ? '(no snapshot rows match this store filter)' : '(run npm run pull:snapshot for per-store data)', enquiries: null, reservations: null, moveIns: null, moveOuts: null, sqftIn: null, sqftOut: null }],
          totals: siteRows.length ? { enquiries: totals.enquiries, reservations: totals.reservations, moveIns: totals.moveIns, moveOuts: totals.moveOuts, sqftIn: totals.sqftIn, sqftOut: totals.sqftOut } : null,
          totalsLabel: 'Total' },
      ];
    }

    else if (page === 'districtManager') {
      // District Manager-style widgets (task #174/#203, from Michael's own live Qstrom DM screenshots,
      // 14 Jul 2026: "some qstrom widget ideas to add" → "im back, start"). Two of the twelve widgets
      // Michael photographed are buildable now with ZERO new SiteLink calls (RentalActivity + RentRoll
      // are both already pulled): "Watchdog - Discounted Units in Fully Occupied Groups" and "Unit
      // Groups - Stay & Re-Lease". Both are inherently PER-SITE (a "fully occupied group" is a fact
      // about one facility, not a portfolio-wide sum — summing vacancy across sites first would hide a
      // site whose own group is genuinely full), so this reads straight off each site's own raw
      // rentalActivityByTypeSize/unitRows arrays instead of the cross-site computeTotals() rollup used
      // elsewhere on this page. groupKey joins RentalActivity's (type, area) group to RentRoll's
      // per-unit rows the same way lib/reportMap.js's rent_roll parser builds it: `${type}|${round(area)}`
      // — RentRoll has no separate width/length columns, only combined Area, so this is an
      // approximation (good enough in practice since unit sizes within a site are standardized).
      // NOT included here (flagged to Michael, not silently dropped): "Watchdog - Never Leased Units"
      // — no SiteLink report exposes a never-leased flag or days-vacant for currently-vacant units,
      // confirmed via a dedicated investigation; and "Cockpit Charting" (daily income-by-category vs
      // 3-month average) — needs a new DAILY financial pull, which lib/pullSnapshot.js doesn't do
      // today (only enquiries/move-ins are pulled at daily grain) — a genuinely separate, bigger lift.
      // ADDED 15 Jul 2026 (Michael: "add the ones you think are important" — the remaining 7 of the
      // twelve photographed widgets have no recoverable spec anywhere in this repo): "Watchdog —
      // Occupancy Decline vs Last Month" and "Watchdog — Delinquency by Site", two NEW per-site
      // watchlists built from data already pulled (livePrevSites + s.debtors) — see below.
      const dmSites = liveSites || [];
      // FIXED 16 Jul 2026 (Michael, external verification against real SiteLink exports: "Discounted
      // Units in Fully Occupied Groups reads 0 in month views") — unitRows (RentRoll's per-unit array
      // this table is built from) was only added to the pipeline 14 Jul 2026, so any month locked in
      // before then (every month through June 2026) has no stored unitRows at all — discountedRows
      // below can only ever be empty for those months, not because there's genuinely nothing to show.
      // Distinguishes that from a real "0 matches" so the table doesn't imply a false all-clear.
      const hasUnitRowData = dmSites.some((s) => (s.unitRows || []).length > 0);
      const hasRentalActivityGroupData = dmSites.some((s) => (s.rentalActivityByTypeSize || []).length > 0);
      const discountedRows = [];
      const groupRows = [];
      for (const s of dmSites) {
        const groups = s.rentalActivityByTypeSize || [];
        const unitsAtSite = s.unitRows || [];
        // FIXED 15 Jul 2026 (Michael: "too much going on... saw duplicate... units in the same
        // store"): RentalActivity is one row per (Type, UnitSize), but RentRoll's per-unit rows only
        // ever carry ROUNDED AREA (no separate width/length columns — see reportMap.js's unitRows
        // comment). Two distinct UnitSize rows that happen to round to the same area (e.g. two sizes
        // a fraction of a sqft apart) collapse onto the SAME `${type}|${roundedArea}` key, but were
        // still being looped over as two separate groups — so a unit matching that key got pushed to
        // the Watchdog table once per colliding group (confirmed via scripts/probe-dm-widget-
        // duplicates.js). Merging same-key groups FIRST guarantees each key is processed exactly once
        // per site; vacant/totalUnits are summed across the colliding rows so "fully occupied"
        // reflects the true combined vacancy for that rounded-area bucket (RentRoll units can't be
        // told apart between the colliding sizes anyway), and rate fields are unit-count-weighted
        // rather than blindly averaged.
        const merged = new Map();
        for (const g of groups) {
          const key = `${g.type}|${Math.round(g.area)}`;
          const m = merged.get(key);
          if (!m) {
            merged.set(key, {
              type: g.type, area: Math.round(g.area), totalUnits: g.totalUnits, occupied: g.occupied, vacant: g.vacant,
              grossPotential: g.grossPotential,
              stdRateWeighted: g.standardRate * g.totalUnits, stdRateUnits: g.totalUnits,
              effRateWeighted: g.occupiedDollarPerArea * g.occupied, effRateUnits: g.occupied,
            });
          } else {
            m.totalUnits += g.totalUnits; m.occupied += g.occupied; m.vacant += g.vacant; m.grossPotential += g.grossPotential;
            m.stdRateWeighted += g.standardRate * g.totalUnits; m.stdRateUnits += g.totalUnits;
            m.effRateWeighted += g.occupiedDollarPerArea * g.occupied; m.effRateUnits += g.occupied;
          }
        }
        // Dedupe by unit name too — belt-and-braces against RentRoll itself ever returning two rows
        // for the same physical unit in one pull (see probe-dm-widget-duplicates.js's separate
        // RentRoll-level check); scoped per-site since unit names aren't unique across stores.
        const seenUnits = new Set();
        for (const [key, g] of merged) {
          const unitsInGroup = unitsAtSite.filter((u) => u.groupKey === key);
          const stays = unitsInGroup.map((u) => u.leaseDays).filter((d) => d != null);
          const avgStay = stays.length ? Math.round(stays.reduce((a, d) => a + d, 0) / stays.length) : null;
          groupRows.push({
            store: s.name, type: g.type, area: g.area, typeArea: `${g.type} · ${g.area} ft²`,
            totalUnits: g.totalUnits, occupied: g.occupied,
            vacant: g.vacant, occPct: g.totalUnits ? +(g.occupied / g.totalUnits * 100).toFixed(1) : 0,
            standardRate: g.stdRateUnits ? R2(g.stdRateWeighted / g.stdRateUnits) : 0,
            effectiveRate: g.effRateUnits ? R2(g.effRateWeighted / g.effRateUnits) : 0,
            grossPotential: g.grossPotential, avgStay,
          });
          if (g.totalUnits > 0 && g.vacant === 0) {
            for (const u of unitsInGroup) {
              if (u.stdRate > 0 && u.rent < u.stdRate && !seenUnits.has(u.unit)) {
                seenUnits.add(u.unit);
                discountedRows.push({
                  store: s.name, unit: u.unit, type: u.type, area: u.area, typeArea: `${u.type} · ${u.area} ft²`,
                  stdRate: u.stdRate, rent: u.rent, discountPct: R2((u.stdRate - u.rent) / u.stdRate * 100),
                });
              }
            }
          }
        }
      }
      discountedRows.sort((a, b) => b.discountPct - a.discountPct);
      groupRows.sort((a, b) => a.store.localeCompare(b.store) || a.type.localeCompare(b.type) || a.area - b.area);

      const haveData = !!liveSites;
      if (!haveData) debugWarn('[portal-v2] District Manager page rendering with mock data (no live unitRows/rentalActivityByTypeSize yet — run npm run pull).');
      const mockDiscounted = [
        { store: 'Bicester', unit: 'OFF3', type: 'Self Storage', area: 50, typeArea: 'Self Storage · 50 ft²', stdRate: 62.50, rent: 48.00, discountPct: 23.2 },
        { store: 'Newbury', unit: 'A114', type: 'Self Storage', area: 75, typeArea: 'Self Storage · 75 ft²', stdRate: 88.00, rent: 70.40, discountPct: 20.0 },
      ];
      const mockGroups = [
        { store: 'Bicester', type: 'Self Storage', area: 50, typeArea: 'Self Storage · 50 ft²', totalUnits: 40, occupied: 40, vacant: 0, occPct: 100, standardRate: 30.5, effectiveRate: 27.8, grossPotential: 61000, avgStay: 412 },
        { store: 'Newbury', type: 'Drive Up', area: 100, typeArea: 'Drive Up · 100 ft²', totalUnits: 22, occupied: 20, vacant: 2, occPct: 90.9, standardRate: 24.0, effectiveRate: 22.1, grossPotential: 52800, avgStay: 305 },
      ];
      const dRows = haveData ? discountedRows : mockDiscounted;
      const gRows = haveData ? groupRows : mockGroups;

      // Unit Groups — Stay & Re-Lease widget-local filters (14 Jul 2026, Michael: "condense... add a
      // filter for that specific widget to filter by location and by type or both, all of them or
      // none of them"). Separate from the page-wide store filter — this table alone can run into the
      // thousands of rows across the whole portfolio (1300+ confirmed via npm run probe:dm-groupkey),
      // so it needs its own narrower controls regardless of what the global store filter is set to.
      // Options are built from gRows itself (not a hardcoded list) so they always match what's
      // actually on the table; 'All' on either axis means no filtering on that axis, and the two
      // combine with AND — pick both for one exact slice, either alone to narrow one axis, or leave
      // both on 'All' to see everything (today's unfiltered behavior).
      const dmLocations = ['All', ...new Set(gRows.map((r) => r.store))].sort((a, b) => a === 'All' ? -1 : b === 'All' ? 1 : a.localeCompare(b));
      const dmTypes = ['All', ...new Set(gRows.map((r) => r.type))].sort((a, b) => a === 'All' ? -1 : b === 'All' ? 1 : a.localeCompare(b));
      const gRowsFiltered = gRows.filter((r) => (dmGroupLocation === 'All' || r.store === dmGroupLocation) && (dmGroupType === 'All' || r.type === dmGroupType));
      const selStyle = { fontFamily: 'inherit', fontSize: '12px', padding: '5px 8px', border: '1px solid #E4E7EC', borderRadius: '7px', background: '#fff', color: '#344054' };
      const dmGroupFilterControls = (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <select value={dmGroupLocation} onChange={(e) => setDmGroupLocation(e.target.value)} style={selStyle}>
            {dmLocations.map((l) => <option key={l} value={l}>{l === 'All' ? 'All locations' : l}</option>)}
          </select>
          <select value={dmGroupType} onChange={(e) => setDmGroupType(e.target.value)} style={selStyle}>
            {dmTypes.map((t) => <option key={t} value={t}>{t === 'All' ? 'All types' : t}</option>)}
          </select>
          {(dmGroupLocation !== 'All' || dmGroupType !== 'All') && (
            <button onClick={() => { setDmGroupLocation('All'); setDmGroupType('All'); }} style={{ fontFamily: 'inherit', fontSize: '12px', fontWeight: 500, color: '#2757E8', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 2px' }}>Clear</button>
          )}
        </div>
      );

      // Watchdog — Discounted Units widget-local filters (15 Jul 2026, Michael: "adda filter to watch
      // dog as well same on the unit groups one") — same Location/Type/AND/Clear pattern as Unit
      // Groups — Stay & Re-Lease above, but built off dRows (its own store/type shape) and its own
      // state, since the two tables can be filtered independently.
      const dmWatchLocations = ['All', ...new Set(dRows.map((r) => r.store))].sort((a, b) => a === 'All' ? -1 : b === 'All' ? 1 : a.localeCompare(b));
      const dmWatchTypes = ['All', ...new Set(dRows.map((r) => r.type))].sort((a, b) => a === 'All' ? -1 : b === 'All' ? 1 : a.localeCompare(b));
      const dRowsFiltered = dRows.filter((r) => (dmWatchLocation === 'All' || r.store === dmWatchLocation) && (dmWatchType === 'All' || r.type === dmWatchType));
      const dmWatchFilterControls = (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <select value={dmWatchLocation} onChange={(e) => setDmWatchLocation(e.target.value)} style={selStyle}>
            {dmWatchLocations.map((l) => <option key={l} value={l}>{l === 'All' ? 'All locations' : l}</option>)}
          </select>
          <select value={dmWatchType} onChange={(e) => setDmWatchType(e.target.value)} style={selStyle}>
            {dmWatchTypes.map((t) => <option key={t} value={t}>{t === 'All' ? 'All types' : t}</option>)}
          </select>
          {(dmWatchLocation !== 'All' || dmWatchType !== 'All') && (
            <button onClick={() => { setDmWatchLocation('All'); setDmWatchType('All'); }} style={{ fontFamily: 'inherit', fontSize: '12px', fontWeight: 500, color: '#2757E8', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 2px' }}>Clear</button>
          )}
        </div>
      );

      out.statCards = [
        { title: 'Discounted Units in Full Groups', live: haveData && hasUnitRowData && hasRentalActivityGroupData, tip: 'Report: RentalActivity; RentRoll.\nFields: TotalUnits, Vacant, StandardRate (RentalActivity, group-level); dcStdRate, dcRent (RentRoll, per unit).\nCalculation: Units in a (type, size) group where Vacant = 0 (100% full) and the unit\'s own dcRent < dcStdRate — count across selected stores.', tiles: [{ value: intFmt((haveData && hasUnitRowData && hasRentalActivityGroupData) ? dRows.length : 0), label: 'Units', delta: null, dir: null }] },
        { title: 'Groups Analyzed', live: haveData && hasRentalActivityGroupData, tip: 'Report: RentalActivity.\nFields: Type, Area.\nCalculation: Count of distinct (store, Type, rounded Area) groups across the selected stores.', tiles: [{ value: intFmt((haveData && hasRentalActivityGroupData) ? gRows.length : 0), label: '(store, type, size) groups', delta: null, dir: null }] },
      ];
      out.chartCards = [];
      out.tables = [
        // NARROWED 21 Jul 2026 (Michael: "make all the big tables narrower... put them next to
        // eachother", no exceptions) — pairs 2-up with Unit Groups — Stay & Re-Lease below.
        { title: 'Watchdog — Discounted Units in Fully Occupied Groups', live: haveData && hasUnitRowData && hasRentalActivityGroupData, pageSize: 20, collapsible: true,
          tip: 'Report: RentalActivity; RentRoll.\nFields: TotalUnits, Vacant (RentalActivity, group-level); dcStdRate, dcRent, sUnit (RentRoll, per unit).\nCalculation: A unit qualifies when its (type, size) group has Vacant = 0 and its own dcRent < dcStdRate. Discount % = (dcStdRate − dcRent) ÷ dcStdRate × 100. Use the filters above to narrow this down.\nNote: needs RentRoll\'s per-unit detail, only captured for months locked since 14 Jul 2026 — earlier months will show as empty, not zero.',
          headerExtra: dmWatchFilterControls,
          // CONDENSED 15 Jul 2026 (Michael: "too much going on"): Type + Area merged into one "Unit
          // Group" column (e.g. "Self Storage · 50 ft²") — same information, one less column to scan.
          columns: [
            { key: 'store', label: 'Store', type: 'text' },
            { key: 'unit', label: 'Unit', type: 'text' },
            { key: 'typeArea', label: 'Unit Group', type: 'text' },
            { key: 'stdRate', label: 'Standard Rate (£/mo)', type: 'money2', align: 'right' },
            { key: 'rent', label: 'Actual Rent (£/mo)', type: 'money2', align: 'right' },
            { key: 'discountPct', label: 'Discount %', type: 'pct', align: 'right' },
          ],
          rows: dRowsFiltered.length ? dRowsFiltered : [{
            store: hasUnitRowData
              ? (hasRentalActivityGroupData ? '(no discounted units match this filter)' : '(group-level rental-activity data is not available for this period)')
              : '(unit-level detail not available for this period — only captured for months locked since 14 Jul 2026)',
            unit: null, typeArea: null, stdRate: null, rent: null, discountPct: null,
          }],
        },
        // NARROWED 21 Jul 2026 — pairs with Watchdog — Discounted Units above.
        { title: 'Unit Groups — Stay & Re-Lease', live: haveData && hasRentalActivityGroupData, pageSize: 20, collapsible: true,
          tip: 'Report: RentalActivity; RentRoll.\nFields: TotalUnits, Occupied, StandardRate, OccupiedDollarPerArea (RentalActivity); dLeaseDate (RentRoll, per unit).\nCalculation: Occupied % = Occupied ÷ TotalUnits × 100. Standard Rate (£/mo per unit) is the average list rate for units in that group. Effective Rate (£/ft²/yr) = OccupiedDollarPerArea, reflecting concessions on the occupied area. Avg Stay = mean(days since dLeaseDate as of the stored pull snapshot) across the group\'s units, in days — excludes re-lease/vacancy time (not tracked by SiteLink). Use the filters above to narrow this down.',
          headerExtra: dmGroupFilterControls,
          // CONDENSED 15 Jul 2026: same Type+Area merge as the Watchdog table above.
          columns: [
            { key: 'store', label: 'Store', type: 'text' },
            { key: 'typeArea', label: 'Unit Group', type: 'text' },
            { key: 'totalUnits', label: 'Units', type: 'int', align: 'right' },
            { key: 'occPct', label: 'Occupied %', type: 'pct', align: 'right', color: 'threshold' },
            { key: 'standardRate', label: 'Standard Rate (£/mo)', type: 'money2', align: 'right' },
            { key: 'effectiveRate', label: 'Effective Rate (£/ft²/yr)', type: 'money2', align: 'right' },
            { key: 'avgStay', label: 'Avg Stay (days)', type: 'int', align: 'right' },
          ],
          rows: gRowsFiltered.length ? gRowsFiltered : [{ store: hasRentalActivityGroupData ? '(no groups match this filter)' : '(group-level rental-activity data is not available for this period)', typeArea: null, totalUnits: null, occPct: null, standardRate: null, effectiveRate: null, avgStay: null }],
        },
      ];

      // Two more DM widgets (added 15 Jul 2026, Michael: "add the ones you think are important" — of
      // the twelve Qstrom-inspired widgets he originally photographed, only 5 were ever individually
      // named anywhere in this codebase; the other 7 have no recoverable spec without the original
      // screenshots, so these are two NEW, genuinely useful DM-scoped additions built entirely from
      // data already pulled — no new SiteLink calls. Both surface a per-SITE view of numbers that
      // today only exist as portfolio-wide aggregates elsewhere on this page: a DM needs to know WHICH
      // store is sliding or WHICH store has a collections problem, not just the portfolio average.

      // Occupancy Decline vs Last Month — reuses livePrevSites (same "vs last month" snapshot every
      // other totals-row delta on this page already depends on), matched by store name like every
      // other live/prev pairing in this file. Degrades gracefully (empty table, no LIVE badge) when
      // livePrevSites isn't available yet, exactly like the delta ticks elsewhere.
      const occDeclineHave = !!(haveData && livePrevSites);
      const occDeclineRows = occDeclineHave ? dmSites.map((s) => {
        const prev = livePrevSites.find((p) => p.name === s.name);
        if (!prev) return null;
        const curPct = s.occPC || 0, prevPct = prev.occPC || 0;
        return { store: s.name, curPct, prevPct, change: R2(curPct - prevPct) };
      }).filter(Boolean).sort((a, b) => a.change - b.change) : [];
      const mockOccDecline = [
        { store: 'Newmarket', curPct: 61.1, prevPct: 66.4, change: -5.3 },
        { store: 'Enfield', curPct: 31.7, prevPct: 35.0, change: -3.3 },
        { store: 'Bicester', curPct: 96.0, prevPct: 94.5, change: 1.5 },
      ];
      const occDeclineFinal = occDeclineHave ? occDeclineRows : (haveData ? [] : mockOccDecline);
      const sitesDecliningCount = occDeclineFinal.filter((r) => r.change < 0).length;

      // Delinquency by Site — same ManagementSummary delinquent_30plus_* fields as the Financials
      // page's portfolio-wide "Debtor Levels" stat card (lib/buildPayload.js's `debtors` object),
      // just broken out per site and sorted worst-first instead of summed into one number.
      const delinquencyRows = dmSites.filter((s) => s.debtors && (s.debtors.accounts > 0 || s.debtors.total > 0))
        .map((s) => ({
          store: s.name, accounts: s.debtors.accounts || 0, total: s.debtors.total || 0,
          tenantPct: s.occ ? (s.debtors.tenantPct || 0) : null,
          rentRollPct: s.occActualRent ? (s.debtors.rentRollPct || 0) : null,
        }))
        .sort((a, b) => ((b.rentRollPct ?? -Infinity) - (a.rentRollPct ?? -Infinity)));
      const mockDelinquency = [
        { store: 'Sittingbourne', accounts: 14, total: 3200, tenantPct: 4.2, rentRollPct: 3.1 },
        { store: 'Letchworth', accounts: 9, total: 2100, tenantPct: 2.8, rentRollPct: 2.0 },
      ];
      const delinquencyFinal = haveData ? delinquencyRows : mockDelinquency;

      out.statCards.push(
        { title: 'Sites Losing Occupancy', live: occDeclineHave, tip: 'Report: OccupancyStatistics.\nFields: Occupied, TotalUnits.\nCalculation: occPC = Occupied ÷ TotalUnits × 100, per site, for the selected month vs its prior month (same snapshot every "vs last month" delta on this page uses). Count of sites where the selected month\'s occPC is lower.', tiles: [{ value: intFmt(sitesDecliningCount), label: 'Sites declining', delta: null, dir: null }] },
        { title: 'Sites with Delinquent Accounts', live: haveData, tip: 'Report: ManagementSummary, same source as the Financials page\'s Debtor Levels card.\nFields: dcDlqntTot, iDelUnits, Period ("Unpaid" ageing table).\nCalculation: Count of sites with iDelUnits > 0 summed across the 30+ day buckets (31-60 through 361+; 0-10/11-30 excluded).', tiles: [{ value: intFmt(delinquencyFinal.length), label: 'Sites flagged', delta: null, dir: null }] },
      );
      out.tables.push(
        // NARROWED 21 Jul 2026 (Michael: "make all the big tables narrower... put them next to
        // eachother", no exceptions) — pairs 2-up with Watchdog — Delinquency by Site below (both
        // narrow now, so this DM page's last row of tables sits side by side too).
        { title: 'Watchdog — Occupancy Decline vs Last Month', live: occDeclineHave, pageSize: 20, collapsible: true,
          tip: 'Report: OccupancyStatistics.\nFields: Occupied, TotalUnits.\nCalculation: occPC = Occupied ÷ TotalUnits × 100, per site, for the selected month vs its prior month. Change = selected month occPC − prior month occPC. Sorted worst decline first; a positive Change means occupancy improved, not worsened.',
          columns: [
            { key: 'store', label: 'Store', type: 'text' },
            { key: 'curPct', label: 'Occupancy % (This Month)', type: 'pct', align: 'right', color: 'threshold' },
            { key: 'prevPct', label: 'Occupancy % (Prior Month)', type: 'pct', align: 'right' },
            { key: 'change', label: 'Change (pts)', type: 'pct', align: 'right', color: 'delta' },
          ],
          rows: occDeclineFinal.length ? occDeclineFinal : [{ store: '(no prior-month data available yet — run npm run pull again next month)', curPct: null, prevPct: null, change: null }],
        },
        { title: 'Watchdog — Delinquency by Site', live: haveData, pageSize: 20, collapsible: true,
          tip: 'Report: ManagementSummary, same source as the Financials page\'s Debtor Levels card, broken out per site.\nFields: dcDlqntTot, iDelUnits ("Unpaid" ageing table, 30+ day buckets only).\nCalculation: % of Tenants = delinquent accounts ÷ occupied units × 100. % of Rent Roll = delinquent balance ÷ occupied rent roll × 100. Sorted worst Rent Roll % first. If a site has no occupied units or no occupied rent in scope, the corresponding percentage is left blank rather than shown as a fake 0%.',
          columns: [
            { key: 'store', label: 'Store', type: 'text' },
            { key: 'accounts', label: 'Delinquent Accounts', type: 'int', align: 'right' },
            { key: 'total', label: 'Delinquent Balance', type: 'money', align: 'right' },
            { key: 'tenantPct', label: '% of Tenants', type: 'pct', align: 'right' },
            { key: 'rentRollPct', label: '% of Rent Roll', type: 'pct', align: 'right' },
          ],
          rows: delinquencyFinal.length ? delinquencyFinal : [{ store: '(no delinquent accounts in this period)', accounts: null, total: null, tenantPct: null, rentRollPct: null }],
        },
      );

      // Cockpit Charting (task #174/#207) — day-by-day cumulative income for the selected end month
      // vs a 3-month-
      // average pace line. See lib/pullCockpit.js/lib/cockpitData.js for why this needed a whole new
      // daily pull (a real growing time series), unlike every other District Manager widget above,
      // which reuse data that was already being pulled monthly.
      const cockpitOk = !!(liveCockpit && liveCockpit.curve && liveCockpit.curve.length);
      const haveCockpitDataset = liveCockpit !== null;
      if (!cockpitOk) {
        if (haveCockpitDataset) debugWarn('[portal-v2] Cockpit Charting has no daily rows for the selected month/store scope.');
        else debugWarn('[portal-v2] Cockpit Charting rendering with mock data (no daily_financial_snapshot rows yet — run npm run pull:cockpit, then again daily to build up the curve).');
      }
      const cockpitMonthKey = liveCockpit && liveCockpit.month ? liveCockpit.month : monthKeyOf(monthTo);
      const cockpitCurve = cockpitOk
        ? padDailyMonthCurve(liveCockpit.curve, cockpitMonthKey, () => ({ total_charge: 0 }))
        : haveCockpitDataset
          ? []
          : Array.from({ length: 14 }, (_, i) => ({ date: `mock-${i + 1}`, total_charge: 3200 * (i + 1) + (i % 3) * 400 }));
      const cockpitSelectedCodes = (() => {
        return (pageHasSelectedStores && liveSites && liveSites.length) ? new Set(liveSites.map((s) => s.code)) : null;
      })();
      const cockpitScopedHasRows = cockpitSelectedCodes
        ? cockpitCurve.some((c) => (c.sites || []).some((site) => cockpitSelectedCodes.has(site.code)))
        : cockpitOk;
      const cockpitActual = cockpitSelectedCodes
        ? (() => {
          if (!cockpitScopedHasRows) return null;
          const lastByCode = new Map();
          return cockpitCurve.map((c) => {
            for (const site of (c.sites || [])) {
              if (cockpitSelectedCodes.has(site.code)) lastByCode.set(site.code, site.total_charge || 0);
            }
            let sum = 0;
            for (const code of cockpitSelectedCodes) sum += lastByCode.get(code) || 0;
            return sum;
          });
        })()
        : (cockpitOk ? cockpitCurve.map((c) => (c.total_charge || 0)) : null);
      // FIXED 24 Jul 2026 (task #432, same bug class as the MoM fix, task #427/#430): previously fell
      // back to the PORTFOLIO-WIDE liveCockpit.avgDailyRate whenever the selected store(s) had zero
      // revenue in all 3 lookback months (e.g. a newly-added site with no history that far back) --
      // silently mixing a real, correctly store-scoped "Actual" line/tile with a portfolio-wide "pace"
      // one, with no note or visual distinction between them. Now returns null when a store filter is
      // active and there's no usable store-scoped history for the lookback window, instead of
      // substituting unrelated portfolio data -- the stat tile and chart below both handle that null
      // explicitly (an honest "N/A" / an omitted pace line, rather than a fabricated number).
      const cockpitAvgRate = (() => {
        if (!cockpitSelectedCodes) return haveCockpitDataset ? liveCockpit?.avgDailyRate ?? null : 3400;
        if (!liveMonthly) return null;
        const prevKeys = [1, 2, 3].map((n) => monthKeyOf(indexOfMonthKey(cockpitMonthKey) - n));
        const dailyRates = prevKeys.map((mk) => {
          const recs = liveMonthly[mk] || [];
          const revenue = recs
            .filter((r) => cockpitSelectedCodes.has(r.code))
            .reduce((sum, r) => sum + (r.revenue ? r.revenue.collected || 0 : 0), 0);
          if (!revenue) return null;
          const [yy, mm] = mk.split('-').map(Number);
          return revenue / new Date(yy, mm, 0).getDate();
        }).filter((v) => v != null);
        return dailyRates.length === 3 ? dailyRates.reduce((a, b) => a + b, 0) / dailyRates.length : null;
      })();
      // FIXED 16 Jul 2026 (deep re-audit #4): was `cockpitAvgRate * (i + 1)` -- i is this row's
      // POSITION in cockpitCurve, not the real day-of-month. daily_financial_snapshot doesn't
      // necessarily get a row every single calendar day (confirmed live via
      // probe-cockpit-pace-coverage.js: the underlying 3-month avgDailyRate was correct at £47,161/
      // day, but the widget showed a pace of £94,322 at day 15 -- exactly 47,161 × 2, meaning the
      // curve only had 2 rows so far this month, not 15). The label line right below this already
      // derives the true day-of-month from c.date for the same reason -- reuse that here instead of
      // the array index so a sparse curve doesn't understate the pace line.
      const cockpitPace = cockpitAvgRate == null ? null : cockpitCurve.map((c, i) => Math.round(cockpitAvgRate * (cockpitOk ? new Date(c.date).getDate() : (i + 1))));
      const cockpitLabels = cockpitCurve.map((c, i) => cockpitOk ? String(new Date(c.date).getDate()) : String(i + 1));
      const cockpitToDate = (cockpitOk && cockpitActual && cockpitActual.length) ? (cockpitActual[cockpitActual.length - 1] || 0) : null;
      const cockpitPaceToDate = cockpitOk && cockpitPace ? (cockpitPace[cockpitPace.length - 1] || 0) : null;
      const [cockpitYear, cockpitMonth] = cockpitMonthKey.split('-').map(Number);
      const cockpitMonthLabel = new Date(cockpitYear, cockpitMonth - 1, 1).toLocaleString('en-GB', { month: 'short', year: 'numeric' });
      out.statCards.push({
        title: `Cockpit — ${cockpitMonthLabel}`, live: cockpitOk,
        tip: 'Report: FinancialSummary.\nFields: Charge (summed to total_charge) — pulled daily for Actual, from the last 3 closed months\' monthly pull for Pace.\nCalculation: Actual = cumulative Σ Charge across the selected stores from the selected end month\'s first day through the last complete stored day for that month (not intraday today). 3-month avg pace = mean(each of the 3 closed months before that selected month\'s total_charge ÷ days in that month) for that same store scope × the same day-of-month.\nNote: pace shows N/A when the selected store(s) have no billing history in all 3 lookback months (24 Jul 2026 fix — previously silently substituted the portfolio-wide average instead).',
        tiles: [
          cockpitToDate == null
            ? { value: 'N/A', label: cockpitSelectedCodes ? 'No rows for selected store scope yet' : 'No rows for selected month yet', delta: null, dir: null }
            : { value: money(cockpitToDate), label: 'Actual', delta: null, dir: null },
          cockpitPaceToDate == null
            ? { value: 'N/A', label: 'No history for 3-month pace', delta: null, dir: null }
            : { value: money(cockpitPaceToDate), label: '3-month avg pace', delta: null, dir: null },
        ],
      });
      out.chartCards.push({
        title: `Cockpit — ${cockpitMonthLabel} vs 3-Month Average Pace`, wide: true,
        tip: 'Report: FinancialSummary.\nFields: Charge (summed to total_charge) — pulled daily for Actual, from the last 3 closed months\' monthly pull for Pace.\nCalculation: Actual = cumulative Σ Charge for the selected stores in the selected end month, day by day, through the last complete stored day only. Pace = mean(the 3 closed months before that selected month\'s total_charge ÷ days in month) for that same store scope × day-of-month — a reference line, not real history.\nNote: pace line is omitted when the selected store(s) have no billing history in all 3 lookback months.',
        el: cockpitOk
          ? (cockpitActual && cockpitActual.length
              ? <LineChart series={cockpitPace ? [{ name: `${cockpitMonthLabel} (cumulative)`, color: C.blue, values: cockpitActual }, { name: '3-month avg pace', color: C.blue, dashed: true, values: cockpitPace }] : [{ name: `${cockpitMonthLabel} (cumulative)`, color: C.blue, values: cockpitActual }]} opts={{ labels: cockpitLabels, zero: true }} />
              : <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>No cockpit daily rows for the selected store scope this month yet.</div>)
          : haveCockpitDataset
            ? <div style={{ padding: '32px 12px', textAlign: 'center', color: C.slate, fontSize: 13 }}>No cockpit daily rows for the selected month yet.</div>
            : <LineChart series={cockpitPace ? [{ name: `${cockpitMonthLabel} (cumulative)`, color: C.blue, values: cockpitActual }, { name: '3-month avg pace', color: C.blue, dashed: true, values: cockpitPace }] : [{ name: `${cockpitMonthLabel} (cumulative)`, color: C.blue, values: cockpitActual }]} opts={{ labels: cockpitLabels, zero: true }} />,
      });
    }

    return out;
  }

  const pageData = buildPage(page);

  // ---------- export (Excel) ----------
  const exportItemsRef = useRef([]);
  function exportLiveSites() {
    if (!liveSitesRaw) return null;
    const selectedLiveNames = new Set(
      Object.entries(selected)
        .filter(([, on]) => on)
        .map(([name]) => name)
        .filter((name) => liveSitesRaw.some((s) => s.name === name))
    );
    const rows = selectedLiveNames.size ? liveSitesRaw.filter((s) => selectedLiveNames.has(s.name)) : liveSitesRaw;
    return rows.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }
  function exportLiveSiteMap() {
    const rows = exportLiveSites() || [];
    return Object.fromEntries(rows.map((s) => [s.code, s]));
  }
  function exportSnapshotRows() {
    const snap = liveSnapshot && liveSnapshot[snapshotPeriod];
    if (!snap || !Array.isArray(snap.sites)) return null;
    const siteMap = exportLiveSiteMap();
    const selectedNames = new Set(
      Object.entries(selected)
        .filter(([, on]) => on)
        .map(([name]) => name)
        .filter((name) => snap.sites.some((r) => exportSnapshotStoreName(r, siteMap) === name))
    );
    const rows = snap.sites.filter((r) => !selectedNames.size || selectedNames.has(exportSnapshotStoreName(r, siteMap)));
    return rows.slice().sort((a, b) => exportSnapshotStoreName(a, siteMap).localeCompare(exportSnapshotStoreName(b, siteMap)));
  }
  const exportSnapshotStoreName = (row, siteMap) => row.store || (siteMap[row.code] && siteMap[row.code].name) || SITE_NAME_BY_CODE[row.code] || row.code;
  function toSheet(columns, rows, totals, totalsLabel = 'Total') {
    const keys = columns.map((c) => c.key);
    const aoa = [columns.map((c) => c.label), ...rows.map((r) => keys.map((k) => r[k]))];
    if (totals) aoa.push(keys.map((k, i) => (i === 0 ? totalsLabel : (totals[k] ?? ''))));
    return aoa;
  }
  const sumBy = (rows, fn) => rows.reduce((a, row) => a + fn(row), 0);
  const moveInRateForSite = (s) => (s.moveInAreaSum ? R2((s.moveInRateSum || 0) / s.moveInAreaSum * 12) : null);
  const moveInVarianceRawPctForSite = (s) => (s.moveInStdRateSum ? R2((s.moveInVarianceSum || 0) / s.moveInStdRateSum * 100) : null);
  const avgCustomerValueForSite = (s) => ((s.stayCount || 0) > 0 && (s.avgStayDays > 0)) ? R2(((((s.stayRentSum ?? s.rent) || 0) / s.stayCount) * (s.avgStayDays / 30.43))) : null;
  const autobillConversionForSite = (s) => (s.autobillNewTotal ? +((((s.autobillNewCountExact ?? s.autobillNewCount) || 0) / s.autobillNewTotal) * 100).toFixed(1) : null);
  const insuranceConversionForSite = (s) => (s.moveIns ? Math.min(100, +((((s.insuredNewCustomers && s.insuredNewCustomers.count) || 0) / s.moveIns) * 100).toFixed(1)) : null);
  const insuranceContentsAvgForSite = (s) => {
    const count = (s.insuredNewCustomers && s.insuredNewCustomers.count) || 0;
    return count ? R2((s.insuredNewCustomers.coverageSum || 0) / count) : null;
  };
  const insurancePremiumWeeklyForSite = (s) => (s.moveIns ? R2((((s.insuredNewCustomers && s.insuredNewCustomers.premiumSum) || 0) / s.moveIns) / 4) : null);
  const merchandiseSalesForSite = (s) => (s.merchandise && s.merchandise.chargeFromFinancial) || 0;
  const merchandiseIncomePerNewCustomerForSite = (s) => (s.moveIns ? R2(merchandiseSalesForSite(s) / s.moveIns) : null);
  const discountTotalForSite = (s) => (s.discountPlans || []).reduce((a, row) => a + (row.discount || 0), 0);
  function statCardExportAoa(pk, card) {
    const title = card.title;
    const sites = exportLiveSites();
    const snapshotRows = exportSnapshotRows();
    const siteMap = exportLiveSiteMap();
    const blendedSqftPerReservation = normalizedReservationSqftPerReservation(sites);
    if (pk === 'dashboard' && title === 'Move-ins & Move-outs' && sites) {
      const rows = sites.map((s) => ({ store: s.name, moveIns: s.moveIns || 0, moveOuts: s.moveOuts || 0, netFt: s.netArea || 0 }));
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'moveIns', label: 'Move-ins' }, { key: 'moveOuts', label: 'Move-outs' }, { key: 'netFt', label: 'Net ft²' }],
        rows,
        { moveIns: sumBy(rows, (r) => r.moveIns), moveOuts: sumBy(rows, (r) => r.moveOuts), netFt: sumBy(rows, (r) => r.netFt) },
      );
    }
    if (pk === 'dashboard' && title === 'Enquiries' && sites) {
      const rows = sites.map((s) => ({
        store: s.name,
        phone: s.enquiries?.phone || 0,
        walkins: s.enquiries?.walkin || 0,
        web: enquiryWebVisible(s.enquiries),
        total: enquiryTotalVisible(s.enquiries),
      }));
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'phone', label: 'Phone' }, { key: 'walkins', label: 'Walk-ins' }, { key: 'web', label: 'Web' }, { key: 'total', label: 'Visible Total' }],
        rows,
        { phone: sumBy(rows, (r) => r.phone), walkins: sumBy(rows, (r) => r.walkins), web: sumBy(rows, (r) => r.web), total: sumBy(rows, (r) => r.total) },
      );
    }
    if (pk === 'kpis' && title === 'Total Store Occupancy' && sites) {
      const rows = sites.map((s) => ({ store: s.name, occupancyPct: s.occPC || 0, rate: s.rate || 0, occSqft: s.occA || 0, occupiedUnits: s.occ || 0, totalUnits: s.tot || 0 }));
      const totals = computeTotals(sites);
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'occupancyPct', label: 'Occupancy %' }, { key: 'rate', label: 'Rate per ft²' }, { key: 'occSqft', label: 'Total Occupancy (sqft)' }, { key: 'occupiedUnits', label: 'Occupied Units' }, { key: 'totalUnits', label: 'Total Units' }],
        rows,
        { occupancyPct: totals.occPC || 0, rate: totals.rate || 0, occSqft: totals.occA || 0, occupiedUnits: totals.occ || 0, totalUnits: totals.tot || 0 },
        'Portfolio',
      );
    }
    if (pk === 'kpis' && title === 'Self Storage' && sites) {
      const rows = sites.map((s) => ({ store: s.name, occupancyPct: s.ss?.occPC || 0, rate: s.ssRate || 0, occupiedUnits: s.ss?.occ || 0, totalUnits: s.ss?.tot || 0 }));
      const totals = computeTotals(sites);
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'occupancyPct', label: 'Unit Occupancy %' }, { key: 'rate', label: 'Rate per ft²' }, { key: 'occupiedUnits', label: 'Occupied Units' }, { key: 'totalUnits', label: 'Total Units' }],
        rows,
        { occupancyPct: totals.ssOccPC || 0, rate: totals.ssRate || 0, occupiedUnits: totals.ssOcc || 0, totalUnits: totals.ssTot || 0 },
        'Portfolio',
      );
    }
    if (pk === 'kpis' && title === 'Offices Occupancy' && sites) {
      const rows = sites.map((s) => ({ store: s.name, occupancyPct: s.offices?.occPC || 0, rate: s.offices?.rate || 0, occupiedUnits: s.offices?.occ || 0, totalUnits: s.offices?.tot || 0 }));
      const totals = computeTotals(sites);
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'occupancyPct', label: 'Occupancy %' }, { key: 'rate', label: 'Rate per ft²' }, { key: 'occupiedUnits', label: 'Occupied Units' }, { key: 'totalUnits', label: 'Total Units' }],
        rows,
        { occupancyPct: totals.officesOccPC || 0, rate: totals.officesRate || 0, occupiedUnits: totals.officesOcc || 0, totalUnits: totals.officesTot || 0 },
        'Portfolio',
      );
    }
    if (pk === 'kpis' && title === 'Scheduled Reservations vs Scheduled Move-outs' && sites) {
      const rows = sites.map((s) => ({ store: s.name, reservations: s.activeReservations || 0, moveOuts: s.scheduledOuts || 0, netChange: (s.activeReservations || 0) - (s.scheduledOuts || 0) }));
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'reservations', label: 'Active reservations (stored snapshot)' }, { key: 'moveOuts', label: 'Scheduled move-outs (stored snapshot)' }, { key: 'netChange', label: 'Net change' }],
        rows,
        { reservations: sumBy(rows, (r) => r.reservations), moveOuts: sumBy(rows, (r) => r.moveOuts), netChange: sumBy(rows, (r) => r.netChange) },
      );
    }
    if (pk === 'kpis' && title === 'Reserved Scheduled Sqft' && sites) {
      const rows = sites.map((s) => ({ store: s.name, reservedSqft: s.reservedSqftEstimate || 0, reservations: s.activeReservations || 0 }));
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'reservedSqft', label: 'Reserved sqft' }, { key: 'reservations', label: 'Active reservations (stored snapshot)' }],
        rows,
        { reservedSqft: sumBy(rows, (r) => r.reservedSqft), reservations: sumBy(rows, (r) => r.reservations) },
      );
    }
    if (pk === 'kpis' && title === 'Debtor Levels' && sites) {
      const rows = sites.map((s) => ({
        store: s.name,
        tenantPct: s.occ ? (s.debtors?.tenantPct || 0) : null,
        rentRollPct: s.occActualRent ? (s.debtors?.rentRollPct || 0) : null,
        total: s.debtors?.total || 0,
      }));
      const totals = computeTotals(sites);
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'tenantPct', label: '% Tenants' }, { key: 'rentRollPct', label: '% Rent Roll' }, { key: 'total', label: 'Total overdue' }],
        rows,
        { tenantPct: totals.occ ? totals.debtorTenantPct : null, rentRollPct: totals.occActualRent ? totals.debtorRentRollPct : null, total: totals.debtorTotal || 0 },
        'Portfolio',
      );
    }
    if (pk === 'kpis' && title === 'Move-ins & Move-outs' && sites) {
      const rows = sites.map((s) => ({
        store: s.name,
        moveIns: s.moveIns || 0,
        moveOuts: s.moveOuts || 0,
        netMoveIns: (s.moveIns || 0) - (s.moveOuts || 0),
        sqftIn: s.moveInAreaSum || 0,
        sqftOut: -(s.moveOutAreaSum || 0),
        netFt: s.netArea || 0,
      }));
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'moveIns', label: 'Move-ins' }, { key: 'moveOuts', label: 'Move-outs' }, { key: 'netMoveIns', label: 'Net Move-ins' }, { key: 'sqftIn', label: 'Sqft In' }, { key: 'sqftOut', label: 'Sqft Out' }, { key: 'netFt', label: 'Net ft²' }],
        rows,
        { moveIns: sumBy(rows, (r) => r.moveIns), moveOuts: sumBy(rows, (r) => r.moveOuts), netMoveIns: sumBy(rows, (r) => r.netMoveIns), sqftIn: sumBy(rows, (r) => r.sqftIn), sqftOut: sumBy(rows, (r) => r.sqftOut), netFt: sumBy(rows, (r) => r.netFt) },
      );
    }
    if (pk === 'kpis' && title === 'Move-In Rental Rate' && sites) {
      const rows = sites.map((s) => ({
        store: s.name,
        rate: s.moveInAreaSum ? moveInRateForSite(s) : null,
        movedInArea: s.moveInAreaSum || 0,
      }));
      const totals = computeTotals(sites);
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'rate', label: 'Per ft² (selected period move-ins)' }, { key: 'movedInArea', label: 'Moved-in area' }],
        rows,
        { rate: totals.moveInAreaSum ? R2((totals.moveInRateSum || 0) / totals.moveInAreaSum * 12) : null, movedInArea: totals.moveInAreaSum || 0 },
        'Portfolio',
      );
    }
    if (pk === 'kpis' && title === 'Move-in Variance vs Standard Rate' && sites) {
      const rows = sites.map((s) => ({
        store: s.name,
        actualPct: s.moveInVarianceCount ? s.moveInVarStdRateActualPct : null,
        rawPct: s.moveInVarianceCount ? moveInVarianceRawPctForSite(s) : null,
        moveIns: s.moveInVarianceCount || 0,
      }));
      const totals = computeTotals(sites);
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'actualPct', label: 'Actual %' }, { key: 'rawPct', label: 'Raw %' }, { key: 'moveIns', label: 'Move-ins counted' }],
        rows,
        {
          actualPct: totals.moveInVarianceCount ? totals.moveInVarStdRateActualPct : null,
          rawPct: totals.moveInVarianceCount ? totals.moveInVarStdRatePct : null,
          moveIns: totals.moveInVarianceCount || 0,
        },
        'Portfolio',
      );
    }
    if (pk === 'financials' && title === 'Customer Insights' && sites) {
      const rows = sites.map((s) => ({
        store: s.name,
        avgCustomerValue: avgCustomerValueForSite(s),
        avgLengthOfStayDays: ((s.stayCount || 0) > 0 && (s.avgStayDays > 0)) ? s.avgStayDays : null,
      }));
      const finT = computeTotals(sites);
      const validStayCount = finT.stayCount || 0;
      const weightedStay = validStayCount ? ((finT.stayDaysSum || 0) / validStayCount) : null;
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'avgCustomerValue', label: 'Avg customer value' }, { key: 'avgLengthOfStayDays', label: 'Avg length of stay (days, valid lease dates only)' }],
        rows,
        { avgCustomerValue: weightedStay != null && validStayCount ? R2((((finT.stayRentSum || 0) / validStayCount) * (weightedStay / 30.43))) : null, avgLengthOfStayDays: weightedStay != null ? Math.round(weightedStay) : null },
        'Portfolio',
      );
    }
    if (pk === 'financials' && title === 'Past Due Balances' && sites) {
      const rows = sites.map((s) => ({
        store: s.name,
        totalOverdue: s.debtors?.total || 0,
        rentRollPct: s.occActualRent ? (s.debtors?.rentRollPct || 0) : null,
      }));
      const totals = computeTotals(sites);
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'totalOverdue', label: 'Total overdue (30+ days)' }, { key: 'rentRollPct', label: '% of rent roll' }],
        rows,
        { totalOverdue: totals.debtorTotal || 0, rentRollPct: totals.occActualRent ? totals.debtorRentRollPct : null },
        'Portfolio',
      );
    }
    if (pk === 'ancillaries' && title === 'Autobill Conversion' && sites) {
      const rows = sites.map((s) => ({
        store: s.name,
        conversionPct: s.autobillNewTotal ? autobillConversionForSite(s) : null,
        newAutobilledCustomers: s.autobillNewCount || 0,
        newCustomers: s.autobillNewTotal || 0,
      }));
      const totals = computeTotals(sites);
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'conversionPct', label: 'Conversion %' }, { key: 'newAutobilledCustomers', label: 'Avg new autobilled customers (est.)' }, { key: 'newCustomers', label: 'New customers' }],
        rows,
        { conversionPct: totals.autobillNewTotal ? totals.autobillPC : null, newAutobilledCustomers: totals.autobillNewCount || 0, newCustomers: totals.autobillNewTotal || 0 },
        'Portfolio',
      );
    }
    if (pk === 'ancillaries' && title === 'Insurance Conversion' && sites) {
      const rows = sites.map((s) => ({
        store: s.name,
        conversionPct: s.moveIns ? insuranceConversionForSite(s) : null,
        insuredNewCustomers: s.insuredNewCustomers?.count || 0,
        moveIns: s.moveIns || 0,
      }));
      const moveIns = sumBy(sites, (s) => s.moveIns || 0);
      const insuredNewCustomers = sumBy(sites, (s) => (s.insuredNewCustomers && s.insuredNewCustomers.count) || 0);
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'conversionPct', label: 'Conversion %' }, { key: 'insuredNewCustomers', label: 'Insured new customers' }, { key: 'moveIns', label: 'Move-ins' }],
        rows,
        { conversionPct: moveIns ? Math.min(100, +((insuredNewCustomers / moveIns) * 100).toFixed(1)) : null, insuredNewCustomers, moveIns },
        'Portfolio',
      );
    }
    if (pk === 'ancillaries' && title === 'Insurance Roll' && sites) {
      const rows = sites.map((s) => ({
        store: s.name,
        premiums: s.insurance?.premium || 0,
        pctRentRoll: s.rent ? +(((s.insurance?.premium || 0) / s.rent) * 100).toFixed(1) : null,
        pctInsured: s.occ ? (s.insurance?.penetration || 0) : null,
      }));
      const totals = computeTotals(sites);
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'premiums', label: 'Premiums' }, { key: 'pctRentRoll', label: '% Rent Roll' }, { key: 'pctInsured', label: '% Insured' }],
        rows,
        { premiums: totals.insurancePremium || 0, pctRentRoll: totals.rent ? totals.insurancePctRoll : null, pctInsured: totals.occ ? totals.insurancePctInsured : null },
        'Portfolio',
      );
    }
    if (pk === 'ancillaries' && title === 'Insurance Premiums (New Customers)' && sites) {
      const rows = sites.map((s) => ({
        store: s.name,
        contentsAvg: (s.insuredNewCustomers?.count || 0) ? insuranceContentsAvgForSite(s) : null,
        premiumsWeekly: s.moveIns ? insurancePremiumWeeklyForSite(s) : null,
      }));
      const totalCount = sumBy(sites, (s) => (s.insuredNewCustomers && s.insuredNewCustomers.count) || 0);
      const totalCoverage = sumBy(sites, (s) => (s.insuredNewCustomers && s.insuredNewCustomers.coverageSum) || 0);
      const totalPremium = sumBy(sites, (s) => (s.insuredNewCustomers && s.insuredNewCustomers.premiumSum) || 0);
      const totalMoveIns = sumBy(sites, (s) => s.moveIns || 0);
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'contentsAvg', label: 'Contents avg' }, { key: 'premiumsWeekly', label: 'Premiums weekly' }],
        rows,
        { contentsAvg: totalCount ? R2(totalCoverage / totalCount) : null, premiumsWeekly: totalMoveIns ? R2((totalPremium / totalMoveIns) / 4) : null },
        'Portfolio',
      );
    }
    if (pk === 'ancillaries' && title === 'Merchandise Income per New Customer' && sites) {
      const rows = sites.map((s) => ({
        store: s.name,
        incomePerNewCustomer: s.moveIns ? merchandiseIncomePerNewCustomerForSite(s) : null,
        moveIns: s.moveIns || 0,
        merchandiseSales: merchandiseSalesForSite(s),
      }));
      const totalMoveIns = sumBy(sites, (s) => s.moveIns || 0);
      const totalSales = sumBy(sites, (s) => merchandiseSalesForSite(s));
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'incomePerNewCustomer', label: 'Income per new customer' }, { key: 'moveIns', label: 'Move-ins' }, { key: 'merchandiseSales', label: 'Merchandise sales' }],
        rows,
        { incomePerNewCustomer: totalMoveIns ? R2(totalSales / totalMoveIns) : null, moveIns: totalMoveIns, merchandiseSales: totalSales },
        'Portfolio',
      );
    }
    if (pk === 'ancillaries' && title === 'Merchandise Sales' && sites) {
      const rows = sites.map((s) => ({ store: s.name, merchandiseSales: merchandiseSalesForSite(s) }));
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'merchandiseSales', label: 'Merchandise sales' }],
        rows,
        { merchandiseSales: sumBy(rows, (r) => r.merchandiseSales) },
      );
    }
    if (pk === 'marketing' && title === 'Enquiries by Channel' && sites) {
      const rows = sites.map((s) => ({
        store: s.name,
        phone: s.enquiries?.phone || 0,
        walkins: s.enquiries?.walkin || 0,
        web: enquiryWebVisible(s.enquiries),
        total: enquiryTotalVisible(s.enquiries),
      }));
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'phone', label: 'Phone' }, { key: 'walkins', label: 'Walk-ins' }, { key: 'web', label: 'Web' }, { key: 'total', label: 'Visible Total' }],
        rows,
        { phone: sumBy(rows, (r) => r.phone), walkins: sumBy(rows, (r) => r.walkins), web: sumBy(rows, (r) => r.web), total: sumBy(rows, (r) => r.total) },
      );
    }
    if (pk === 'marketing' && title === 'Enquiry → Reservation' && sites) {
      const rows = sites.map((s) => {
        const conversionBase = enquiryVisibleConversionBase(s.enquiries);
        const converted = enquiryVisibleConversionNumerator(s.enquiries);
        return { store: s.name, conversionPct: conversionBase ? +((converted / conversionBase) * 100).toFixed(1) : null, reservations: converted, enquiries: conversionBase };
      });
      const totalEnquiries = sumBy(sites, (s) => enquiryVisibleConversionBase(s.enquiries));
      const totalReservations = sumBy(sites, (s) => enquiryVisibleConversionNumerator(s.enquiries));
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'conversionPct', label: 'Conversion rate %' }, { key: 'reservations', label: 'Converted enquiries' }, { key: 'enquiries', label: 'Enquiries' }],
        rows,
        { conversionPct: totalEnquiries ? +((totalReservations / totalEnquiries) * 100).toFixed(1) : null, reservations: totalReservations, enquiries: totalEnquiries },
        'Portfolio',
      );
    }
    if (pk === 'discountSummary' && title === 'Units on a Discount Plan' && sites) {
      const rows = sites.map((s) => ({ store: s.name, unitsOnDiscountPlan: s.discountUnitsTotal || 0 }));
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'unitsOnDiscountPlan', label: 'Units on a discount plan' }],
        rows,
        { unitsOnDiscountPlan: sumBy(rows, (r) => r.unitsOnDiscountPlan) },
      );
    }
    if (pk === 'discountSummary' && title === 'Total £ Discount' && sites) {
      const rows = sites.map((s) => ({ store: s.name, totalDiscount: discountTotalForSite(s) }));
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'totalDiscount', label: 'Total £ Discount' }],
        rows,
        { totalDiscount: sumBy(rows, (r) => r.totalDiscount) },
      );
    }
    if (pk === 'snapshot' && title === 'Enquiries & Reservations' && snapshotRows) {
      const rows = snapshotRows.map((r) => {
        const liveSite = siteMap[r.code];
        const localAvg = normalizedReservationSqftPerReservationForSite(liveSite, blendedSqftPerReservation);
        return {
          store: exportSnapshotStoreName(r, siteMap),
          enquiries: r.enquiries || 0,
          reservations: r.reservations || 0,
          reservedSqftEst: Math.round((r.reservations || 0) * (localAvg || blendedSqftPerReservation || 70)),
        };
      });
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'enquiries', label: 'Enquiries' }, { key: 'reservations', label: 'Reservations' }, { key: 'reservedSqftEst', label: 'Reserved sqft (est.)' }],
        rows,
        { enquiries: sumBy(rows, (r) => r.enquiries), reservations: sumBy(rows, (r) => r.reservations), reservedSqftEst: sumBy(rows, (r) => r.reservedSqftEst) },
      );
    }
    if (pk === 'snapshot' && title === 'Move-ins / Move-outs' && snapshotRows) {
      const rows = snapshotRows.map((r) => ({ store: exportSnapshotStoreName(r, siteMap), moveIns: r.moveIns || 0, moveOuts: r.moveOuts || 0 }));
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'moveIns', label: 'Move-ins' }, { key: 'moveOuts', label: 'Move-outs' }],
        rows,
        { moveIns: sumBy(rows, (r) => r.moveIns), moveOuts: sumBy(rows, (r) => r.moveOuts) },
      );
    }
    if (pk === 'snapshot' && title === 'Sqft In / Out' && snapshotRows) {
      const rows = snapshotRows.map((r) => ({ store: exportSnapshotStoreName(r, siteMap), sqftIn: r.sqftIn || 0, sqftOut: r.sqftOut || 0 }));
      return toSheet(
        [{ key: 'store', label: 'Store' }, { key: 'sqftIn', label: 'Sqft In' }, { key: 'sqftOut', label: 'Sqft Out' }],
        rows,
        { sqftIn: sumBy(rows, (r) => r.sqftIn), sqftOut: sumBy(rows, (r) => r.sqftOut) },
      );
    }
    return null;
  }
  function chartCardExportAoa(card) {
    const el = card && card.el;
    if (!el || !el.type || !el.props) return null;
    if (el.type === LineChart) {
      const labels = el.props.opts?.labels || [];
      const series = el.props.series || [];
      const maxLen = Math.max(labels.length, ...series.map((s) => (s.values || []).length), 0);
      const header = ['Label', ...series.map((s) => s.name || 'Series')];
      const rows = Array.from({ length: maxLen }, (_, i) => [
        labels[i] ?? String(i + 1),
        ...series.map((s) => (s.values || [])[i] ?? ''),
      ]);
      return [header, ...rows];
    }
    if (el.type === VBars || el.type === HBars || el.type === StoreBarChart) {
      const items = el.props.items || [];
      return [
        ['Label', 'Value', 'Display'],
        ...items.map((it) => [it.label ?? '', it.value ?? '', it.disp ?? '']),
      ];
    }
    if (el.type === Donut || el.type === Gauge) {
      const pct = el.props.pct ?? '';
      return [['Metric', 'Value'], ['Percent', pct]];
    }
    return null;
  }
  // FIXED 10 Jul 2026 (pre-go-live audit): this used to always `return pageData` regardless of `pk`,
  // silently mislabeling every non-active-page group in the "export everything" Excel file with the
  // CURRENTLY-VIEWED page's data instead of the page named in each group's header — e.g. exporting
  // while on Dashboard would fill the KPIs/Financials/Ancillaries/etc. groups with copies of the
  // Dashboard's own tables. buildPage() now takes an explicit `page` param (see its definition above),
  // so calling it with `pk` actually recomputes that specific page's real data.
  function withPage(pk) {
    return buildPage(pk);
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
    const pages = { dashboard: 'Dashboard', kpis: 'KPIs', economicOccupancy: 'Economic Occupancy', financials: 'Financials', ancillaries: 'Ancillaries', marketing: 'Marketing', mom: 'Month on Month', unitmix: 'Unit Mix Detail', discountSummary: 'Discount Summary', snapshot: 'Weekly/Daily Snapshot', districtManager: 'District Manager' };
    Object.keys(pages).forEach((pk) => {
      const d = pk === page ? pageData : withPage(pk);
      d.tables.forEach((t, i) => items.push({
        id: pk + '_t' + i, page: pages[pk], label: t.title, icon: tableIcon,
        aoa: () => [
          t.columns.map((c) => c.label),
          ...t.rows.map((r) => t.columns.map((c) => {
            const v = r[c.key];
            if (v == null) return '';
            return c.type && c.type !== 'text' ? (isNaN(+v) ? v : +v) : v;
          })),
          // Totals/average footer row (when the table has one) — same pinned row DataTable renders.
          ...(t.totals ? [t.columns.map((c, ci) => ci === 0 ? (t.totalsLabel || 'Total') : (t.totals[c.key] ?? ''))] : []),
        ],
      }));
      d.statCards.forEach((c, i) => items.push({
        id: pk + '_s' + i, page: pages[pk], label: c.title, icon: chartIcon,
        aoa: () => statCardExportAoa(pk, c) || [['Metric', 'Value', 'Change'], ...c.tiles.filter((t) => !t.rowBreak).map((t) => [t.label, t.value, t.delta ? (t.dir === 'up' ? '+' : t.dir === 'down' ? '-' : '') + t.delta : ''])],
      }));
      d.chartCards.forEach((c, i) => items.push({
        id: pk + '_c' + i, page: pages[pk], label: c.title, icon: chartIcon,
        aoa: () => chartCardExportAoa(c) || [['Metric', 'Value'], ['Chart export unavailable', c.title]],
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
      debugWarn('[portal-v2] xlsx package not available — export is a no-op. Run `npm install xlsx` to enable it.', err);
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
    const exportScopeLabel = chosen.every((it) => it.page === 'Weekly/Daily Snapshot') ? snapshotViewLabel : rangeLabel;
    const safeRange = exportScopeLabel.replace(/\s*→\s*/g, ' to ').replace(/[^\w -]/g, '');
    XLSX.writeFile(wb, `Cinch Portal Export - ${safeRange}.xlsx`);
    setExportOpen(false);
  }

  // ---------- derived render values ----------
  const fs = filteredStores();
  // FIXED 7 Jul 2026 (Michael: "the date picker only lets me see up to Jan 2025"): this used to look
  // labels up in the fixed 24-entry MONTHS placeholder array (buildMonths(), Jan 2025 -> Dec 2026
  // only), so any real stored month outside that window — real history goes back to 2016-06 — got an
  // out-of-bounds array index and silently rendered as a blank label, making those months impossible
  // to read/select in the FROM/TO dropdowns even though the server has the data (liveMonths already
  // included them). monthKeyOf()/indexOfMonthKey() are pure linear math valid for ANY year, not just
  // the 2025-2026 window, so compute the label directly instead of indexing into the placeholder array.
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLbl = (i) => { const [y, m] = monthKeyOf(i).split('-').map(Number); return `${MONTH_NAMES[m - 1]} ${y}`; };
  // Real "did the cron actually run" label (15 Jul 2026) — see lastPullAt's declaration for why this
  // exists alongside the cosmetic `updated` state. Under 60 min: relative ("42m ago"). Under 36h:
  // hours, so a stuck/failed overnight cron reads as a big, obvious "14h ago" instead of quietly
  // rolling over to a vague day count. Beyond that: an absolute date+time, since "3d ago" alone
  // would bury exactly how stale the portal actually is.
  const freshnessAt = (() => {
    const mainFreshness = rangePullAt || lastPullAt;
    if (page === 'snapshot') return (liveSnapshot && liveSnapshot.generatedAt) || null;
    if (page === 'districtManager') {
      const candidates = [mainFreshness, liveFloorOcc && liveFloorOcc.generatedAt, liveCockpit && liveCockpit.generatedAt]
        .filter(Boolean)
        .map((v) => new Date(v).getTime())
        .filter((v) => !Number.isNaN(v));
      return candidates.length ? new Date(Math.min(...candidates)).toISOString() : null;
    }
    return mainFreshness;
  })();
  const freshnessLabel = (() => {
    if (!freshnessAt) return null;
    const ms = Date.now() - new Date(freshnessAt).getTime();
    if (ms < 0) return 'just now';
    const mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 36) return `${hrs}h ago`;
    return new Date(freshnessAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  })();
  // Clarify the live month boundary explicitly in the header. The portal intentionally freezes the
  // CURRENT month at the last COMPLETE day, so on Friday, 24 Jul 2026, a correct current-month view
  // should read as July data through Thursday, 23 Jul 2026, not "today so far". Without this suffix,
  // a correct capped month can look "wrong" when compared to sources that still leak partial current-
  // day activity into the same calendar-month label.
  const rangeLabel = (() => {
    const fromKey = monthKeyOf(monthFrom);
    const toKey = monthKeyOf(monthTo);
    const anchor = reportingAnchorDate();
    const currentMonthKey = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}`;
    const decorate = (mk, fallbackLabel) => {
      if (mk !== currentMonthKey) return fallbackLabel;
      const completedDay = completedDayForMonth(mk, freshnessAt);
      return `${fallbackLabel} (through ${MONTH_NAMES[anchor.getMonth()]} ${completedDay})`;
    };
    const fromLabel = decorate(fromKey, monthLbl(monthFrom));
    if (monthFrom === monthTo) return fromLabel;
    const toLabel = decorate(toKey, monthLbl(monthTo));
    return `${fromLabel} → ${toLabel}`;
  })();
  // FIXED 24 Jul 2026 (freshness/status audit): the header badge used to say "Live data" for every
  // non-snapshot page, even though the portal is deliberately frozen to the last COMPLETE day and
  // the District Manager page mixes three independently refreshed sources (main payload, floor
  // occupancy import, cockpit daily financials). That overstated both immediacy and source shape.
  // Make the badge honest per page instead of reusing one label everywhere.
  const dataStatus = (() => {
    if (page === 'snapshot') {
      const scopedSnapshot = liveSnapshot ? liveSnapshot[snapshotPeriod] : null;
      if (!liveSnapshot) {
        return {
          label: 'Mock data',
          title: 'No stored snapshot payload is available yet, so this page is showing fallback mock values.',
          fg: '#B42318',
          bg: '#FEECEB',
          dot: '#F04438',
        };
      }
      if (!scopedSnapshot) {
        return {
          label: 'Partial data',
          title: 'Snapshot data exists for some periods, but not for this selected snapshot period yet, so this page is showing fallback mock values for the current selection.',
          fg: '#B54708',
          bg: '#FFFAEB',
          dot: '#F79009',
        };
      }
      return {
        label: 'Snapshot data',
        title: 'Stored snapshot data for completed periods, not real-time intraday activity.',
        fg: '#175CD3',
        bg: '#EFF4FF',
        dot: '#2E90FA',
      };
    }
    if (page === 'districtManager') {
      const cockpitReady = !!(liveCockpit && Array.isArray(liveCockpit.curve) && liveCockpit.curve.length);
      if (!liveTotals && !liveFloorOcc && !liveCockpit) {
        return {
          label: 'Mock data',
          title: 'Live district-manager data is unavailable right now, so this page is showing fallback mock values.',
          fg: '#B42318',
          bg: '#FEECEB',
          dot: '#F04438',
        };
      }
      if (!liveTotals || !liveFloorOcc || !cockpitReady) {
        return {
          label: 'Partial data',
          title: 'Some district-manager sources are available, but others are still missing or have no stored rows for the selected month yet, so parts of this page may still be using fallback content. Figures are not real-time intraday.',
          fg: '#B54708',
          bg: '#FFFAEB',
          dot: '#F79009',
        };
      }
      return {
        label: 'Mixed data',
        title: 'This page combines stored month payload data with separately refreshed floor-occupancy and cockpit snapshot data. Figures are not real-time intraday.',
        fg: '#B54708',
        bg: '#FFFAEB',
        dot: '#F79009',
      };
    }
    if (!liveTotals) {
      return {
        label: 'Mock data',
        title: 'Live portal data is unavailable right now, so this page is showing fallback mock values.',
        fg: '#B42318',
        bg: '#FEECEB',
        dot: '#F04438',
      };
    }
    return {
      label: 'Stored data',
      title: 'Stored portal data for completed periods, refreshed by the daily pull. Not real-time intraday activity.',
      fg: '#08875D',
      bg: '#E7F6EF',
      dot: '#08875D',
    };
  })();
  // FIXED 8 Jul 2026: fs.length was always the mock STORES count (27), even in live mode — with 29
  // real sites now configured, the subtitle would keep showing the stale "27" regardless. Can't
  // reuse buildPage()'s own `liveSites` const here — this block is a SEPARATE, outer scope (that
  // ReferenceError is exactly why the first version of this fix broke the page) — so the same
  // liveSitesRaw+selected filter logic is inlined here instead.
  const snapshotStoreRows = (liveSnapshot && liveSnapshot[snapshotPeriod] && Array.isArray(liveSnapshot[snapshotPeriod].sites))
    ? liveSnapshot[snapshotPeriod].sites.map((s) => ({ name: s.store || SITE_NAME_BY_CODE[s.code] || (liveSitesRaw || []).find((site) => site.code === s.code)?.name || s.code, code: s.code }))
    : null;
  const visibleSelectedCount = page === 'snapshot'
    ? (snapshotStoreRows
        ? snapshotStoreRows.filter((s) => selected[s.name]).length
        : (liveSitesRaw ? liveSitesRaw.filter((s) => selected[s.name]).length : 0))
    : (liveSitesRaw ? liveSitesRaw.filter((s) => selected[s.name]).length : 0);
  const pageAnySel = visibleSelectedCount > 0;
  const storeSummary = effectiveRegion !== 'All' ? effectiveRegion : pageAnySel ? visibleSelectedCount + ' stores' : 'All stores';
  const liveSiteCount = page === 'snapshot'
    ? (snapshotStoreRows
        ? (pageAnySel ? snapshotStoreRows.filter((s) => selected[s.name]).length : snapshotStoreRows.length)
        : (liveSitesRaw ? (pageAnySel ? liveSitesRaw.filter((s) => selected[s.name]).length : liveSitesRaw.length) : null))
    : (liveSitesRaw ? (pageAnySel ? liveSitesRaw.filter((s) => selected[s.name]).length : liveSitesRaw.length) : null);
  const snapshotViewLabel = { daily: 'Yesterday', weekly: 'Last 7 days', quarterly: 'Quarter to date' }[snapshotPeriod] || 'Snapshot';
  const subtitle = page === 'snapshot'
    ? storeSummary + ' · portfolio (' + (liveSiteCount ?? fs.length) + ') · ' + snapshotViewLabel
    : storeSummary + ' · portfolio (' + (liveSiteCount ?? fs.length) + ') · ' + rangeLabel + (viewLive ? '' : ' (viewing)');
  // Restrict the FROM/TO dropdowns to months that actually have data once it's loaded, instead of
  // the full static 24-month placeholder list (which includes months nobody has pulled yet).
  const AVAILABLE_MONTHS = liveMonths && liveMonths.length ? liveMonths.map((mk) => ({ value: indexOfMonthKey(mk), label: monthLbl(indexOfMonthKey(mk)) })) : MONTHS;
  const titles = { dashboard: 'Dashboard', kpis: 'KPIs', economicOccupancy: 'Economic Occupancy', financials: 'Financials', ancillaries: 'Ancillaries', marketing: 'Marketing', mom: 'Month on Month', unitmix: 'Unit Mix Detail', discountSummary: 'Discount Summary', snapshot: 'Weekly/Daily Snapshot', districtManager: 'District Manager' };

  // lineChartOptions (17 Jul 2026, task #313): the full portal-wide list of {page,title} for every
  // LineChart card that exists anywhere, built by calling buildPage() for EVERY page (not just the
  // one on screen) and keeping only cards whose `el` is a LineChart (Donut/Gauge/VBars/HBars/
  // StoreBarChart cards aren't offered — overlaying a trend line onto a bar/gauge doesn't mean
  // anything). This is safe to do off-screen because every live data fetch (fetchLiveTotals/
  // fetchSnapshot/fetchFloorOccupancy/fetchCockpit) runs once on initial mount regardless of which
  // page is currently active (see that useEffect above) — buildPage('districtManager') returns fully
  // real data even while the user is looking at Month-on-Month, it's not gated behind actually
  // visiting that page first. Memoized on the underlying live-data/filter state (NOT on `page` or
  // `chartOverlays`) so this doesn't get recomputed on every render — in particular, LineChart's own
  // hover state lives inside that component now specifically so mousemove never reaches this far up.
  const lineChartOptions = useMemo(() => {
    const out = [];
    for (const p of Object.keys(titles)) {
      try {
        const pd = buildPage(p);
        for (const c of (pd.chartCards || [])) {
          if (c.el && c.el.type === LineChart) out.push({ page: p, title: c.title });
        }
      } catch (e) { /* a page whose off-screen data isn't ready yet -- just leave it out of the picker for now */ }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSitesRaw, livePrevSitesRaw, liveHistory, liveMonthly, liveCockpit, liveSnapshot, monthFrom, monthTo, selected, region]);

  // resolveLineChart (task #313): look up one specific OTHER chart's live series/opts by page+title,
  // for whichever card currently has an overlay selected. Always calls buildPage(page) fresh rather
  // than trying to reuse the already-computed `pageData` — only runs for the handful of cards that
  // actually have an active overlay (0 in the common case), so the extra recompute is cheap, and it
  // stays correct even when the overlay's page differs from the one currently on screen.
  const resolveLineChart = (page, title) => {
    const pd = buildPage(page);
    const card = (pd.chartCards || []).find((c) => c.title === title && c.el && c.el.type === LineChart);
    return card ? card.el.props : null;
  };

  // `tip` (13 Jul 2026): carried through unchanged from whatever buildPage() set on each kpiRow tile/
  // statCard/chartCard/table object — see InfoTip's own definition above for why this is one tip per
  // widget rather than per table column.
  const kpiRow = pageData.kpiRow.map((k) => ({ ...k, hasDelta: !!k.delta, ...chip(k.delta, k.dir) }));
  const statCards = pageData.statCards.map((c) => ({
    title: c.title, live: !!c.live, dotColor: c.dotColor || (c.live ? C.teal : C.blue), tip: c.tip,
    hasViz: !!c.hasViz, el: c.el, hasNote: !!c.note, note: c.note,
    // compact — ADDED 21 Jul 2026 (Michael: Move-ins & Move-outs "so much longer than other widgets...
    // find a way to condense"). Opt-in per-card flag (only Move-ins & Move-outs sets it so far) that
    // shrinks tile text/spacing below — for a card with 2 forced tile rows (rowBreak), this claws back
    // a meaningful chunk of the extra height a 2nd row costs, without dropping any tiles.
    compact: !!c.compact,
    tiles: c.tiles.map((t) => ({
      value: t.value, label: t.label, delta: t.delta, hasDelta: t.delta != null,
      valueStyle: { fontSize: c.hasViz ? '28px' : (c.compact ? '19px' : '24px'), fontWeight: 700, letterSpacing: '-.02em', color: '#0C1425', fontVariantNumeric: 'tabular-nums', lineHeight: 1 },
      // rowBreak — ADDED 21 Jul 2026 (Rich's portal review, task #358): a tile can force a line break
      // within a stat card's wrapped tile row (used by Move-ins & Move-outs to separate its count
      // tiles from its sqft tiles) — see the render loop below for how this is used.
      rowBreak: !!t.rowBreak,
      ...chip(t.delta, t.dir),
    })),
  }));
  const chartCards = pageData.chartCards.map((c) => ({
    title: c.title, dotColor: c.dotColor || C.blue, el: c.el, removable: !!c.removable, onRemove: c.onRemove,
    wide: !!c.wide, tip: c.tip, isLine: !!(c.el && c.el.type === LineChart), hasNote: !!c.note, note: c.note,
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
  const storeOptions = page === 'snapshot' && snapshotStoreRows
    ? snapshotStoreRows.map((s) => ({
        name: s.name, region: null, checked: !!selected[s.name],
        onToggle: () => { setSelected((p) => ({ ...p, [s.name]: !p[s.name] })); },
      }))
    : liveSitesRaw
    ? liveSitesRaw.map((s) => ({
        name: s.name, region: null, checked: !!selected[s.name],
        onToggle: () => { setSelected((p) => ({ ...p, [s.name]: !p[s.name] })); },
      }))
    : STORES.filter((st) => effectiveRegion === 'All' || st.region === effectiveRegion).map((st) => ({
        name: st.name, region: st.region, checked: !!selected[st.name],
        onToggle: () => { setSelected((p) => ({ ...p, [st.name]: !p[st.name] })); },
      }));
  const regionChips = (liveSitesRaw ? ['All'] : ['All', ...REGIONS]).map((r) => ({
    label: r,
    onClick: () => { setRegion(r); setSelected({}); },
    active: effectiveRegion === r,
  }));
  // 'PM' (Prior Month) ADDED 15 Jul 2026 (Michael: "add a butting for prior month as well") — plain
  // preset label map so it reads as a word, not a code, next to the 1M/3M/etc. shorthand buttons.
  const presetLabels = { '1M': '1M', PM: 'Prior Month', '3M': '3M', '6M': '6M', '12M': '12M', YTD: 'YTD', All: 'All' };
  const presets = ['1M', 'PM', '3M', '6M', '12M', 'YTD', 'All'].map((pl) => ({ label: presetLabels[pl], active: period === pl, onClick: () => applyPreset(pl) }));

  const builderSigns = [{ value: '/', label: '÷' }, { value: '*', label: '×' }, { value: '+', label: '+' }, { value: '-', label: '−' }];

  const navGroups = [
    { label: 'Overview', items: [{ id: 'dashboard', label: 'Dashboard' }, { id: 'snapshot', label: 'Weekly/Daily Snapshot' }] },
    { label: 'Performance', items: [{ id: 'kpis', label: 'KPIs' }, { id: 'economicOccupancy', label: 'Economic Occupancy' }, { id: 'financials', label: 'Financials' }, { id: 'ancillaries', label: 'Ancillaries' }, { id: 'unitmix', label: 'Unit Mix Detail' }, { id: 'discountSummary', label: 'Discount Summary' }] },
    { label: 'Growth', items: [{ id: 'marketing', label: 'Marketing' }] },
    { label: 'Trends', items: [{ id: 'mom', label: 'Month on Month' }] },
    { label: 'District Manager', items: [{ id: 'districtManager', label: 'District Manager' }] },
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
                <div ref={storeFilterRef} style={{ position: 'relative' }}>
                  <button onClick={(e) => { e.stopPropagation(); setStorePopOpen((p) => !p); setPeriodPopOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontFamily: 'inherit', fontSize: '13px', fontWeight: 500, color: '#101828', background: '#fff', border: '1px solid #E4E7EC', borderRadius: '9px', padding: '8px 11px', cursor: 'pointer' }}>
                    {storeSummary}
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" style={{ marginLeft: '2px' }}><path d="m6 9 6 6 6-6" stroke="#667085" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                  {storePopOpen && (
                    <div data-popover-panel onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', left: 0, top: 'calc(100% + 8px)', zIndex: 50, background: '#fff', border: '1px solid #E4E7EC', borderRadius: '12px', boxShadow: '0 12px 32px rgba(16,24,40,.14)', width: '300px', padding: '12px' }}>
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
                        <button onClick={() => { const sel = {}; storeOptions.forEach((o) => (sel[o.name] = true)); setSelected(sel); }} style={{ fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 500, color: '#2757E8', background: 'none', border: 'none', cursor: 'pointer' }}>Select all</button>
                        <button onClick={() => { setSelected({}); }} style={{ fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 500, color: '#667085', background: 'none', border: 'none', cursor: 'pointer' }}>Clear</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {page === 'snapshot' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '.06em', color: '#98A2B3' }}>VIEW</span>
                  <div style={{ display: 'flex', background: '#F2F4F7', borderRadius: '9px', padding: '3px', gap: '2px' }}>
                    {[{ id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' }, { id: 'quarterly', label: 'Quarterly' }].map((o) => (
                      <button key={o.id} onClick={() => setSnapshotPeriod(o.id)} style={{ fontFamily: 'inherit', fontSize: '13px', fontWeight: 600, padding: '7px 14px', borderRadius: '7px', border: 'none', cursor: 'pointer', color: snapshotPeriod === o.id ? '#2757E8' : '#667085', background: snapshotPeriod === o.id ? '#fff' : 'transparent', boxShadow: snapshotPeriod === o.id ? '0 1px 2px rgba(16,24,40,.08)' : 'none' }}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '.06em', color: '#98A2B3' }}>PERIOD</span>
                <div style={{ display: 'flex', background: '#F2F4F7', borderRadius: '9px', padding: '3px', gap: '2px' }}>
                  {presets.map((p) => (
                    <button key={p.label} onClick={p.onClick} style={{ fontFamily: 'inherit', fontSize: '12px', fontWeight: 600, padding: '6px 11px', borderRadius: '7px', border: 'none', cursor: 'pointer', background: p.active ? '#fff' : 'transparent', color: p.active ? '#2757E8' : '#667085', boxShadow: p.active ? '0 1px 2px rgba(16,24,40,.08)' : 'none' }}>{p.label}</button>
                  ))}
                </div>
                <div ref={periodFilterRef} style={{ position: 'relative' }}>
                  <button onClick={(e) => { e.stopPropagation(); setPeriodPopOpen((p) => !p); setStorePopOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 500, color: '#344054', background: '#fff', border: '1px solid #E4E7EC', borderRadius: '9px', padding: '8px 11px', cursor: 'pointer' }}>
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" style={{ marginRight: '2px' }}><rect x={3} y={5} width={18} height={16} rx={2} stroke="#667085" strokeWidth={2} /><path d="M3 9h18M8 3v4M16 3v4" stroke="#667085" strokeWidth={2} strokeLinecap="round" /></svg>
                    {rangeLabel}
                  </button>
                  {periodPopOpen && (
                    <div data-popover-panel onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', left: 0, top: 'calc(100% + 8px)', zIndex: 50, background: '#fff', border: '1px solid #E4E7EC', borderRadius: '12px', boxShadow: '0 12px 32px rgba(16,24,40,.14)', width: '260px', padding: '14px' }}>
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
              </div>}

              <div style={{ flex: 1 }} />

              <div
                title={dataStatus.title}
                style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: dataStatus.fg, background: dataStatus.bg, borderRadius: '8px', padding: '6px 10px', fontWeight: 600 }}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: dataStatus.dot }} />
                {dataStatus.label}
              </div>
              {freshnessLabel && (
                <span
                  title={page === 'snapshot'
                    ? 'When the snapshot pull for this page last actually completed — not when you last refreshed this page.'
                    : page === 'districtManager'
                      ? 'Oldest refresh among the data sources shown on this page — main payload, floor occupancy import, and cockpit daily financials — not when you last refreshed this page.'
                      : 'When the daily auto-update (SiteLink pull) last actually completed — not when you last refreshed this page.'}
                  style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: '#98A2B3', whiteSpace: 'nowrap' }}
                >
                  <svg width={12} height={12} viewBox="0 0 24 24" fill="none"><circle cx={12} cy={12} r={9} stroke="#98A2B3" strokeWidth={2} /><path d="M12 7v5l3 2" stroke="#98A2B3" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
                  {page === 'snapshot' ? 'Snapshot updated ' : page === 'districtManager' ? 'Oldest source updated ' : 'Auto-updated '}{freshnessLabel}
                </span>
              )}
              {spin && <span style={{ fontSize: '12px', color: '#98A2B3', whiteSpace: 'nowrap' }}>Refreshing…</span>}
              <button onClick={() => { setSpin(true); reload(); }} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 500, color: '#344054', background: '#fff', border: '1px solid #E4E7EC', borderRadius: '9px', padding: '8px 11px', cursor: 'pointer' }}>
                <span style={{ display: 'flex', animation: spin ? 'spin .65s linear' : 'none' }}>
                  <svg width={15} height={15} viewBox="0 0 24 24" fill="none"><path d="M20 11a8 8 0 1 0-.6 3" stroke="#667085" strokeWidth={2} strokeLinecap="round" /><path d="M20 4v5h-5" stroke="#667085" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>
                Refresh
              </button>
              <button onClick={() => setExportOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 600, color: '#fff', background: '#2757E8', border: 'none', borderRadius: '9px', padding: '9px 13px', cursor: 'pointer', boxShadow: '0 1px 2px rgba(39,87,232,.3)' }}>
                <svg width={15} height={15} viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
                Export
              </button>
              <button onClick={signOut} disabled={signingOut} title="Sign out" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 500, color: '#344054', background: '#fff', border: '1px solid #E4E7EC', borderRadius: '9px', padding: '8px 11px', cursor: signingOut ? 'default' : 'pointer', opacity: signingOut ? 0.6 : 1 }}>
                <svg width={15} height={15} viewBox="0 0 24 24" fill="none"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke="#667085" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
                {signingOut ? 'Signing out…' : 'Sign out'}
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
                      <div key={ki} style={{ background: '#fff', border: '1px solid #D5DAE1', borderRadius: '16px', boxShadow: '0 1px 3px rgba(16,24,40,.07),0 2px 6px rgba(16,24,40,.08)', padding: '16px 18px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#98A2B3', display: 'flex', alignItems: 'center', gap: '5px' }}>{k.label}<InfoTip text={k.tip} /></div>
                        <div style={{ fontSize: '26px', fontWeight: 700, letterSpacing: '-.02em', color: '#0C1425', marginTop: '8px', fontVariantNumeric: 'tabular-nums' }}>{k.value}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                          {k.hasDelta && <span style={k.deltaStyle}>{k.deltaArrow} {k.delta}</span>}
                          <span style={{ fontSize: '12px', color: '#98A2B3' }}>{k.sub}</span>
                          {k.extraChip && <span style={{ fontSize: '11px', fontWeight: 600, color: k.extraChip.positive ? '#067647' : '#B42318', background: k.extraChip.positive ? '#E7F6EF' : '#FEECEB', borderRadius: '999px', padding: '4px 8px', marginLeft: 'auto' }}>{k.extraChip.label} {k.extraChip.value}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {statCards.length > 0 && (
                  // alignItems:'start' ADDED 21 Jul 2026 (Michael: "not so much ugly white space on
                  // some of these widgets") — was the CSS grid default (stretch), which forces every
                  // card in a row to match its tallest row-mate's height; a 2-row card (e.g. Move-ins &
                  // Move-outs) next to 1-row cards (Debtor Levels, Move-In Rental Rate) was stretching
                  // those shorter cards' white boxes down to match, showing as empty space inside them.
                  // 'start' lets every card size to its own content instead — combined with the new
                  // `compact` mode above for the specific card that started this.
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: '16px', alignItems: 'start' }}>
                    {statCards.map((c, ci) => (
                      <div key={ci} style={{ background: '#fff', border: '1px solid #D5DAE1', borderRadius: '16px', boxShadow: '0 1px 3px rgba(16,24,40,.07),0 2px 6px rgba(16,24,40,.08)', overflow: 'hidden' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '14px 18px', borderBottom: '1px solid #F2F4F7' }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.dotColor }} />
                          <span style={{ fontSize: '12.5px', fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: '#475467' }}>{c.title}</span>
                          <InfoTip text={c.tip} />
                          {c.live && <span style={{ fontSize: '9.5px', fontWeight: 700, letterSpacing: '.08em', color: '#08875D', background: '#E7F6EF', borderRadius: '5px', padding: '2px 6px', marginLeft: 'auto' }}>LIVE</span>}
                        </div>
                        <div style={{ padding: c.compact ? '14px 18px' : '18px', display: 'flex', alignItems: 'center', gap: '18px' }}>
                          <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: c.compact ? '8px 22px' : '20px 26px' }}>
                            {c.tiles.map((t, ti) => (
                              t.rowBreak
                                ? <div key={ti} style={{ flexBasis: '100%', height: 0 }} />
                                : <div key={ti}>
                                    <div style={t.valueStyle}>{t.value}</div>
                                    <div style={{ fontSize: c.compact ? '10px' : '11px', fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#98A2B3', marginTop: c.compact ? '3px' : '5px' }}>{t.label}</div>
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
                  // CHANGED 21 Jul 2026 (task #395, Michael: "narrrow [the tables] and put two tables
                  // next to eachother, do not make any data overlapping or... any scolling in the
                  // table, the only scrolling should be on the overall site" — then escalated: "go
                  // across every page and make all the big tables narrower and put them next to
                  // eachother", no exceptions) — was a plain full-width flex column stack. Same
                  // auto-fit grid pattern as the stat-card/chart-card grids above/below, so tables sit
                  // 2-up on a normal-width screen instead of each spanning the full page. EVERY table
                  // now goes through this grid — no table sets `wide:true` any more (the `wide` prop on
                  // DataTable/the `t.wide` passthrough below are left in place only in case a future
                  // table genuinely needs the full-width escape hatch again).
                  // minmax bumped 480->560px vs. the first pass, since the densest tables (Economic
                  // Occupancy Detail's 11 columns, Unit Groups — Stay & Re-Lease's 7) are now narrow
                  // too and need more room than the ≤4-column tables the first pass was tuned for.
                  // DataTable's own overflowX:auto wrapper is the fallback for anything that still
                  // doesn't fit at a given browser width — that specific table scrolls internally
                  // rather than overlapping text, everything else on the page still only scrolls
                  // vertically as one normal page.
                  // Deliberately NOT `gridAutoFlow:'dense'` — dense packing reorders cards out of DOM
                  // order to backfill gaps (e.g. a later table jumping up above one earlier in reading
                  // order), which reads as a confusing "why did this move" more than it saves space now
                  // that almost every table is narrow and gaps are rare.
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(560px,1fr))', gap: '16px', alignItems: 'start' }}>
                    {tables.map((t, ti) => (
                      <DataTable key={ti} title={t.title} columns={t.columns} rows={t.rows} live={t.live} pageSize={t.pageSize || 12} totals={t.totals} totalsLabel={t.totalsLabel} totalsPrev={t.totalsPrev} tip={t.tip} headerExtra={t.headerExtra} collapsible={t.collapsible} wide={t.wide} />
                    ))}
                  </div>
                )}

                {chartCards.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: '16px' }}>
                    {chartCards.map((c, ci) => {
                      // Chart overlay (task #313): keyed by the HOST chart's own page+title so the
                      // choice survives switching pages and back. Only offered/applied for LineChart
                      // cards — see lineChartOptions'/isLine's own comments above for why.
                      const overlayKey = `${page}::${c.title}`;
                      const overlay = c.isLine ? chartOverlays[overlayKey] : null;
                      let el = c.el;
                      if (c.isLine && overlay) {
                        const resolved = resolveLineChart(overlay.page, overlay.title);
                        if (resolved) {
                          const overlaySeries = resolved.series.map((s) => ({
                            ...s, axis: 'right', labels: (resolved.opts && resolved.opts.labels) || s.labels,
                            name: `${s.name} — ${overlay.title}`,
                          }));
                          el = <LineChart series={[...c.el.props.series, ...overlaySeries]} opts={c.el.props.opts} />;
                        }
                      }
                      return (
                      <div key={ci} style={{ background: '#fff', border: '1px solid #D5DAE1', borderRadius: '16px', boxShadow: '0 1px 3px rgba(16,24,40,.07),0 2px 6px rgba(16,24,40,.08)', overflow: 'hidden', gridColumn: c.wide ? '1/-1' : undefined }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '14px 18px', borderBottom: '1px solid #F2F4F7' }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.dotColor }} />
                          <span style={{ fontSize: '12.5px', fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: '#475467' }}>{c.title}</span>
                          <InfoTip text={c.tip} />
                          <span style={{ flex: 1 }} />
                          {c.isLine && (
                            <ChartComparePicker
                              titles={titles}
                              value={overlay}
                              options={lineChartOptions.filter((o) => !(o.page === page && o.title === c.title))}
                              onChange={(v) => setChartOverlays((prev) => {
                                const next = { ...prev };
                                if (v) next[overlayKey] = v; else delete next[overlayKey];
                                return next;
                              })}
                            />
                          )}
                          {c.removable && (
                            <button onClick={c.onRemove} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#98A2B3', display: 'flex', padding: '2px' }}>
                              <svg width={15} height={15} viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="#98A2B3" strokeWidth={2} strokeLinecap="round" /></svg>
                            </button>
                          )}
                        </div>
                        <div style={{ padding: '18px' }}>{el}</div>
                        {c.hasNote && <div style={{ padding: '0 18px 14px', fontSize: '12px', color: '#98A2B3' }}>{c.note}</div>}
                      </div>
                      );
                    })}
                  </div>
                )}

                {/* Unit Mix table: preserved as dead code in the original —
                    buildPage() never populates out.unitMix, so this section
                    never renders (hasUnitMix is always false). Kept faithful. */}
                {pageData.unitMix.length > 0 && (
                  <div style={{ background: '#fff', border: '1px solid #D5DAE1', borderRadius: '16px', boxShadow: '0 1px 3px rgba(16,24,40,.07),0 2px 6px rgba(16,24,40,.08)', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '14px 18px', borderBottom: '1px solid #F2F4F7' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#2757E8' }} />
                      <span style={{ fontSize: '12.5px', fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: '#475467' }}>Unit Mix Occupancy</span>
                    </div>
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
                  <div style={{ fontSize: '13px', color: '#667085', marginTop: '3px' }}>Choose the tables and stat-card breakdowns to include. Each becomes its own sheet.</div>
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

        {panelAOpen && (
          <div onClick={() => setPanelAOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(6,10,20,.92)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', cursor: 'pointer' }}>
            <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', maxWidth: '640px', width: '100%' }}>
              <div style={{ fontFamily: 'inherit', fontSize: '15px', fontWeight: 700, color: '#fff', textAlign: 'center', letterSpacing: '.02em' }}>Made by the Greatest to Ever Do It Michael Liam Kurschat</div>
              <img src={BG_IMG} alt="" style={{ width: '100%', borderRadius: '14px', boxShadow: '0 24px 64px rgba(0,0,0,.5)' }} />
              <button onClick={() => setPanelAOpen(false)} style={{ fontFamily: 'inherit', fontSize: '13px', fontWeight: 600, color: '#fff', background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.25)', borderRadius: '10px', padding: '9px 18px', cursor: 'pointer' }}>Close</button>
            </div>
          </div>
        )}

        {panelBOpen && (
          <div onClick={() => setPanelBOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(6,10,20,.92)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', cursor: 'pointer' }}>
            <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', maxWidth: '480px', width: '100%' }}>
              <div style={{ fontFamily: 'inherit', fontSize: '20px', fontWeight: 600, color: '#fff', textAlign: 'center' }}>Jesus is Truly Loves You</div>
              <button onClick={() => setPanelBOpen(false)} style={{ fontFamily: 'inherit', fontSize: '13px', fontWeight: 600, color: '#fff', background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.25)', borderRadius: '10px', padding: '9px 18px', cursor: 'pointer' }}>Close</button>
            </div>
          </div>
        )}

      </div>
    </>
  );
}
