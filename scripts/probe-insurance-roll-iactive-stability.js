// PROBE (24 Jul 2026, task #426) — follow-up to task #422's Daily Snapshot fix. That fix found
// iInquiryConvertedToLease (InquiryTracking) is VOLATILE: re-querying the exact same already-closed day
// hours apart gave wildly different counts (33 -> 5), because the flag evidently reflects "is this
// CURRENTLY true" rather than a stable historical fact.
//
// insurance_roll's parser (lib/reportMap.js ~line 533-558) has a structurally IDENTICAL shape:
//   if (!yes(r.iActive)) continue;                                    // <- "is this active RIGHT NOW"
//   if (inSourceDayWindow(r.dMovedIn, startDate, endDate)) newCount++; // <- gated by a historical date
// insured_new_customers.count is only counted for policies that are BOTH (a) active right now AND
// (b) moved in during the target period. If a policy is later cancelled, a re-query of the SAME
// already-closed period would lose that customer from the count — exactly the pattern that made
// iInquiryConvertedToLease unsafe. NOT yet confirmed this actually happens in practice; that's what
// this probe is for. Feeds buildPayload.js's `insuredNewCustomers` -> Insurance Conversion gauge +
// Insurance Premiums (New Customers) tiles.
//
// This probe queries InsuranceRoll LIVE for a target month across every site and prints:
//   - insured_units (total active policies right now) — expected to drift over time regardless, that's
//     normal (it's an "as of now" figure by design, not a historical count)
//   - insured_new_customers.count (the part we're testing) for the target month
// alongside a timestamp, so two runs of this script (now, and again later today/tomorrow) can be
// diffed for the SAME target month to see if insured_new_customers.count changes.
//
// Run:  node --env-file=.env scripts/probe-insurance-roll-iactive-stability.js [YYYY-MM]
// Default target month: last full calendar month. Re-run again later (hours or a day apart) with the
// SAME argument and compare insured_new_customers.count per site / portfolio total across the two runs.
//   - Unchanged => the iActive+dMovedIn gate is stable enough for this metric, no fix needed.
//   - Changed (esp. decreasing) => same volatility class as the Snapshot bug; needs a fix analogous to
//     task #422's (find a stable event-dated field instead of the live iActive flag).
import { callReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY', 'SITELINK_LOCATIONS'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const num = (row, ...keys) => {
  for (const k of keys) {
    if (row && row[k] != null && row[k] !== '') {
      const n = Number(String(row[k]).replace(/[£,%\s]/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
};
const dayOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const inSourceDayWindow = (v, start, end) => {
  if (!v) return false;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return false;
  const day = dayOnly(d);
  return day >= dayOnly(start) && day <= dayOnly(end);
};

const locations = process.env.SITELINK_LOCATIONS.split(',').map((s) => s.trim()).filter(Boolean);

function targetMonth(argMonth) {
  if (argMonth) {
    const [y, m] = argMonth.split('-').map(Number);
    return { start: new Date(y, m - 1, 1), end: new Date(y, m, 0) };
  }
  const now = new Date();
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
  return { start: lastMonthStart, end: lastMonthEnd };
}

async function countsForSite(site, start, end) {
  const { rows } = await callReport('InsuranceRoll', site, start, end);
  let insured = 0, newCount = 0, newPremium = 0;
  for (const r of rows) {
    if (!yes(r.iActive)) continue;
    insured++;
    if (inSourceDayWindow(r.dMovedIn, start, end)) { newCount++; newPremium += num(r, 'dcPremium'); }
  }
  return { insured, newCount, newPremium: Math.round(newPremium * 100) / 100, rowCount: rows.length };
}

async function main() {
  const { start, end } = targetMonth(process.argv[2]);
  const monthLabel = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
  console.log(`${'='.repeat(90)}`);
  console.log(`insurance_roll iActive/dMovedIn stability check — target month ${monthLabel} (${start.toDateString()} to ${end.toDateString()})`);
  console.log(`Run timestamp: ${new Date().toISOString()}`);
  console.log(`${'='.repeat(90)}`);
  console.log('site'.padEnd(6), 'insured_units'.padEnd(14), 'new_customers'.padEnd(14), 'new_premium'.padEnd(12));

  let tInsured = 0, tNew = 0, tPrem = 0;
  for (const site of locations) {
    const c = await countsForSite(site, start, end);
    tInsured += c.insured; tNew += c.newCount; tPrem += c.newPremium;
    console.log(site.padEnd(6), String(c.insured).padEnd(14), String(c.newCount).padEnd(14), String(c.newPremium).padEnd(12));
  }

  console.log(`\n${'='.repeat(90)}\nPORTFOLIO TOTALS for ${monthLabel}\n${'='.repeat(90)}`);
  console.log(`insured_units=${tInsured}  insured_new_customers.count=${tNew}  new_premium=£${tPrem}`);
  console.log(`\nSave this output. Re-run with the SAME argument (${process.argv[2] || '(no arg — will re-target "last full month" which may roll forward if run next month; pass an explicit YYYY-MM to be safe)'}) later today, tomorrow, or next week, and compare insured_new_customers.count for ${monthLabel} across runs:`);
  console.log(`  - Same number both times => stable, no fix needed for this metric.`);
  console.log(`  - Lower the second time => same volatility class as the Snapshot bug (task #422) — cancelled/reversed policies dropping out of a "currently active" gate — would need a fix analogous to that one.`);
  process.exit(0);
}

main().catch((e) => { console.error('Probe failed:', e.message); process.exit(1); });
