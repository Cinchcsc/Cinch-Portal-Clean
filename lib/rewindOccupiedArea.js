// Pure helper for the Real Rate occupied-area denominator (task #308/#404/#405).
//
// Validated 24 Jul 2026 across all 25 legacy-June-target sites (scripts/probe-realrate-rewound-area-
// all-sites.js, scripts/probe-realrate-unit-inventory-stability.js): "rewinding" today's live occupied
// area back to a target month-end via net MoveInsAndMoveOuts moves since that month-end is a large
// accuracy win over trusting the frozen month-end rent_roll snapshot directly — avg|gap| vs Michael's
// legacy-confirmed June targets dropped £0.78 -> £0.51, sites within £1 rose 18/25 -> 24/25. The frozen
// snapshot was captured via a single historical bulk backfill, not at each month's true close (task
// #404), so it's routinely off by a few hundred sqft.
//
// EXCEPTION, discovered the same day: this assumes the site's TOTAL unit inventory (occupied + vacant)
// hasn't changed between the frozen snapshot and today — MoveInsAndMoveOuts only tracks tenancy
// (occupied vs vacant) on an assumed-STABLE roster, so it has no way to see a genuine property
// expansion or reconfiguration (new units added, existing ones merged/split). Enfield (L008) hit
// exactly this: total inventory grew 78.5% (420 -> 598 units) between frozen-June and today — a real
// expansion, not a data error — which the rewind formula silently misattributed as June occupancy,
// flipping its Rate gap from a £1.05 overshoot to a £1.10 undershoot. Every other site's total
// inventory was completely stable (0%, or a rounding-level fraction of a percent) over the same window.
//
// This is a PURE function — no Supabase/SOAP access of its own. Every input it needs (frozen target-
// month rent_roll, current-month rent_roll, current-month move_ins_outs — all lib/reportMap.js parse()
// outputs) is already sitting in buildPayload.js's `idx` object from the routine daily pull: pull.js's
// endOf() already scopes the CURRENT month's rent_roll/move_ins_outs pulls from month-start through
// "today" on every single run (lib/pull.js, the TWO_MONTH set + endOf()), so no new pull step or live
// SOAP call is needed to compute any of this — it's purely a different way of aggregating data that's
// already being pulled and stored. When the target month is the one immediately before "current", the
// current month's move_ins_outs sample already covers exactly the (targetMonthEnd, today] window this
// needs.
//
// INVENTORY_SHIFT_THRESHOLD_PCT: how much a site's total area can move between the frozen snapshot and
// today before this stops trusting the rewind and falls back to the frozen occupied-area figure
// instead. 2% comfortably clears ordinary month-to-month noise (every non-Enfield site measured at
// 0%-0.67% in the live check) while catching a change two full orders of magnitude bigger (Enfield's
// 78.5%).
export const INVENTORY_SHIFT_THRESHOLD_PCT = 2;

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// frozenRentRoll / currentRentRoll: lib/reportMap.js's `rent_roll` parse() output for the target month
// and the current month respectively — both carry `area_sum` (occupied area) and
// `total_area_all_units` (occupied + vacant).
// currentMoveInsOuts: lib/reportMap.js's `move_ins_outs` parse() output for the CURRENT month — already
// carries `net_area` (moved-in area minus moved-out area, summed over whatever window it was pulled
// for — see file comment above for why that window already matches what's needed here).
//
// Returns { area, source, inventoryShiftPct, frozenArea, rewoundArea }. `area` is the one value callers
// should actually use as the Rate denominator; `source`/`inventoryShiftPct`/`rewoundArea` are carried
// through for transparency/debugging (e.g. an admin-only tooltip or log), same convention as this
// codebase's other "raw sums carried through" fields.
export function computeRewoundOccupiedArea({ frozenRentRoll, currentRentRoll, currentMoveInsOuts }) {
  const frozen = frozenRentRoll || {};
  const current = currentRentRoll || null;
  const mio = currentMoveInsOuts || null;
  const frozenArea = frozen.area_sum || 0;
  const frozenTotalArea = frozen.total_area_all_units || 0;

  // Can't rewind without both a current-month rent_roll AND move_ins_outs sample (e.g. a brand-new
  // site with no prior pull yet, or a buildPayloadRange() call for a month range that has no "current"
  // concept). Fall back to the frozen figure exactly like every other formula variant in this codebase
  // already does when a newer report is unavailable, rather than erroring or silently returning 0.
  if (!current || !mio) {
    return { area: frozenArea, source: 'frozen (no current-month sample available)', inventoryShiftPct: 0, frozenArea, rewoundArea: null };
  }

  const currentArea = current.area_sum || 0;
  const currentTotalArea = current.total_area_all_units || 0;
  const rewoundArea = R2(currentArea - (mio.net_area || 0));

  const inventoryShiftPct = frozenTotalArea ? R2((currentTotalArea - frozenTotalArea) / frozenTotalArea * 100) : 0;
  if (Math.abs(inventoryShiftPct) > INVENTORY_SHIFT_THRESHOLD_PCT) {
    // Total inventory itself moved more than ordinary month-to-month noise — the rewind's core
    // assumption (stable roster, only occupancy changing) doesn't hold here, so trust the frozen
    // figure instead (see Enfield in the file comment above).
    return { area: frozenArea, source: `frozen (inventory shifted ${inventoryShiftPct}% since snapshot)`, inventoryShiftPct, frozenArea, rewoundArea };
  }
  return { area: rewoundArea, source: 'rewound', inventoryShiftPct, frozenArea, rewoundArea };
}
