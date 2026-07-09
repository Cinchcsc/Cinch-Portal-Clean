// Michael's boss sent MerchandiseActivity_20260701_20260709.xlsx (L001, per-transaction inventory
// log) alongside MerchandiseSummary (the report we already pull). MerchandiseActivity has columns
// MerchandiseSummary doesn't: sReason (Sold/Shipment/Other/...), sTenantName. In the sample file, the
// ONE "Sold" row has sTenantName = "Walk-In POS" (SiteLink's placeholder for a till sale with no
// account attached) — the other two rows aren't sales at all (a stock adjustment, a shipment
// receipt).
//
// This is a lead on the ~11x Merchandise-Income-per-New-Customer gap: every numerator we've tried
// (MerchandiseSummary.dcChargeTotal, FinancialSummary's POS category, True Revenue's AccountCode
// 201) is a straight revenue total with NO tenant attribution.
//
// PASS 1 (portfolio, June 2026): excluding Walk-In POS dropped merch-per-new-customer from £9.29 to
// £2.75 -- real, but legacy shows ~£1.00, so ~2.75x still unexplained.
//
// PASS 2 (name-matching, ABANDONED): tried joining each "Sold" row's sTenantName against this
// period's actual movers (MoveInsAndMoveOuts.TenantName) to test the boss's "sales report, then new
// customers for that period" literally. Exact match: 0/244. Token-set match (word-order/comma
// invariant): 0/244. Surname-only match: also inconclusive. Confirmed via a PII-safe comma-presence
// check that punctuation format was NOT the issue (both sides are ~100% "Last, First"), so this
// wasn't a normalization bug -- more likely MoveInsAndMoveOuts' TenantName is scoped ONLY to
// tenants with a move event that month (a narrow list), while most merchandise buyers are ordinary
// existing tenants who won't appear there AT ALL regardless of matching quality. Continuing to tune
// the join was guessing, not analysis -- dropped it.
//
// PASS 3 (this version) -- ANALYSIS instead of guessing: sidesteps name-matching entirely by testing
// the underlying mechanism with numbers we already have, no new report needed. Hypothesis: if
// merchandise sales are genuinely driven by new move-ins, then ACROSS SITES, a site's move-in count
// this month should correlate with its Walk-In-POS £ (the theory being that a brand-new tenant's
// first padlock/box purchase often happens AT SIGNUP, before their tenant record exists in the
// system -- which would explain why it's tagged "Walk-In POS" and not a real tenant name -- exactly
// the OPPOSITE of Pass 1's assumption). Computes Pearson correlation between per-site move-ins and
// (a) Walk-In POS £, (b) named-tenant £, (c) total merch £, across all sites in one pull. If (a) >>
// (b), Walk-In POS sales ARE largely new-mover-driven and Pass 1 excluded the wrong bucket. If (b) >>
// (a), existing-tenant sales track movers better (closer to Pass 1's assumption, still needs
// explaining why the name join found none). If both ~= (c), merch just scales with general site
// activity/size and isn't cleanly attributable to "new customers" via either bucket -- meaning
// legacy's ~£1.00 likely comes from a genuinely different report or denominator we haven't found
// yet, at which point the next move is to ask what specific report legacy's number comes from,
// rather than reverse-engineering it from ours.
//
// PASS 3 RESULT (portfolio, June 2026): all three correlations came back weak -- Walk-In POS r=0.11,
// named-tenant r=0.26, total merch r=0.18. None of our numerator candidates track move-in volume
// across sites. Conclusion: general retail merchandise (bubblewrap/tape/boxes bought whenever) is
// swamping any real move-in signal, regardless of which tenant-attribution bucket it's sliced by.
//
// PASS 4 -- one more GROUNDED hypothesis before giving up on our own data: most self-storage
// operators require a padlock purchase AT signup. MerchandiseSummary already tags this with its own
// sCategory ("Locks Income" -- confirmed from the boss's export: Combination/Container Padlock,
// Padlock are the SKUs in it). If legacy's "merchandise income" specifically means that mandatory
// move-in item, not general retail, Locks Income £ should correlate with move-ins far more tightly
// than Pass 3's buckets did. No tenant-matching needed for this one -- straight from
// MerchandiseSummary, which we already pull and trust.
//
// PASS 4 RESULT (portfolio, July 1-9): Locks Income corr = -0.20, the WEAKEST of all four (Walk-In
// -0.02, named 0.12, total 0.02). Locks alone doesn't explain it either.
//
// PASS 5 (this version) -- Michael pulled LIVE legacy figures for the SAME July 1-9 window: L001
// (Bicester) and L012 (Gillingham) BOTH show £0, and "All Stores" moved from £1.00 to £1.10 in one
// day (so it's a live MTD calc, not a stable number -- explains the volatility, not a red herring).
// Checked our own numbers for those exact two sites, same window: L001 named-tenant £0 AND Locks £0;
// L012 named-tenant £0 AND Locks £0 -- BOTH our "excl. Walk-In POS" and "Locks only" numerators hit
// EXACTLY £0 at BOTH sites, matching legacy exactly. Neither hypothesis alone explains the portfolio
// total (£3.00 / £0.52 vs legacy's £1.10) but this is the first exact match anywhere, at two
// independent real sites, and it's non-trivial (Walk-In-POS-only and ALL-sales are NOT zero at either
// site, so it's not just "small numbers round to zero"). Refines to the INTERSECTION: a lock SKU
// (sDesc matches /padlock/i in MerchandiseActivity) bought by a NAMED tenant specifically (excludes
// Walk-In POS lock sales, which Pass 4's Locks Income didn't distinguish) -- the idea being a new
// mover's lock is added to THEIR ledger at move-in, while a Walk-In-POS lock sale is more likely an
// existing tenant replacing a lost key at the counter.
//
// PASS 5 RESULT (portfolio, July 1-9): named-tenant-lock £ == Locks Income £ EXACTLY at every site
// (£147.00 both) -- zero Walk-In POS lock sales happened anywhere this window, so the intersection
// added no new information (same r=-0.20, same £0.52/customer as Pass 4). Also had to walk back part
// of the Pass 5 rationale: Locks£ is £0 at 21 of 29 sites (73%), so L001/L012 both showing £0 is the
// base rate, not a meaningful match -- and the correlation is NEGATIVE, i.e. actual evidence against
// the locks hypothesis, not for it. Separately ruled out IncomeAnalysis (a previously-untested SOAP
// report) as a lead: pulled its full category breakdown (both Cash and Accrual bases) and it's a pure
// rent-reconciliation waterfall (Gross Potential -> Vacancy Loss -> Rent Payments by method ->
// Discounts/Concessions) -- zero rows relate to merchandise or customer counts.
//
// PASS 6 (this version) -- untested assumption on the DENOMINATOR side: every pass so far has divided
// by ALL MoveIn=true rows in MoveInsAndMoveOuts. A TRANSFER (existing tenant moving to a different
// unit at the SAME site) also sets MoveIn=true on the destination row -- it is not a new customer,
// and we've never excluded it. If transfers are inflating the "new customer" denominator, every ratio
// so far (all systematically off from legacy's ~£1.10, either much too high [sales-based] or ~2.1x
// too low [locks-based]) has been divided by the wrong number. Adds a Transfer-excluded move-ins
// count alongside the raw one and recomputes every ratio + correlation against both, to see whether
// removing transfers moves the locks-based numerators (the closest so far in magnitude) toward £1.10.
//
// PASS 6 RESULT (portfolio, July 1-9): zero transfers at EVERY one of the 29 sites this window
// (MoveIns == NewMI everywhere) -- a clean non-event, not an inconclusive result. Denominator-side
// transfer contamination is ruled out for this window. With this, 5 numerators x this denominator
// test = every combination our own two reports can produce has now been tried; none matches legacy's
// ~£1.10 in both magnitude AND correlation direction. Also worth noting: "Merchandise Income per New
// Customer" never appeared as its own checkbox/report name in Michael's legacy report-picker
// screenshot (probe-report-catalog.js's 76-label diff) -- like "Realtime Ranking"/"Site Activity", it
// is almost certainly a COMPOSED dashboard tile, not a pullable report, consistent with the boss's
// own "find a merch report, then new customers" description. That means our ingredients (Merchandise
// Summary/Activity + MoveInsAndMoveOuts) are probably the right raw material -- the exact subset/
// scope is what's eluding us, and guessing more subsets of the same two reports is diminishing
// returns after 10 tried combinations. Next highest-leverage step is external, not more code: get ONE
// more live legacy figure at a site where our 5 candidate ratios are maximally spread out (so a match
// is decisive, not another zero-matches-zero coincidence) -- e.g. L029, 7 move-ins: ALL sales £42.43,
// excl. Walk-In £16.43, Walk-In only £26.00, Locks £1.43/customer per this window's numbers.
// Run one site:      cd cinch-portal-clean && node --env-file=.env scripts/probe-merch-activity.js L001 2026-06
// Run the portfolio: cd cinch-portal-clean && node --env-file=.env scripts/probe-merch-activity.js ALL 2026-06
// (ALL reads site codes from SITELINK_LOCATIONS in .env; runs sequentially — SiteLink rejects
// parallel logons, same constraint as scripts/backfill.js.)
import { callReport } from '../lib/sitelink.js';
import { REPORTS } from '../lib/reportMap.js';

