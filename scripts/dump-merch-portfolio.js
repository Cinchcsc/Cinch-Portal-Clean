// Merchandise Income per New Customer: portfolio-wide breakdown, now testing ALTERNATIVE "new
// customer" denominators.
// Prior investigation (all confirmed, see git log / docs/roadmap.md for the full trail): the numerator
// (gross POS charge from FinancialSummary) is correct per legacy's own tooltip; the current denominator
// (ManagementSummary's move_ins) agrees exactly with MoveInsAndMoveOuts; the portfolio sum-then-divide
// math reproduces the live £11.01 exactly, and no single site's data is anomalous — the £11.01 is a
// smooth, genuine aggregate of 29 real sites. Every mechanical/data-quality explanation is exhausted.
// NEW ANGLE (9 Jul 2026): this codebase already computes MULTIPLE other "new customer"-ish counts for
// OTHER widgets, each with a different scope than plain move-ins:
//   - autobillNewTotal = count of DISTINCT move-in tenant IDs (buildPayload.js) — should be very close
//     to moveIns (same underlying event, counted a different way) but worth confirming they actually agree.
//   - reservationsMade = InquiryTracking's reservation-stage count for the period (built 6 Jul 2026
//     specifically as a reliable historical flow metric for "Reservations vs Move-outs") — this counts
//     people who RESERVED this period, a materially different (and likely larger) population than
//     people who completed a move-in this period.
// If legacy's "new customer" denominator is actually reservations-based rather than move-in-based, that
// would shrink the ratio without any of it being a bug — just a different (and equally legitimate)
// definition. This reads buildPayload() directly (DB-only, zero live SiteLink calls) and prints the
// portfolio ratio using each candidate denominator side by side.
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

let sumMerch = 0, sumMoveIns = 0, sumAutobillTotal = 0, sumResMade = 0;
const rows = payload.sites.map((s) => {
  const merch = (s.merchandise && s.merchandise.chargeFromFinancial) || 0;
  const moveIns = s.moveIns || 0;
  const autobillTotal = s.autobillNewTotal || 0;
  const resMade = s.reservationsMade || 0;
  sumMerch += merch; sumMoveIns += moveIns; sumAutobillTotal += autobillTotal; sumResMade += resMade;
  return { code: s.code, merch, moveIns, autobillTotal, resMade };
});

rows.sort((a, b) => a.code.localeCompare(b.code));
for (const r of rows) {
  const mismatch = r.moveIns !== r.autobillTotal ? `  *** moveIns=${r.moveIns} vs autobillNewTotal=${r.autobillTotal} disagree ***` : '';
  console.log(`  ${r.code.padEnd(6)} merch=£${r.merch.toFixed(2).padStart(9)}  moveIns=${String(r.moveIns).padStart(3)}  autobillNewTotal=${String(r.autobillTotal).padStart(3)}  reservationsMade=${String(r.resMade).padStart(3)}${mismatch}`);
}

console.log(`\nPortfolio sum-then-divide, by candidate denominator:`);
console.log(`  moveIns (today's denominator):  Σ=${String(sumMoveIns).padStart(5)}  ratio=£${sumMoveIns ? (sumMerch / sumMoveIns).toFixed(2) : 'n/a'}`);
console.log(`  autobillNewTotal:                Σ=${String(sumAutobillTotal).padStart(5)}  ratio=£${sumAutobillTotal ? (sumMerch / sumAutobillTotal).toFixed(2) : 'n/a'}`);
console.log(`  reservationsMade:                 Σ=${String(sumResMade).padStart(5)}  ratio=£${sumResMade ? (sumMerch / sumResMade).toFixed(2) : 'n/a'}`);
console.log(`\n(Σmerch = £${sumMerch.toFixed(2)} in all three — only the denominator changes)`);
process.exit(0);
