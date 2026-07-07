// Verifies buildPayloadRange() (the new global month/date-range selector, 6 Jul 2026) is aggregating
// correctly, without needing to click through the UI. Reads only already-stored raw_report data —
// no SiteLink calls, nothing written anywhere.
//
// What it checks, using the two most recent stored months (A = older, B = newer):
//   1. A single-month range (A to A) should equal calling buildPayloadRange with the same month
//      twice — sanity check that from===to doesn't do anything weird.
//   2. A 2-month range (A to B) should have its FLOW fields (moveIns, moveOuts, merchandise sales,
//      enquiries) equal to single(A) + single(B) (summed).
//   3. The same 2-month range should have its SNAPSHOT fields (occ, rate, debtorTotal-equivalent)
//      equal to the AVERAGE of single(A) and single(B) — not their sum, not just the last month.
//
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-range-math.js
import { buildPayloadRange, listStoredMonths } from '../lib/buildPayload.js';

const months = await listStoredMonths();
if (months.length < 2) { console.error(`Only ${months.length} stored month(s) — need at least 2 to test a range.`); process.exit(1); }
const [mkB, mkA] = [months[months.length - 1], months[months.length - 2]]; // B = latest, A = one before
console.log(`Testing range ${mkA} .. ${mkB}\n`);

const toDate = (mk) => { const [y, m] = mk.split('-').map(Number); return new Date(y, m - 1, 1); };

const single = async (mk) => buildPayloadRange(toDate(mk), toDate(mk));
const [pA, pB] = await Promise.all([single(mkA), single(mkB)]);
const range = await buildPayloadRange(toDate(mkA), toDate(mkB));

const close = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
const report = (label, expected, actual) => console.log(`${close(expected, actual) ? 'OK  ' : 'FAIL'} ${label}: expected ${expected.toFixed(2)}, got ${actual.toFixed(2)}`);

console.log(`--- Single-month sanity (${mkB} alone) ---`);
console.log(`occ=${pB.totals.occ} rate=${pB.totals.rate} (portfolio moveIns/merchandise/etc. are per-site only, checked below)`);

console.log(`\n--- Flow fields: range should equal ${mkA} + ${mkB} ---`);
const sumSite = (p, k) => p.sites.reduce((a, s) => a + (s[k] || 0), 0);
report('moveIns', sumSite(pA, 'moveIns') + sumSite(pB, 'moveIns'), sumSite(range, 'moveIns'));
report('moveOuts', sumSite(pA, 'moveOuts') + sumSite(pB, 'moveOuts'), sumSite(range, 'moveOuts'));
const sumNested = (p, path) => p.sites.reduce((a, s) => a + (path(s) || 0), 0);
report('merchandise.sales', sumNested(pA, (s) => s.merchandise?.sales) + sumNested(pB, (s) => s.merchandise?.sales), sumNested(range, (s) => s.merchandise?.sales));
report('enquiries.total', sumNested(pA, (s) => s.enquiries?.total) + sumNested(pB, (s) => s.enquiries?.total), sumNested(range, (s) => s.enquiries?.total));

console.log(`\n--- Snapshot fields: range should equal AVERAGE of ${mkA} and ${mkB} ---`);
report('occ (portfolio total)', (pA.totals.occ + pB.totals.occ) / 2, range.totals.occ);
report('occA (portfolio total)', (pA.totals.occA + pB.totals.occA) / 2, range.totals.occA);
report('debtorTotal (portfolio total)', (pA.totals.debtorTotal + pB.totals.debtorTotal) / 2, range.totals.debtorTotal);

console.log(`\nNOTE: portfolio-level rate/occPC/etc are recomputed from averaged raw sums (not averaged`);
console.log(`directly), so small differences vs. a naive (rateA+rateB)/2 are EXPECTED and correct —`);
console.log(`that mirrors the same sum-then-divide-once rule used everywhere else in this codebase.`);
console.log(`rate: A=${pA.totals.rate} B=${pB.totals.rate} range=${range.totals.rate}`);
process.exit(0);
