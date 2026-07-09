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
  const rateBySku = {};
  for (const r of msRows) {
    const units = Math.abs(num(r.dcSold));
    if (units > 0) rateBySku[r.sDesc] = num(r.dcChargeTotal) / units;
  }

  const { rows: mgRows } = await callReport('MoveInsAndMoveOuts', siteCode, start, end);
  const moveIns = mgRows.filter((r) => yes(r.MoveIn)).length;

  const { rows } = await callReport('MerchandiseActivity', siteCode, start, end);
  const sold = rows.filter((r) => /^sold$/i.test(r.sReason || ''));

  const amounts = { walkIn: 0, named: 0, blank: 0 };
  const counts = { walkIn: 0, named: 0, blank: 0 };
  let noRate = 0;
  for (const r of sold) {
    const b = bucket(r);
    const rate = rateBySku[r.sDesc];
    if (rate == null) { noRate++; continue; }
    amounts[b] += rate * num(r.dcQty);
    counts[b]++;
  }
  return { amounts, counts, officialSales, noRate, rowCount: rows.length, moveIns };
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
  console.log(`${'Site'.padEnd(6)}${'MoveIns'.padStart(9)}${'WalkIn£'.padStart(11)}${'Named£'.padStart(10)}${'Total£'.padStart(10)}`);

  const perSite = [];
  let portfolioOfficial = 0, portfolioNoRate = 0, portfolioRows = 0;
  const totalAmounts = { walkIn: 0, named: 0, blank: 0 };
  const totalCounts = { walkIn: 0, named: 0, blank: 0 };
  for (const loc of locations) {
    try {
      const r = await runSite(loc);
      console.log(`${loc.padEnd(6)}${String(r.moveIns).padStart(9)}${('£' + r.amounts.walkIn.toFixed(0)).padStart(11)}${('£' + r.amounts.named.toFixed(0)).padStart(10)}${('£' + r.officialSales.toFixed(0)).padStart(10)}`);
      perSite.push({ code: loc, moveIns: r.moveIns, walkIn: r.amounts.walkIn, named: r.amounts.named, total: r.officialSales });
      portfolioOfficial += r.officialSales;
      portfolioNoRate += r.noRate;
      portfolioRows += r.rowCount;
      for (const k of ['walkIn', 'named', 'blank']) { totalAmounts[k] += r.amounts[k]; totalCounts[k] += r.counts[k]; }
    } catch (e) { console.error(`${loc}: FAILED — ${e.message}`); }
  }

  console.log(`\n${portfolioRows} total activity row(s) across ${locations.length} sites (${portfolioNoRate} "Sold" row(s) skipped — SKU not priced that window).`);
  console.log(`\nPortfolio £ by bucket: Walk-In POS £${totalAmounts.walkIn.toFixed(2)} (${totalCounts.walkIn} txn) | named tenant £${totalAmounts.named.toFixed(2)} (${totalCounts.named} txn) | blank £${totalAmounts.blank.toFixed(2)} (${totalCounts.blank} txn)`);
  console.log(`MerchandiseSummary.dcChargeTotal for the same sites/window: £${portfolioOfficial.toFixed(2)} (reconciliation check)`);

  const moveInsArr = perSite.map((s) => s.moveIns);
  const walkInArr = perSite.map((s) => s.walkIn);
  const namedArr = perSite.map((s) => s.named);
  const totalArr = perSite.map((s) => s.total);
  console.log(`\nCross-site correlation with move-ins (n=${perSite.length} sites; -1..+1, 0 = no relationship):`);
  console.log(`  corr(moveIns, Walk-In POS £)   = ${pearson(moveInsArr, walkInArr)?.toFixed(2) ?? 'n/a'}`);
  console.log(`  corr(moveIns, named-tenant £)  = ${pearson(moveInsArr, namedArr)?.toFixed(2) ?? 'n/a'}`);
  console.log(`  corr(moveIns, total merch £)   = ${pearson(moveInsArr, totalArr)?.toFixed(2) ?? 'n/a'}`);

  const moveIns = moveInsArr.reduce((a, v) => a + v, 0);
  console.log(`\n${moveIns} total move-ins across ${locations.length} sites for this window.`);
  console.log(`  Merch per new customer, ALL sales:                £${moveIns ? (portfolioOfficial / moveIns).toFixed(2) : 'n/a'}`);
  console.log(`  Merch per new customer, excl. Walk-In POS:        £${moveIns ? (totalAmounts.named / moveIns).toFixed(2) : 'n/a'}`);
  console.log(`  Merch per new customer, Walk-In POS only:         £${moveIns ? (totalAmounts.walkIn / moveIns).toFixed(2) : 'n/a'}`);
} else {
  console.log(`=== MerchandiseActivity probe, ${siteArg}, ${fmt(start)} to ${fmt(end)} ===`);
  const r = await runSite(siteArg);
  console.log(`${r.rowCount} activity row(s) returned. ${r.moveIns} move-ins this window.`);
  console.log(`Walk-In POS: ${r.counts.walkIn} txn, £${r.amounts.walkIn.toFixed(2)} | named tenant: ${r.counts.named} txn, £${r.amounts.named.toFixed(2)} | blank: ${r.counts.blank} txn, £${r.amounts.blank.toFixed(2)}`);
  if (r.noRate) console.log(`(${r.noRate} "Sold" row(s) skipped — SKU not found in MerchandiseSummary for that window)`);
  console.log(`MerchandiseSummary.dcChargeTotal for reconciliation: £${r.officialSales.toFixed(2)}`);
}
process.exit(0);