const siteArg = process.argv[2] || 'L001';
const monthArg = process.argv[3]; // optional YYYY-MM; defaults to current month-to-date
const now = new Date();
let start, end;
if (monthArg) {
  const [y, m] = monthArg.split('-').map(Number);
  start = new Date(y, m - 1, 1);
  const fullMonthEnd = new Date(y, m, 0);
  const isCurrentMonth = y === now.getFullYear() && m === now.getMonth() + 1;
  end = isCurrentMonth && fullMonthEnd > now ? now : fullMonthEnd;
} else {
  start = new Date(now.getFullYear(), now.getMonth(), 1);
  end = now;
}
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const num = (v) => Number(v) || 0;
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));

const bucket = (r) => {
  const t = (r.sTenantName || '').trim();
  if (!t) return 'blank';
  if (/^walk-?in pos$/i.test(t)) return 'walkIn';
  return 'named';
};

// One site's worth of work — no PII ever leaves this function; only aggregate £ per bucket.
async function runSite(siteCode) {
  const { rows: msRows } = await callReport(REPORTS.merchandise.method, siteCode, start, end);
  const officialSales = msRows.reduce((a, r) => a + num(r.dcChargeTotal), 0);
  // NEW hypothesis (grounded, not a format guess): the cross-site correlation just showed NEITHER
  // Walk-In-POS nor named-tenant merch £ tracks move-ins (r=0.11/0.26, both weak). That means general
  // retail merchandise (bubblewrap, tape, boxes bought whenever) is swamping any real move-in signal
  // at the site level. Most self-storage operators require a padlock purchase AT signup — MerchandiseSummary
  // already tags these with their own sCategory ("Locks Income", confirmed from the boss's export:
  // Combination/Container Padlock, Padlock). If legacy's "merchandise income" specifically means THAT
  // mandatory move-in item (not general retail), locksIncome should correlate with move-ins much more
  // tightly than the Walk-In/named split did.
  const locksIncome = msRows.filter((r) => /locks?\s*income/i.test(r.sCategory || '')).reduce((a, r) => a + num(r.dcChargeTotal), 0);
  const rateBySku = {};
  for (const r of msRows) {
    const units = Math.abs(num(r.dcSold));
    if (units > 0) rateBySku[r.sDesc] = num(r.dcChargeTotal) / units;
  }

  const { rows: mgRows } = await callReport('MoveInsAndMoveOuts', siteCode, start, end);
  const moveInRows = mgRows.filter((r) => yes(r.MoveIn));
  const moveIns = moveInRows.length;
  // Pass 6: a transfer (existing tenant, different unit, SAME site) also sets MoveIn=true on the
  // destination row -- it is not a new customer. This is the count with those excluded.
  const moveInsNewOnly = moveInRows.filter((r) => !yes(r.Transfer)).length;

  const { rows } = await callReport('MerchandiseActivity', siteCode, start, end);
  const sold = rows.filter((r) => /^sold$/i.test(r.sReason || ''));

  const amounts = { walkIn: 0, named: 0, blank: 0 };
  const counts = { walkIn: 0, named: 0, blank: 0 };
  let noRate = 0, namedLocks = 0;
  for (const r of sold) {
    const b = bucket(r);
    const rate = rateBySku[r.sDesc];
    if (rate == null) { noRate++; continue; }
    const amount = rate * num(r.dcQty);
    amounts[b] += amount;
    counts[b]++;
    // Pass 5: named tenant AND a lock SKU specifically — the intersection, not just either alone.
    if (b === 'named' && /padlock/i.test(r.sDesc || '')) namedLocks += amount;
  }
  return { amounts, counts, officialSales, noRate, rowCount: rows.length, moveIns, moveInsNewOnly, locksIncome, namedLocks };
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(xs), my = mean(ys);
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
  const denom = Math.sqrt(vx * vy);
  return denom ? cov / denom : null;
}

