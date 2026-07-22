// PROBE (22 Jul 2026), task #308/#403 — Michael forwarded R6's own authoritative formula directly:
//   Rate per sqft      = (Rent ÷ Area) × 12                                   [ALREADY CONFIRMED EXACT]
//   Real Rate per sqft = (Effective Rent ÷ Area) × 12
//   Effective Rent = Rent − Credits − Discounts, where:
//     Rent      = same billing-adjusted dcRent used for Rate (×1.0833 on 4-weekly/Bill28Days billers)
//     Credits   = "Fin_CreditsIssued", excluding rows whose note says "Rent: Write Off Bad Debt"
//     Discounts = "Mgmt_Discounts", excluding rows on a "Non-Expiring" plan (time-limited plans only)
//   Billing frequency, per R6: directly on RentRoll's own sBillingFreq column — we've been sourcing it
//   from a separate custom report ("Custom\Billing Frequency", ReportID 999824) instead, which has ZERO
//   history before 22 Jul 2026. If R6 is right, June's billing-adjusted Rent becomes computable for the
//   first time from June's already-frozen RentRoll snapshot — unlocking a real closed-month Rate check
//   too, not just Real Rate.
//
// This is the single decisive script for both open reconciliation questions:
//  1. Does RentRoll (frozen June from Supabase, live July) actually carry a usable billing-frequency
//     field directly, as R6 says?
//  2. Does Effective Rent, divided by EITHER occupied area or total area (incl. vacant) × 12 (R6's text
//     doesn't specify which — Rate is confirmed occupied-area, the currently-wired old Real Rate used
//     total-area, so both are tested, nothing assumed), land EXACTLY on June (SS£28.02/Total£26.39) AND
//     July (SS£19.50/Total£18.66) simultaneously?
//
// Credits (GeneralJournalEntries) and Discounts are queried fresh with each month's real date bounds —
// neither has ever been flagged a point-in-time snapshot in lib/pull.js (only RentRoll/OccupancyStatistics
// are), and Discounts' own parser already does real date-filtering (move_in_variance), so both are
// treated as genuine period reports. A date-range sanity check is printed for each so that assumption is
// verifiable, not just assumed. RentRoll (area + billing frequency) still uses the established
// frozen-Supabase-read technique for June, live call for July, per pull.js's explicit snapshot warning.
//
// SS (Self Storage) scope: Credits/Discounts rows are tenant/unit-level, so this script attempts a REAL
// join back to RentRoll's per-unit sUnit/sTypeName to split each into true Self-Storage vs other, rather
// than guessing — join hit-rate is printed so a bad join is visible, not silently trusted. If no
// unit-level field exists on a given report, that report's SS split falls back to an area-weighted
// approximation, clearly labelled [approx] and never counted toward an "EXACT MATCH" verdict.
//
// Run:  node --env-file=.env scripts/probe-realrate-effective-rent-exact.js [siteCode]
import { callReport, callCustomReport, extractRows } from '../lib/sitelink.js';
import { admin } from '../lib/supabaseAdmin.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-realrate-effective-rent-exact.js <siteCode>'); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const str = (v) => String(v ?? '').trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const isSS = (t) => /self.?storage/i.test(String(t || ''));

// Copied verbatim from lib/reportMap.js so "Non-Expiring" detection matches production exactly.
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

// ---------- does RentRoll itself carry a usable billing-frequency field? ----------
function scanBillingFreqField(rows, label) {
  console.log(`\n--- ${label}: scanning ${rows.length} raw RentRoll row(s) for a billing-frequency field ---`);
  const allKeys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
  const cols = [...allKeys];
  console.log(`Columns (union across all rows): ${cols.join(', ')}`);
  const exact = cols.find((k) => k === 'sBillingFreq');
  const fuzzy = cols.filter((k) => k !== exact && /bill.{0,4}freq/i.test(k));
  console.log(`Exact "sBillingFreq" column present: ${exact ? 'YES' : 'no'}`);
  console.log(`Fuzzy bill*freq-shaped column(s): ${fuzzy.length ? fuzzy.join(', ') : '(none)'}`);
  const field = exact || fuzzy[0] || null;
  if (field) {
    const dist = {};
    for (const r of rows) { const v = str(r[field]) || '(blank)'; dist[v] = (dist[v] || 0) + 1; }
    console.log(`Value distribution for "${field}":`, JSON.stringify(dist));
  }
  return field;
}

