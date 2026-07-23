// PROBE (23 Jul 2026), task #308/#407 — probe-monthend-exclusive-bug.js confirmed the endOf()
// exclusive-end-date bug is REAL for FinancialSummary (Rent Charge +3.4% for one day, one site, when
// June 30 is properly included) and InquiryTracking (+5 enquiries), though NOT reproduced for
// MoveInsAndMoveOuts. This directly overlaps with task #308's Real Rate work: every Real Rate probe
// this week queried True Revenue (CustomReportByReportID 781861) and FinancialSummary using the exact
// same juneEnd = new Date(2026,5,30) shape -- if True Revenue's "Rent" TruePeriod is ALSO missing
// June 30, that could explain some or all of yesterday's unresolved ~28p average gap across the 25
// legacy sites, independent of any formula question.
//
// Tests True Revenue specifically, same current-vs-fixed end-bound comparison, for Bicester June 2026.
//
// Run:  node --env-file=.env scripts/probe-truerevenue-monthend-bug.js
import { callCustomReport, extractNamedTable } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const str = (v) => String(v ?? '').trim();
const isSS = (t) => /self.?storage/i.test(String(t || ''));

const SITE = 'L001';
const juneStart = new Date(2026, 5, 1);
const currentEndOf = new Date(2026, 5, 30);  // pull.js's endOf(June): midnight of the LAST day
const fixedEndOf = new Date(2026, 6, 1);     // start of the NEXT month

async function trueRevenueRent(start, end) {
  const { raw } = await callCustomReport(781861, SITE, start, end);
  const rows = extractNamedTable(raw, 'Table1');
  let total = 0, ss = 0;
  for (const r of rows) {
    if (str(r.ChargeDesc).toLowerCase() !== 'rent') continue;
    const v = num(r.TruePeriod);
    total += v; if (isSS(r.UnitType)) ss += v;
  }
  return { total: R2(total), ss: R2(ss), rowCount: rows.length };
}

console.log(`${'='.repeat(90)}\nTrue Revenue "Rent" TruePeriod, ${SITE}, June 2026 -- current vs fixed end bound\n${'='.repeat(90)}`);
const cur = await trueRevenueRent(juneStart, currentEndOf);
const fix = await trueRevenueRent(juneStart, fixedEndOf);
console.log(`Rows: current=${cur.rowCount}  fixed=${fix.rowCount}  (diff=${fix.rowCount - cur.rowCount})`);
console.log(`Rent TruePeriod Total: current=£${cur.total}  fixed=£${fix.total}  (diff=£${R2(fix.total - cur.total)}, ${R2((fix.total - cur.total) / cur.total * 100)}%)`);
console.log(`Rent TruePeriod SS:    current=£${cur.ss}  fixed=£${fix.ss}  (diff=£${R2(fix.ss - cur.ss)})`);

console.log(`\n${'='.repeat(90)}\nIf "fixed" is meaningfully higher than "current", yesterday's Real Rate gaps\nwere partly (or entirely) an artifact of this SAME endOf() bug excluding\nJune 30 from the Rent numerator -- not a missing formula component at all.\n${'='.repeat(90)}`);
process.exit(0);
