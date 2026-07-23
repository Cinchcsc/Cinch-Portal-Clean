// PROBE (23 Jul 2026), task #406 — probe-daily-window-boundary.js confirmed, for InquiryTracking:
// SiteLink treats dReportDateEnd as excluding the ENTIRE calendar day it falls on, not "up through
// that timestamp" -- dReportDateEnd=2026-07-21T00:00:00 AND dReportDateEnd=2026-07-21T23:59:59 both
// silently drop July 21 entirely; only dReportDateEnd=2026-07-22T00:00:00 (the START of the NEXT day)
// correctly includes it.
//
// lib/pull.js's own month-end date is built the SAME shape:
//   const endOf = (month) => new Date(month.getFullYear(), month.getMonth() + 1, 0)
// `new Date(y, m+1, 0)` gives midnight of the LAST DAY of the target month (e.g. June 30 00:00:00),
// not the start of the FOLLOWING month -- structurally identical to the daily bug. If SiteLink's
// end-date exclusivity holds for FULL-MONTH windows too (not just single days), and for OTHER report
// methods (not just InquiryTracking), then every monthly pull -- Enquiries, Reservations, Move-ins/
// outs, Financials, True Revenue, Discounts, everything -- may have been silently dropping the LAST
// CALENDAR DAY of every month, every site, this whole project. That's a much bigger claim than one
// data point justifies, so this tests it properly before treating it as real:
//
//   1. InquiryTracking, full June 2026, Bicester: current endOf() bound vs corrected (1 July) bound --
//      does June 30 specifically show up as extra rows/enquiries/reservations with the fix?
//   2. Same test against a SECOND, structurally different report (FinancialSummary) -- does the same
//      exclusion happen there, or is this specific to InquiryTracking's own report engine?
//   3. Same test against MoveInsAndMoveOuts (the report task #404/#405's area-rewind work depends on).
//
// Run:  node --env-file=.env scripts/probe-monthend-exclusive-bug.js
import { callReport, extractNamedTable } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const SITE = 'L001';
const currentEndOf = new Date(2026, 5, 30);   // pull.js's own endOf(June): new Date(y, m+1, 0) = June 30 00:00:00
const fixedEndOf = new Date(2026, 6, 1);      // start of the NEXT month instead
const juneStart = new Date(2026, 5, 1);

console.log(`${'='.repeat(95)}\nSite ${SITE}, June 2026 -- current end bound (${currentEndOf.toISOString().slice(0,10)}) vs fixed end bound (${fixedEndOf.toISOString().slice(0,10)})\n${'='.repeat(95)}`);

console.log(`\n--- InquiryTracking (lead_funnel) ---`);
{
  const cur = await callReport('InquiryTracking', SITE, juneStart, currentEndOf);
  const fix = await callReport('InquiryTracking', SITE, juneStart, fixedEndOf);
  const curActivity = extractNamedTable(cur.raw, 'Activity');
  const fixActivity = extractNamedTable(fix.raw, 'Activity');
  console.log(`  Activity rows: current=${curActivity.length}  fixed=${fixActivity.length}  (diff=${fixActivity.length - curActivity.length})`);
  const curParsed = REPORTS.lead_funnel.parse(cur.rows, juneStart, currentEndOf, cur.raw);
  const fixParsed = REPORTS.lead_funnel.parse(fix.rows, juneStart, fixedEndOf, fix.raw);
  console.log(`  total_enquiries: current=${curParsed.total_enquiries}  fixed=${fixParsed.total_enquiries}  (diff=${fixParsed.total_enquiries - curParsed.total_enquiries})`);
  console.log(`  reservation_stage_count: current=${curParsed.reservation_stage_count}  fixed=${fixParsed.reservation_stage_count}  (diff=${fixParsed.reservation_stage_count - curParsed.reservation_stage_count})`);
  const june30Rows = fixActivity.filter((r) => String(r.dPlaced || '').startsWith('2026-06-30'));
  console.log(`  June 30 rows present in the FIXED pull specifically: ${june30Rows.length}`);
}