// ---------- unit name -> type map, straight from raw RentRoll rows (for joining Discounts/Credits) ----------
function unitTypeMap(rows) {
  const m = {};
  for (const r of rows) { const u = str(r.sUnit); if (u) m[u] = str(r.sTypeName) || 'Other'; }
  return m;
}

// ---------- occupied/total area + plain/adjusted rent, straight from raw RentRoll rows ----------
function summarizeRentRoll(rows, factorForRow) {
  let occArea = 0, totalArea = 0, occAreaSS = 0, totalAreaSS = 0;
  let adjRent = 0, adjRentSS = 0, plainRent = 0, plainRentSS = 0;
  for (const r of rows) {
    const a = num(r.Area ?? r.Area1);
    const t = str(r.sTypeName) || 'Other';
    const rent = num(r.dcRent);
    totalArea += a; if (isSS(t)) totalAreaSS += a;
    const factor = factorForRow(r);
    if (yes(r.bRented)) {
      occArea += a; if (isSS(t)) occAreaSS += a;
      plainRent += rent; if (isSS(t)) plainRentSS += rent;
      adjRent += rent * factor; if (isSS(t)) adjRentSS += rent * factor;
    }
  }
  return {
    occArea: R2(occArea), totalArea: R2(totalArea), occAreaSS: R2(occAreaSS), totalAreaSS: R2(totalAreaSS),
    adjRent: R2(adjRent), adjRentSS: R2(adjRentSS), plainRent: R2(plainRent), plainRentSS: R2(plainRentSS),
  };
}

// ---------- generic date-range sanity check: is this report really period-scoped? ----------
function dateRangeCheck(rows, start, end) {
  const dateKeys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (/^d[A-Z]/.test(k) && !Number.isNaN(Date.parse(r[k]))) dateKeys.add(k);
  for (const k of dateKeys) {
    const vals = rows.map((r) => Date.parse(r[k])).filter((t) => !Number.isNaN(t));
    if (!vals.length) continue;
    const min = new Date(Math.min(...vals)), max = new Date(Math.max(...vals));
    const inRange = min >= new Date(start.getTime() - 86400000) && max <= new Date(end.getTime() + 86400000);
    console.log(`  Date field "${k}": row range ${min.toISOString().slice(0, 10)} to ${max.toISOString().slice(0, 10)} (requested ${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}) — ${inRange ? 'consistent with a real period report' : 'OUTSIDE requested window — treat this report as suspect/snapshot-like'}`);
  }
}

