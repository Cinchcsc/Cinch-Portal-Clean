// PROBE (22 Jul 2026), task #308/#403 — Michael: RentRoll definitively doesn't carry a billing-
// frequency-desc field anywhere (confirmed via probe-rentroll-all-tables.js's full multi-table dump —
// no need to re-run it, that avenue is closed). "figure this out, those need to be exact."
//
// Re-examining probe-realrate-effective-rent-exact.js's own numbers exposes why GJE+Discounts could
// never have worked: back-solving July's target (£18.66 Total) shows Effective Rent needs to be
// ~£36,826-38,764 (depending on area), but adjRent is £56,115.65 -- meaning Credits+Discounts together
// need to net out ~£17,350-19,290/month. GeneralJournalEntries "Credits Issued" (£1,446.86) + Discounts
// excl. Non-Expiring (£2,375.78) only total £3,822.64 -- FOUR TO FIVE TIMES too small. Those two sources
// are confirmed real (clean Debit/Credit columns, cross-validated earlier against ManagementSummary's
// Concessions table) but nowhere near big enough to be the whole story. Something is structurally off,
// not just missing a small refinement.
//
// New hypothesis: R6 says "Rental Rate" (Effective Rent's starting point) is "the same billing-adjusted
// figure" as Rate's numerator -- i.e. RentRoll's dcRent. But True Revenue's own "Rent" ChargeDesc
// TruePeriod figure is SiteLink's OWN period-based *recognized* revenue calculation (not a scheduled/
// snapshot rent figure) -- it may already net out concessions/credits/discounts internally, in which
// case it could BE (or be very close to) Effective Rent directly, with little or nothing left to
// subtract. Back-of-envelope: July's True Revenue "Rent" TruePeriod was already found to be ~£37,516.70
// this task (task #308's per-category tabulation) -- much closer to the ~£36,826-38,764 needed than
// starting from RentRoll's £56,115.65 ever was.
//
// This script cleanly isolates and tests (no subset search, no unit-type blending):
//   1. True Revenue "Rent" TruePeriod alone (exact ChargeDesc match) -- Total (all 5 unit types) and SS
//      (Indoor Self Storage only) -- against both area denominators.
//   2. Same, but the INCLUSIVE /rent/i match (adds "Rent Refund Dismissed") -- to see which reading is
//      closer.
//   3. Each of the above, further reduced by GJE Credits + Discounts(excl. Non-Expiring) -- in case
//      True Revenue's Rent figure nets out SOME but not all of what legacy calls Credits/Discounts.
// All four for both June (closed) and July (live), all four legacy targets, side by side.
//
// Run:  node --env-file=.env scripts/probe-realrate-truerevenue-rent-exact.js [siteCode]
import { callReport, callCustomReport, extractNamedTable, extractRows } from '../lib/sitelink.js';
import { admin } from '../lib/supabaseAdmin.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-realrate-truerevenue-rent-exact.js <siteCode>'); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const str = (v) => String(v ?? '').trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const isSS = (t) => /self.?storage/i.test(String(t || ''));