console.log(`\n--- FinancialSummary (structurally different report engine) ---`);
{
  const cur = await callReport('FinancialSummary', SITE, juneStart, currentEndOf);
  const fix = await callReport('FinancialSummary', SITE, juneStart, fixedEndOf);
  console.log(`  Top-level rows: current=${cur.rows.length}  fixed=${fix.rows.length}`);
  // FinancialSummary's Charge/Rent row is a PERIOD AGGREGATE (no per-row date), so a date-boundary
  // bug here wouldn't show as a row-count difference -- it would show as the aggregate VALUE itself
  // changing between the two end bounds, which is exactly what we check.
  function findChargeRent(raw) {
    let diff = null;
    (function find(node) { if (!node || typeof node !== 'object' || diff) return; for (const [k, v] of Object.entries(node)) { if (diff) return; if (/diffgram/i.test(k) && v && typeof v === 'object') { diff = v; return; } if (v && typeof v === 'object') find(v); } })(raw);
    const scope = diff || raw;
    let chargeRows = null;
    const seen = new Set();
    (function walk(node) { if (!node || typeof node !== 'object' || seen.has(node) || chargeRows) return; seen.add(node); for (const [k, v] of Object.entries(node)) { if (Array.isArray(v) && v.length && typeof v[0] === 'object' && k.toLowerCase() === 'charge') { chargeRows = v; return; } else if (v && typeof v === 'object') walk(v); } })(scope);
    if (!chargeRows) return null;
    const flat = chargeRows.map((r) => (r && r.attributes ? { ...r.attributes, ...r } : r));
    return flat.find((r) => String(r.sChgDesc || '').toLowerCase() === 'rent' || String(r.sChgCategory || '').toLowerCase() === 'rent');
  }
  const curRent = findChargeRent(cur.raw), fixRent = findChargeRent(fix.raw);
  console.log(`  Charge/Rent row -- current: ${curRent ? JSON.stringify({ Charge: curRent.Charge, Credit: curRent.Credit, Payment: curRent.Payment }) : 'not found'}`);
  console.log(`  Charge/Rent row -- fixed:   ${fixRent ? JSON.stringify({ Charge: fixRent.Charge, Credit: fixRent.Credit, Payment: fixRent.Payment }) : 'not found'}`);
}

console.log(`\n--- MoveInsAndMoveOuts (move_ins_outs) ---`);
{
  const cur = await callReport('MoveInsAndMoveOuts', SITE, juneStart, currentEndOf);
  const fix = await callReport('MoveInsAndMoveOuts', SITE, juneStart, fixedEndOf);
  console.log(`  Rows: current=${cur.rows.length}  fixed=${fix.rows.length}  (diff=${fix.rows.length - cur.rows.length})`);
  const curParsed = REPORTS.move_ins_outs.parse(cur.rows);
  const fixParsed = REPORTS.move_ins_outs.parse(fix.rows);
  console.log(`  move_ins: current=${curParsed.move_ins}  fixed=${fixParsed.move_ins}   move_outs: current=${curParsed.move_outs}  fixed=${fixParsed.move_outs}`);
  const june30Rows = fix.rows.filter((r) => String(r.MoveDate || '').startsWith('2026-06-30'));
  console.log(`  June 30 rows present in the FIXED pull specifically: ${june30Rows.length}`);
}

console.log(`\n${'='.repeat(95)}\nIf the "fixed" column shows more rows / higher counts / different aggregate\nvalues than "current" for ANY of these three reports, June 30 was being\nsilently excluded by pull.js's endOf() -- a real, portfolio-wide, every-month\ndata completeness bug, not just a Daily Snapshot issue. If they're identical,\nthis specific bug is confined to the single-day daily-snapshot case.\n${'='.repeat(95)}`);
process.exit(0);