// ---------- Credits: GeneralJournalEntries "Credits Issued", excl. bad-debt-writeoff notes, split SS via unit join ----------
async function creditsFor(start, end, label, unitTypes) {
  const { rows } = await callReport('GeneralJournalEntries', site, start, end);
  console.log(`\n--- ${label}: GeneralJournalEntries — ${rows.length} row(s) total ---`);
  if (!rows.length) return { raw: 0, excl: 0, rawSS: 0, exclSS: 0, ssMode: 'none' };
  dateRangeCheck(rows, start, end);
  const allKeys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
  const cols = [...allKeys];
  console.log(`Columns: ${cols.join(', ')}`);
  const creditsRows = rows.filter((r) => str(r.Description) === 'Credits Issued');
  console.log(`"Credits Issued" rows: ${creditsRows.length}`);
  if (!creditsRows.length) return { raw: 0, excl: 0, rawSS: 0, exclSS: 0, ssMode: 'none' };

  const idLike = /id$|^i[A-Z]|count|num$/i;
  const amountCandidates = cols.filter((k) => {
    if (idLike.test(k)) return false;
    const vals = rows.map((r) => r[k]).filter((v) => v !== undefined && v !== null && v !== '');
    if (!vals.length) return false;
    const numeric = vals.filter((v) => String(v).trim() !== '' && !Number.isNaN(Number(String(v).replace(/[£,%\s]/g, ''))));
    return numeric.length / vals.length > 0.8;
  });
  console.log(`Amount-candidate columns: ${amountCandidates.join(', ') || '(none)'}`);
  for (const col of amountCandidates) console.log(`  Σ ${col} (Credits Issued only) = £${R2(creditsRows.reduce((a, r) => a + num(r[col]), 0))}`);
  const bestCol = amountCandidates.reduce((best, col) => {
    const total = Math.abs(creditsRows.reduce((a, r) => a + num(r[col]), 0));
    return (!best || total > best.total) ? { col, total } : best;
  }, null);

  const noteCandidates = cols.filter((k) => k !== 'Description' && !amountCandidates.includes(k) && rows.some((r) => r[k] !== undefined && r[k] !== null && r[k] !== ''));
  const badDebtPattern = /rent.{0,3}:?\s*write.{0,3}off.{0,3}bad.{0,3}debt|write.{0,3}off.{0,3}bad.{0,3}debt|bad.{0,3}debt/i;
  const badDebtRows = creditsRows.filter((r) => noteCandidates.some((col) => badDebtPattern.test(str(r[col]))));
  console.log(`Rows matching bad-debt-writeoff pattern in any string column: ${badDebtRows.length} of ${creditsRows.length}`);
  if (badDebtRows.length) { console.log('Matched rows:'); badDebtRows.forEach((r) => console.log('   ', JSON.stringify(r))); }

  // Attempt a real unit-level join for the SS split.
  const unitField = cols.find((k) => /unit/i.test(k) && !amountCandidates.includes(k));
  let ssMode = 'approx', hitRate = 0;
  const rowsWithType = creditsRows.map((r) => {
    if (unitField) {
      const t = unitTypes[str(r[unitField])];
      return { r, ss: t ? isSS(t) : null };
    }
    return { r, ss: null };
  });
  if (unitField) {
    const known = rowsWithType.filter((x) => x.ss !== null);
    hitRate = creditsRows.length ? known.length / creditsRows.length : 0;
    if (hitRate > 0.9) ssMode = 'joined';
    console.log(`Unit-level field found on GJE: "${unitField}" — join hit rate against RentRoll units: ${(hitRate * 100).toFixed(0)}%`);
  } else {
    console.log('No unit-level field found on GeneralJournalEntries — SS split cannot be joined directly.');
  }

  const sumCol = (predicate) => bestCol ? Math.abs(creditsRows.filter(predicate).reduce((a, r) => a + num(r[bestCol.col]), 0)) : 0;
  const isExcl = (r) => !badDebtRows.includes(r);
  const raw = sumCol(() => true);
  const excl = sumCol(isExcl);
  let rawSS, exclSS;
  if (ssMode === 'joined') {
    const ssSet = new Set(rowsWithType.filter((x) => x.ss === true).map((x) => x.r));
    rawSS = sumCol((r) => ssSet.has(r));
    exclSS = sumCol((r) => ssSet.has(r) && isExcl(r));
  } else {
    // area-weighted approximation, computed by the caller (needs occArea/occAreaSS) — return raw/excl
    // totals only here, caller applies the weighting and labels it [approx].
    rawSS = null; exclSS = null;
  }
  console.log(`Using column "${bestCol ? bestCol.col : '(none found)'}" — raw £${R2(raw)}, excl. bad-debt £${R2(excl)}${ssMode === 'joined' ? `, SS raw £${R2(rawSS)}, SS excl £${R2(exclSS)}` : ' (SS split: approx, see below)'}`);
  return { raw: R2(raw), excl: R2(excl), rawSS, exclSS, ssMode };
}