if (siteArg.toUpperCase() === 'ALL') {
  const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!locations.length) { console.error('SITELINK_LOCATIONS not set'); process.exit(1); }
  console.log(`=== MerchandiseActivity probe, ALL ${locations.length} sites, ${fmt(start)} to ${fmt(end)} ===\n`);
  console.log(`${'Site'.padEnd(6)}${'MoveIns'.padStart(9)}${'NewMI'.padStart(7)}${'WalkIn£'.padStart(11)}${'Named£'.padStart(10)}${'Locks£'.padStart(10)}${'NamedLk£'.padStart(11)}${'Total£'.padStart(10)}`);

  const perSite = [];
  let portfolioOfficial = 0, portfolioNoRate = 0, portfolioRows = 0, portfolioLocks = 0, portfolioNamedLocks = 0;
  const totalAmounts = { walkIn: 0, named: 0, blank: 0 };
  const totalCounts = { walkIn: 0, named: 0, blank: 0 };
  for (const loc of locations) {
    try {
      const r = await runSite(loc);
      console.log(`${loc.padEnd(6)}${String(r.moveIns).padStart(9)}${String(r.moveInsNewOnly).padStart(7)}${('£' + r.amounts.walkIn.toFixed(0)).padStart(11)}${('£' + r.amounts.named.toFixed(0)).padStart(10)}${('£' + r.locksIncome.toFixed(0)).padStart(10)}${('£' + r.namedLocks.toFixed(0)).padStart(11)}${('£' + r.officialSales.toFixed(0)).padStart(10)}`);
      perSite.push({ code: loc, moveIns: r.moveIns, moveInsNewOnly: r.moveInsNewOnly, walkIn: r.amounts.walkIn, named: r.amounts.named, total: r.officialSales, locks: r.locksIncome, namedLocks: r.namedLocks });
      portfolioOfficial += r.officialSales;
      portfolioNoRate += r.noRate;
      portfolioRows += r.rowCount;
      portfolioLocks += r.locksIncome;
      portfolioNamedLocks += r.namedLocks;
      for (const k of ['walkIn', 'named', 'blank']) { totalAmounts[k] += r.amounts[k]; totalCounts[k] += r.counts[k]; }
    } catch (e) { console.error(`${loc}: FAILED — ${e.message}`); }
  }

  console.log(`\n${portfolioRows} total activity row(s) across ${locations.length} sites (${portfolioNoRate} "Sold" row(s) skipped — SKU not priced that window).`);
  console.log(`\nPortfolio £ by bucket: Walk-In POS £${totalAmounts.walkIn.toFixed(2)} (${totalCounts.walkIn} txn) | named tenant £${totalAmounts.named.toFixed(2)} (${totalCounts.named} txn) | blank £${totalAmounts.blank.toFixed(2)} (${totalCounts.blank} txn)`);
  console.log(`Locks Income (MerchandiseSummary sCategory, all buyers): £${portfolioLocks.toFixed(2)}`);
  console.log(`Named-tenant lock sales only (MerchandiseActivity, Pass 5 intersection): £${portfolioNamedLocks.toFixed(2)}`);
  console.log(`MerchandiseSummary.dcChargeTotal for the same sites/window: £${portfolioOfficial.toFixed(2)} (reconciliation check)`);

  const moveInsArr = perSite.map((s) => s.moveIns);
  const moveInsNewOnlyArr = perSite.map((s) => s.moveInsNewOnly);
  const walkInArr = perSite.map((s) => s.walkIn);
  const namedArr = perSite.map((s) => s.named);
  const totalArr = perSite.map((s) => s.total);
  const locksArr = perSite.map((s) => s.locks);
  const namedLocksArr = perSite.map((s) => s.namedLocks);
  console.log(`\nCross-site correlation with ALL move-ins incl. transfers (n=${perSite.length} sites; -1..+1, 0 = no relationship):`);
  console.log(`  corr(moveIns, Walk-In POS £)   = ${pearson(moveInsArr, walkInArr)?.toFixed(2) ?? 'n/a'}`);
  console.log(`  corr(moveIns, named-tenant £)  = ${pearson(moveInsArr, namedArr)?.toFixed(2) ?? 'n/a'}`);
  console.log(`  corr(moveIns, named-tenant locks £) = ${pearson(moveInsArr, namedLocksArr)?.toFixed(2) ?? 'n/a'}`);
  console.log(`  corr(moveIns, total merch £)   = ${pearson(moveInsArr, totalArr)?.toFixed(2) ?? 'n/a'}`);
  console.log(`  corr(moveIns, Locks Income £)  = ${pearson(moveInsArr, locksArr)?.toFixed(2) ?? 'n/a'}`);

  console.log(`\nPass 6 — same correlations with transfers EXCLUDED from move-ins:`);
  console.log(`  corr(new-mover MI, Walk-In POS £)   = ${pearson(moveInsNewOnlyArr, walkInArr)?.toFixed(2) ?? 'n/a'}`);
  console.log(`  corr(new-mover MI, named-tenant £)  = ${pearson(moveInsNewOnlyArr, namedArr)?.toFixed(2) ?? 'n/a'}`);
  console.log(`  corr(new-mover MI, named-tenant locks £) = ${pearson(moveInsNewOnlyArr, namedLocksArr)?.toFixed(2) ?? 'n/a'}`);
  console.log(`  corr(new-mover MI, total merch £)   = ${pearson(moveInsNewOnlyArr, totalArr)?.toFixed(2) ?? 'n/a'}`);
  console.log(`  corr(new-mover MI, Locks Income £)  = ${pearson(moveInsNewOnlyArr, locksArr)?.toFixed(2) ?? 'n/a'}`);

  const moveIns = moveInsArr.reduce((a, v) => a + v, 0);
  const moveInsNewOnly = moveInsNewOnlyArr.reduce((a, v) => a + v, 0);
  console.log(`\n${moveIns} total move-ins across ${locations.length} sites for this window (${moveIns - moveInsNewOnly} of them transfers, ${moveInsNewOnly} genuinely new).`);
  console.log(`  Merch per new customer, ALL sales:                £${moveIns ? (portfolioOfficial / moveIns).toFixed(2) : 'n/a'}`);
  console.log(`  Merch per new customer, excl. Walk-In POS:        £${moveIns ? (totalAmounts.named / moveIns).toFixed(2) : 'n/a'}`);
  console.log(`  Merch per new customer, Walk-In POS only:         £${moveIns ? (totalAmounts.walkIn / moveIns).toFixed(2) : 'n/a'}`);
  console.log(`  Merch per new customer, Locks Income only:        £${moveIns ? (portfolioLocks / moveIns).toFixed(2) : 'n/a'}`);
  console.log(`  Merch per new customer, named-tenant Locks only:  £${moveIns ? (portfolioNamedLocks / moveIns).toFixed(2) : 'n/a'}`);

  console.log(`\nPass 6 — same 5 ratios, denominator = new-mover move-ins only (transfers excluded):`);
  console.log(`  Merch per new customer, ALL sales:                £${moveInsNewOnly ? (portfolioOfficial / moveInsNewOnly).toFixed(2) : 'n/a'}`);
  console.log(`  Merch per new customer, excl. Walk-In POS:        £${moveInsNewOnly ? (totalAmounts.named / moveInsNewOnly).toFixed(2) : 'n/a'}`);
  console.log(`  Merch per new customer, Walk-In POS only:         £${moveInsNewOnly ? (totalAmounts.walkIn / moveInsNewOnly).toFixed(2) : 'n/a'}`);
  console.log(`  Merch per new customer, Locks Income only:        £${moveInsNewOnly ? (portfolioLocks / moveInsNewOnly).toFixed(2) : 'n/a'}`);
  console.log(`  Merch per new customer, named-tenant Locks only:  £${moveInsNewOnly ? (portfolioNamedLocks / moveInsNewOnly).toFixed(2) : 'n/a'}`);
} else {
  console.log(`=== MerchandiseActivity probe, ${siteArg}, ${fmt(start)} to ${fmt(end)} ===`);
  const r = await runSite(siteArg);
  console.log(`${r.rowCount} activity row(s) returned. ${r.moveIns} move-ins this window (${r.moveIns - r.moveInsNewOnly} transfer(s), ${r.moveInsNewOnly} genuinely new).`);
  console.log(`Walk-In POS: ${r.counts.walkIn} txn, £${r.amounts.walkIn.toFixed(2)} | named tenant: ${r.counts.named} txn, £${r.amounts.named.toFixed(2)} | blank: ${r.counts.blank} txn, £${r.amounts.blank.toFixed(2)}`);
  console.log(`Locks Income (MerchandiseSummary sCategory): £${r.locksIncome.toFixed(2)}`);
  console.log(`Named-tenant lock sales only (Pass 5 intersection): £${r.namedLocks.toFixed(2)}`);
  if (r.noRate) console.log(`(${r.noRate} "Sold" row(s) skipped — SKU not found in MerchandiseSummary for that window)`);
  console.log(`MerchandiseSummary.dcChargeTotal for reconciliation: £${r.officialSales.toFixed(2)}`);
}
process.exit(0);