const normalizeDiscountPlan = (value) => {
  const raw = str(value);
  if (!raw) return '(unspecified)';
  const cleaned = raw.replace(/~/g, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  const lower = cleaned.toLowerCase();
  const pctMatch = lower.match(/(\d+(?:\.\d+)?)\s*%/);
  const durationMatch = lower.match(/(\d+)\s*(?:month|months|mo|mos|mth|mths|week|weeks|wk|wks)\b/);
  const offMatch = /\boff\b/.test(lower);
  const kind = durationMatch ? (/(week|wk)/.test(durationMatch[0]) ? 'weeks' : 'months') : null;
  if (pctMatch && durationMatch && offMatch) return `${pctMatch[1]}% Off ${durationMatch[1]} ${kind}`;
  return cleaned
    .replace(/\bfor\s+(\d+)\s+months?\b/ig, '$1 months')
    .replace(/\bfor\s+(\d+)\s+weeks?\b/ig, '$1 weeks')
    .replace(/\b(\d+)\s+month\b/ig, '$1 months')
    .replace(/\b(\d+)\s+week\b/ig, '$1 weeks')
    .replace(/\bnon expiring\b/ig, 'Non-Expiring')
    .replace(/\boff\b/ig, 'Off')
    .replace(/\b[a-z]/g, (m) => m.toUpperCase());
};

const targets = { juneSS: 28.02, juneTotal: 26.39, julySS: 19.50, julyTotal: 18.66 };

function areaFromRentRoll(rows) {
  let occ = 0, total = 0, occSS = 0, totalSS = 0;
  for (const r of rows) {
    const a = num(r.Area ?? r.Area1), t = str(r.sTypeName) || 'Other';
    total += a; if (isSS(t)) totalSS += a;
    if (yes(r.bRented)) { occ += a; if (isSS(t)) occSS += a; }
  }
  return { occ: R2(occ), total: R2(total), occSS: R2(occSS), totalSS: R2(totalSS) };
}

async function trueRevenueRent(start, end) {
  const { raw } = await callCustomReport(781861, site, start, end);
  const rows = extractNamedTable(raw, 'Table1');
  let exactTotal = 0, exactSS = 0, inclTotal = 0, inclSS = 0;
  for (const r of rows) {
    const d = str(r.ChargeDesc), v = num(r.TruePeriod), t = str(r.UnitType);
    if (/rent/i.test(d)) { inclTotal += v; if (isSS(t)) inclSS += v; }
    if (d.toLowerCase() === 'rent') { exactTotal += v; if (isSS(t)) exactSS += v; }
  }
  return { exactTotal: R2(exactTotal), exactSS: R2(exactSS), inclTotal: R2(inclTotal), inclSS: R2(inclSS), rowCount: rows.length };
}

async function creditsRaw(start, end) {
  const { rows } = await callReport('GeneralJournalEntries', site, start, end);
  const creditsRows = rows.filter((r) => str(r.Description) === 'Credits Issued');
  const debit = creditsRows.reduce((a, r) => a + num(r.Debit), 0);
  return R2(Math.abs(debit));
}

async function discountsExclNonExpiring(start, end, unitTypes) {
  const { rows } = await callReport('Discounts', site, start, end);
  let total = 0, ss = 0;
  for (const r of rows) {
    const plan = normalizeDiscountPlan(r.sConcessionPlan);
    if (/non-expiring/i.test(plan)) continue;
    const amt = num(r.dcDiscount);
    total += amt;
    const t = unitTypes[str(r.sUnitName)];
    if (t && isSS(t)) ss += amt;
  }
  return { total: R2(total), ss: R2(ss) };
}

function unitTypeMap(rows) {
  const m = {};
  for (const r of rows) { const u = str(r.sUnit); if (u) m[u] = str(r.sTypeName) || 'Other'; }
  return m;
}

async function runMonth(label, rrRows, trStart, trEnd, ssTarget, totalTarget) {
  console.log(`\n${'='.repeat(74)}\n${label}  (target SS £${ssTarget}, Total £${totalTarget})\n${'='.repeat(74)}`);
  const area = areaFromRentRoll(rrRows);
  const unitTypes = unitTypeMap(rrRows);
  console.log(`Area: occ=${area.occ} total=${area.total} occSS=${area.occSS} totalSS=${area.totalSS}`);

  const tr = await trueRevenueRent(trStart, trEnd);
  console.log(`True Revenue "Rent" TruePeriod: exact-match Total=£${tr.exactTotal} SS=£${tr.exactSS} | inclusive(/rent/i) Total=£${tr.inclTotal} SS=£${tr.inclSS}  (${tr.rowCount} Table1 rows)`);

  const credits = await creditsRaw(trStart, trEnd);
  const discounts = await discountsExclNonExpiring(trStart, trEnd, unitTypes);
  console.log(`GJE Credits Issued (raw): £${credits}   Discounts excl. Non-Expiring: Total £${discounts.total} SS £${discounts.ss}`);

  console.log(`\nResults (rentBasis / areaBasis / lessCreditsDiscounts?):`);
  for (const rentBasis of ['exact', 'incl']) {
    const rentTotal = tr[`${rentBasis}Total`], rentSS = tr[`${rentBasis}SS`];
    for (const lessCD of [false, true]) {
      const effTotal = lessCD ? rentTotal - credits - discounts.total : rentTotal;
      const effSS = lessCD ? rentSS - credits - discounts.ss : rentSS;
      for (const areaBasis of ['occ', 'total']) {
        const aTotal = area[areaBasis], aSS = area[`${areaBasis}SS`];
        const rTotal = aTotal ? R2(effTotal / aTotal * 12) : 0;
        const rSS = aSS ? R2(effSS / aSS * 12) : 0;
        const gapTotal = R2(rTotal - totalTarget), gapSS = R2(rSS - ssTarget);
        const exact = Math.abs(gapTotal) < 0.005 && Math.abs(gapSS) < 0.005;
        console.log(`  rent=${rentBasis} area=${areaBasis} lessCreditsDiscounts=${lessCD}: Total=£${rTotal} (gap ${gapTotal}) SS=£${rSS} (gap ${gapSS})${exact ? '   <<< EXACT MATCH BOTH' : ''}`);
      }
    }
  }
}

const now = new Date();
const julStart = new Date(now.getFullYear(), now.getMonth(), 1);
const { rows: julyRRRows } = await callReport('RentRoll', site, julStart, now);
await runMonth('JULY 2026 (live)', julyRRRows, julStart, now, targets.julySS, targets.julyTotal);

const { data: juneRows, error: juneErr } = await admin.from('raw_report').select('raw_response').eq('site_code', site).eq('month', '2026-06-01').eq('report', 'rent_roll').limit(1);
if (juneErr) { console.error('Supabase error (June rent_roll):', juneErr.message); }
else if (!juneRows || !juneRows.length || !juneRows[0].raw_response) { console.log('\nNo frozen June rent_roll found — skipping June.'); }
else {
  const juneRRRows = extractRows(juneRows[0].raw_response);
  const juneStart = new Date(2026, 5, 1), juneEnd = new Date(2026, 6, 0);
  await runMonth('JUNE 2026 (closed)', juneRRRows, juneStart, juneEnd, targets.juneSS, targets.juneTotal);
}

console.log(`\n${'='.repeat(74)}\nLook for "<<< EXACT MATCH BOTH" on the SAME rent/area/lessCreditsDiscounts\ncombination in BOTH June and July — that's the real formula. If nothing\nmatches exactly but one combination is now much closer than the RentRoll-\ndcRent-based approach was (gaps of a few pounds, not tens), that confirms\nTrue Revenue's own "Rent" figure is the right starting point and the\nremaining gap is a smaller, identifiable adjustment rather than a wrong\nsource entirely.\n${'='.repeat(74)}`);
process.exit(0);