// ---------- Discounts: Mgmt_Discounts, excl. Non-Expiring plans, split SS via unit join ----------
async function discountsFor(start, end, label, unitTypes) {
  const { rows } = await callReport('Discounts', site, start, end);
  console.log(`\n--- ${label}: Discounts — ${rows.length} row(s) total ---`);
  if (!rows.length) return { raw: 0, excl: 0, rawSS: 0, exclSS: 0, ssMode: 'none' };
  dateRangeCheck(rows, start, end);
  const allKeys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
  console.log(`Columns: ${[...allKeys].join(', ')}`);

  const hits = rows.filter((r) => str(r.sUnitName) && unitTypes[str(r.sUnitName)]).length;
  const hitRate = rows.length ? hits / rows.length : 0;
  const ssMode = hitRate > 0.9 ? 'joined' : 'approx';
  console.log(`Join hit rate (Discounts.sUnitName -> RentRoll unit): ${(hitRate * 100).toFixed(0)}% — SS split mode: ${ssMode}`);

  const byPlan = {};
  let raw = 0, excl = 0, rawSS = 0, exclSS = 0;
  for (const r of rows) {
    const plan = normalizeDiscountPlan(r.sConcessionPlan);
    const isNonExpiring = /non-expiring/i.test(plan);
    const amt = num(r.dcDiscount);
    const t = unitTypes[str(r.sUnitName)];
    const ss = t ? isSS(t) : false;
    (byPlan[plan] ??= { sum: 0, units: new Set(), nonExpiring: isNonExpiring }).sum += amt;
    byPlan[plan].units.add(str(r.sUnitName));
    raw += amt; if (!isNonExpiring) excl += amt;
    if (ss) { rawSS += amt; if (!isNonExpiring) exclSS += amt; }
  }
  console.log('Per-plan breakdown:');
  for (const [plan, p] of Object.entries(byPlan)) {
    console.log(`  ${plan}: £${R2(p.sum)} (${p.units.size} units) ${p.nonExpiring ? '[EXCLUDED - Non-Expiring]' : '[included - time-limited]'}`);
  }
  console.log(`Raw total (all plans): £${R2(raw)}   Excl. Non-Expiring: £${R2(excl)}`);
  if (ssMode === 'joined') console.log(`SS raw: £${R2(rawSS)}   SS excl. Non-Expiring: £${R2(exclSS)}`);
  return { raw: R2(raw), excl: R2(excl), rawSS: ssMode === 'joined' ? R2(rawSS) : null, exclSS: ssMode === 'joined' ? R2(exclSS) : null, ssMode };
}

// ---------- Runner per month ----------
async function runMonth(label, rrRows, factorForRow, creditsStart, creditsEnd, discStart, discEnd, ssTarget, totalTarget) {
  console.log(`\n${'='.repeat(74)}\n${label}\n${'='.repeat(74)}`);
  const unitTypes = unitTypeMap(rrRows);
  const rrSummary = summarizeRentRoll(rrRows, factorForRow);
  console.log(`RentRoll: occArea=${rrSummary.occArea} totalArea=${rrSummary.totalArea} occAreaSS=${rrSummary.occAreaSS} totalAreaSS=${rrSummary.totalAreaSS}`);
  console.log(`  adjRent(billing-adjusted)=£${rrSummary.adjRent}  adjRentSS=£${rrSummary.adjRentSS}  plainRent(unadjusted dcRent)=£${rrSummary.plainRent}  plainRentSS=£${rrSummary.plainRentSS}`);

  const credits = await creditsFor(creditsStart, creditsEnd, label, unitTypes);
  const discounts = await discountsFor(discStart, discEnd, label, unitTypes);

  // Area-weighted approximation for any SS split that couldn't be joined directly (never treated as exact).
  const areaWeightOcc = rrSummary.occArea ? rrSummary.occAreaSS / rrSummary.occArea : 0;
  const creditsSS = { raw: credits.ssMode === 'joined' ? credits.rawSS : R2(credits.raw * areaWeightOcc), excl: credits.ssMode === 'joined' ? credits.exclSS : R2(credits.excl * areaWeightOcc) };
  const discountsSS = { raw: discounts.ssMode === 'joined' ? discounts.rawSS : R2(discounts.raw * areaWeightOcc), excl: discounts.ssMode === 'joined' ? discounts.exclSS : R2(discounts.excl * areaWeightOcc) };
  const ssIsExact = credits.ssMode === 'joined' && discounts.ssMode === 'joined';
  console.log(`\nSS split basis: credits=${credits.ssMode} discounts=${discounts.ssMode} -> SS results below are ${ssIsExact ? 'REAL (joined)' : 'APPROX (area-weighted where not joined) — do not treat SS gaps as decisive unless both are "joined"'}`);

  console.log(`\n${label} — Effective Rent candidates & Real Rate results (target SS £${ssTarget}, Total £${totalTarget}):`);
  for (const rentLabel of ['adjRent', 'plainRent']) {
    const rentTotal = rrSummary[rentLabel], rentSS = rrSummary[rentLabel + 'SS'];
    for (const creditVariant of ['raw', 'excl']) {
      for (const discVariant of ['raw', 'excl']) {
        const effTotal = rentTotal - credits[creditVariant] - discounts[discVariant];
        const effSS = rentSS - creditsSS[creditVariant] - discountsSS[discVariant];
        for (const areaLabel of ['occArea', 'totalArea']) {
          const areaTotal = rrSummary[areaLabel], areaSS = rrSummary[areaLabel + 'SS'];
          const rTotal = areaTotal ? R2(effTotal / areaTotal * 12) : 0;
          const rSS = areaSS ? R2(effSS / areaSS * 12) : 0;
          const gapTotal = R2(rTotal - totalTarget), gapSS = R2(rSS - ssTarget);
          const totalExact = Math.abs(gapTotal) < 0.005;
          const ssExact = Math.abs(gapSS) < 0.005 && ssIsExact;
          const flag = totalExact && ssExact ? '   <<< EXACT MATCH BOTH' : totalExact ? '   <<< TOTAL EXACT (SS not confirmed-exact — see SS split basis above)' : '';
          console.log(`  rent=${rentLabel} credits=${creditVariant} discounts=${discVariant} area=${areaLabel}: Total=£${rTotal} (gap ${gapTotal}) SS=£${rSS} (gap ${gapSS})${flag}`);
        }
      }
    }
  }
}

