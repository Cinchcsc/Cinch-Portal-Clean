// URGENT follow-up to probe-managementsummary-rangebug.js (8 Jul 2026): confirmed a multi-day range
// undercount on ManagementSummary for 8/8 sites on the CURRENT, still-open month (Jul 1-8). Before
// treating this as a portfolio-wide historical data problem, this checks the ONE thing that actually
// determines the blast radius: does the SAME mismatch happen on a CLOSED, historical month (June,
// fully in the past) — one full-month call vs summing every individual day?
//   - If June ALSO mismatches: years of stored history (move_ins/move_outs/leads across the whole
//     backfill) could be wrong. Big problem, needs urgent triage.
//   - If June does NOT mismatch: the bug is specific to ranges touching "today" / the still-open
//     month. Bad, but narrow — only the live current-month figures need day-by-day re-pulling; all
//     locked historical data stays trustworthy.
// Only checks 2 sites (L001, L002) x full June — 30 calls each — to keep this fast; widen if the
// answer here is worrying.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-rangebug-historical.js
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const locations = ['L001', 'L002'];
const start = new Date(2026, 5, 1);   // June 1
const end = new Date(2026, 5, 30);    // June 30 — fully closed, well before "today" (Jul 8)

for (const loc of locations) {
  const { rows: fullRows } = await callReport('ManagementSummary', loc, start, end);
  const full = REPORTS.management.parse(fullRows);
  let dayWalk = 0, dayMoveIns = 0, dayMoveOuts = 0, dayPhone = 0, dayWeb = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = new Date(d), de = new Date(d);
    process.stderr.write(`[hist] ${loc} ${ds.toISOString().slice(0, 10)}...\n`);
    const { rows } = await callReport('ManagementSummary', loc, ds, de);
    const p = REPORTS.management.parse(rows);
    dayWalk += p.walkin_leads || 0; dayMoveIns += p.move_ins || 0; dayMoveOuts += p.move_outs || 0;
    dayPhone += p.phone_leads || 0; dayWeb += p.web_leads || 0;
  }
  console.log(`\n${loc} — June 2026 (CLOSED, historical month), one full-month call vs summed daily calls:`);
  console.log(`  move_ins:    one-call=${full.move_ins}    summed-days=${dayMoveIns}    ${full.move_ins !== dayMoveIns ? 'MISMATCH' : 'match'}`);
  console.log(`  move_outs:   one-call=${full.move_outs}   summed-days=${dayMoveOuts}   ${full.move_outs !== dayMoveOuts ? 'MISMATCH' : 'match'}`);
  console.log(`  walkin_leads: one-call=${full.walkin_leads}  summed-days=${dayWalk}  ${full.walkin_leads !== dayWalk ? 'MISMATCH' : 'match'}`);
  console.log(`  phone_leads: one-call=${full.phone_leads}  summed-days=${dayPhone}  ${full.phone_leads !== dayPhone ? 'MISMATCH' : 'match'}`);
  console.log(`  web_leads:   one-call=${full.web_leads}   summed-days=${dayWeb}   ${full.web_leads !== dayWeb ? 'MISMATCH' : 'match'}`);
}
console.log('\nIf June matches cleanly across the board: bug is scoped to the still-open current month only —');
console.log('historical/locked data is safe, only the live current-month pull logic needs fixing.');
console.log('If June ALSO mismatches: this is a historical data-integrity problem, much bigger than Enquiries —');
console.log('needs immediate triage before anything else in this session.');
process.exit(0);
