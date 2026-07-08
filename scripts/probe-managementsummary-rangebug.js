// MAJOR NEW FINDING (8 Jul 2026), separate from the Walk-in-vs-legacy definitional question:
// probe-walkin-deeper.js's day-by-day check showed ManagementSummary's Walk-In Leads iMCount for a
// MULTI-DAY custom range (Jul 1-8, one call) can be dramatically LOWER than summing the same field
// across 8 individual single-day calls — L001: 2 (one call) vs 8 (summed days); L002: 2 vs 12. That's
// a mechanical API bug in how SiteLink aggregates iMCount over a custom date range, independent of
// legacy entirely — and if real and report-wide, it would affect EVERY current-month flow metric this
// portal reads from ManagementSummary (move_ins, move_outs, phone_leads, web_leads, leads_converted,
// insured_moveins), not just walk-ins. Only 2 non-zero sites were checked before; this widens the
// check to more sites AND a second field (move_ins, independently trusted elsewhere) to see whether
// the bug is walk-in-specific or hits the whole report's multi-day aggregation.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-managementsummary-rangebug.js
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const locations = ((process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean)).slice(0, 8);
const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);

let mismatches = 0, checked = 0;
for (const loc of locations) {
  const { rows: multiRows } = await callReport('ManagementSummary', loc, start, end);
  const multi = REPORTS.management.parse(multiRows);
  let dayWalk = 0, dayMoveIns = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = new Date(d), de = new Date(d);
    process.stderr.write(`[rangebug] ${loc} ${ds.toISOString().slice(0, 10)}...\n`);
    const { rows } = await callReport('ManagementSummary', loc, ds, de);
    const p = REPORTS.management.parse(rows);
    dayWalk += p.walkin_leads || 0; dayMoveIns += p.move_ins || 0;
  }
  checked++;
  const walkMismatch = multi.walkin_leads !== dayWalk, moveMismatch = multi.move_ins !== dayMoveIns;
  if (walkMismatch || moveMismatch) mismatches++;
  console.log(`${loc}:  walk-in  one-call=${multi.walkin_leads}  summed-days=${dayWalk}  ${walkMismatch ? 'MISMATCH' : 'match'}   |   move-ins  one-call=${multi.move_ins}  summed-days=${dayMoveIns}  ${moveMismatch ? 'MISMATCH' : 'match'}`);
}
console.log(`\n${mismatches} of ${checked} sites show a mismatch on at least one field.`);
console.log(mismatches > 0
  ? 'If move-ins ALSO mismatches, this is a report-wide multi-day aggregation bug, not walk-in-specific — every current-month flow metric from ManagementSummary needs re-checking.'
  : 'No mismatches in this sample — the earlier L001/L002 walk-in mismatch may be field-specific or edge-case; worth re-running probe:walkin-deeper once more to confirm it still reproduces.');
process.exit(0);