// ================= JULY (live, current month) =================
const now = new Date();
const julStart = new Date(now.getFullYear(), now.getMonth(), 1);
const { rows: julyRRRows } = await callReport('RentRoll', site, julStart, now);
const julyBFField = scanBillingFreqField(julyRRRows, 'July (live RentRoll)');
let julyFactorForRow;
if (julyBFField) {
  julyFactorForRow = (r) => (/28/.test(str(r[julyBFField])) ? 1.0833 : 1);
} else {
  console.log('\nNo direct billing-frequency field on live RentRoll — falling back to the existing "Custom\\Billing Frequency" report (999824) join for July, same as current production.');
  const { rows: bfRows } = await callCustomReport(999824, site, julStart, now);
  const byLedger = {};
  for (const r of bfRows) { const id = str(r.LedgerID); if (id) byLedger[id] = str(r.sBillingFreqDesc); }
  julyFactorForRow = (r) => { const freq = byLedger[str(r.LedgerID)]; return freq && /28/.test(freq) ? 1.0833 : 1; };
}
await runMonth('JULY 2026 (live)', julyRRRows, julyFactorForRow, julStart, now, julStart, now, targets.julySS, targets.julyTotal);

// ================= JUNE (frozen area/rent from Supabase, live Credits/Discounts queries) =================
const { data: juneRows, error: juneErr } = await admin.from('raw_report').select('raw_response').eq('site_code', site).eq('month', '2026-06-01').eq('report', 'rent_roll').limit(1);
if (juneErr) { console.error('Supabase error (June rent_roll):', juneErr.message); }
else if (!juneRows || !juneRows.length || !juneRows[0].raw_response) { console.log('\nNo frozen June rent_roll found in Supabase — skipping June entirely.'); }
else {
  const juneRRRows = extractRows(juneRows[0].raw_response);
  const juneBFField = scanBillingFreqField(juneRRRows, 'June (frozen RentRoll from Supabase)');
  const juneFactorForRow = juneBFField
    ? (r) => (/28/.test(str(r[juneBFField])) ? 1.0833 : 1)
    : (() => { console.log('\nNo billing-frequency field on frozen June RentRoll either, and the custom report (999824) has no June history — June\'s adjRent will equal plainRent (unadjusted) below. If Rate itself is later confirmed non-exact for June, THIS is why.'); return () => 1; })();
  const juneStart = new Date(2026, 5, 1), juneEnd = new Date(2026, 6, 0);
  await runMonth('JUNE 2026 (closed)', juneRRRows, juneFactorForRow, juneStart, juneEnd, juneStart, juneEnd, targets.juneSS, targets.juneTotal);
}

console.log(`\n${'='.repeat(74)}\nLook for "<<< EXACT MATCH BOTH" above. If the SAME rent/credits/discounts/\narea combination hits it in BOTH June and July, that's the real, cross-\nvalidated formula — safe to wire. "TOTAL EXACT" (without SS confirmed) is\nstill a strong signal if it recurs on the same combination in both months —\nit means the SS split (not the core formula) is the remaining gap. If\nnothing is flagged at all, the full breakdown above (RentRoll columns, GJE\ncolumns/rows, Discounts per-plan sums, date-range sanity checks) should\nshow exactly what's off.\n${'='.repeat(74)}`);
process.exit(0);
