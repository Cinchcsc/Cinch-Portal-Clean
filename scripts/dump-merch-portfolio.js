// Merchandise Income per New Customer: portfolio-wide breakdown.
// Five rounds of single-site (L001) checks have each independently confirmed the per-site arithmetic
// is sound and STILL land nowhere near legacy's £1.00 portfolio figure:
//   1) Multi-table double-counting in FinancialSummary — ruled out (extractRows() picks the right table).
//   2) Wrong POS source table (POSCharges vs Charge-filtered-by-category) — ruled out, they agree exactly.
//   3) moveIns denominator source (ManagementSummary vs MoveInsAndMoveOuts) — ruled out, they agree exactly.
//   4) Partial vs complete month timing — real (July's £20.00 vs June's £9.99) but not enough on its own.
//   5) Gross vs margin ("Income" = profit, not sales) — margin (£6.48) is still ~6.5x too high, AND
//      buildPayload.js's own 6 Jul 2026 comment says legacy's OWN tooltip confirmed gross FinancialSummary
//      charges (not MerchandiseSummary margin) is the right source. This hypothesis is dead twice over.
// Also found in passing: FinancialSummary's POS charge sum (£239.69) and MerchandiseSummary's own gross
// `sales` figure (£287.60) do NOT match each other for the same site/period — a ~20% cross-report gap
// that's odd but doesn't explain an 11x portfolio gap and isn't the field production reads anyway.
// With every single-site mechanical explanation exhausted, the remaining candidates are either (a) legacy's
// "new customer" denominator means something other than this-period move-ins, or (b) a portfolio-level
// aggregation effect invisible from any one site — e.g. a site with a data gap (new sites L028/L029, or
// any of the other known historical backfill gaps this project has hit before) contributing merchandise
// revenue but not move-ins, skewing the sum-then-divide ratio. This reads the SAME buildPayload() production
// code (DB-only, zero live SiteLink calls) and prints every site's merchandise/moveIns/ratio side by side,
// sorted worst-ratio-first, plus the portfolio sum-then-divide total for a sanity check against the live page.
// Run: cd cinch-portal-clean && node --env-file=.env scripts/dump-merch-portfolio.js [YYYY-MM]
import { buildPayload } from '../lib/buildPayload.js';

const monthArg = process.argv[2]; // optional YYYY-MM; defaults to current month
const now = new Date();
const curStart = monthArg
  ? new Date(Number(monthArg.split('-')[0]), Number(monthArg.split('-')[1]) - 1, 1)
  : new Date(now.getFullYear(), now.getMonth(), 1);
const prevStart = new Date(curStart.getFullYear(), curStart.getMonth() - 1, 1);

const payload = await buildPayload(curStart, prevStart);
console.log(`=== Merchandise Income per New Customer, portfolio breakdown, ${payload.current_month} (${payload.sites.length} sites) ===\n`);

let sumMerch = 0, sumMoveIns = 0;
const rows = payload.sites.map((s) => {
  const merch = (s.merchandise && s.merchandise.chargeFromFinancial) || 0;
  const moveIns = s.moveIns || 0;
  sumMerch += merch; sumMoveIns += moveIns;
  return { code: s.code, merch, moveIns, ratio: moveIns ? merch / moveIns : null };
});

rows.sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1));
for (const r of rows) {
  const flag = r.moveIns === 0 && r.merch !== 0 ? '  *** 0 move-ins but nonzero merchandise — inflates the portfolio ratio ***' : '';
  console.log(`  ${r.code.padEnd(6)} merch=£${r.merch.toFixed(2).padStart(9)}  moveIns=${String(r.moveIns).padStart(4)}  ratio=${r.ratio === null ? 'n/a (0 move-ins)' : '£' + r.ratio.toFixed(2)}${flag}`);
}

console.log(`\nPortfolio sum-then-divide: Σmerch=£${sumMerch.toFixed(2)}  ΣmoveIns=${sumMoveIns}  ratio=£${sumMoveIns ? (sumMerch / sumMoveIns).toFixed(2) : 'n/a'}`);
console.log(`(this should match what's live on the Ancillaries page right now, if portal_payload is current)`);

const zeroMoveInsWithMerch = rows.filter((r) => r.moveIns === 0 && r.merch !== 0);
if (zeroMoveInsWithMerch.length) {
  console.log(`\n${zeroMoveInsWithMerch.length} site(s) have merchandise revenue but 0 move-ins this period — each one inflates the portfolio ratio with no offsetting denominator.`);
}
process.exit(0);
