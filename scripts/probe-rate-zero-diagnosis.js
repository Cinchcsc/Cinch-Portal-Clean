// PROBE (27 Jul 2026) — live bug found via Chrome: KPIs page shows Rate per ft² = £0.00 for BOTH
// "Total Store Occupancy" AND "Self Storage" (Offices Rate is fine, £31.03) on the CURRENT month
// ("through Jul 26"), confirmed on 2 different stores (Bicester, Gillingham) with "1 stores" filter,
// and reproduced on the Month-on-Month page's "Self Storage Rate per ft²" chart the same way. Prior
// Month (June, closed) shows correct values (~£30) for the same store/chart — this is isolated to the
// CURRENT in-progress month specifically, not a permanent regression.
//
// Static code read (lib/buildPayload.js recordFor(), lib/reportMap.js's rent_roll/billing_frequency
// parsers) found no bug in the WIRING: self_storage.std_rent_sum/area_sum both exist on the parser's
// return object, unit_rows/isSelfStorageUnit's "self storage" substring match is textually identical
// to reportMap.js's own isSS(), billing_frequency's by_ledger values are plain strings (not objects),
// and the current-month full-detail recordFor() call site (buildPayload(), ~line 1001) DOES pass
// useBillingAdjustedRate=true. Everything checked out on paper — so this can only be pinned down by
// looking at what's ACTUALLY stored right now, which this sandbox has no live DB access to do.
//
// This dumps every intermediate value in the Rate/Self Storage Rate chain for the CURRENT month, for
// a couple of test sites, straight from the STORED raw_report rows (not a fresh SiteLink pull) — so
// the exact break point (stale/pre-schema-change stored data? billing_frequency genuinely empty today?
// something else?) is visible directly, without guessing further.
//
// Run:  node --env-file=.env scripts/probe-rate-zero-diagnosis.js [siteCode1] [siteCode2] ...
import { admin } from '../lib/supabaseAdmin.js';

const sites = process.argv.slice(2).length ? process.argv.slice(2) : ['L001', 'L002'];  // Bicester, Gillingham by default

const now = new Date();
const curMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

const isSelfStorageUnit = (t) => String(t || '').toLowerCase().includes('self storage');
const billingFactor = (freqDesc) => {
  const d = String(freqDesc || '').toLowerCase();
  if (/28|four.?week/.test(d)) return 13 / 12;
  if (/semi/.test(d)) return 2 / 12;
  if (/annual|year/.test(d)) return 1 / 12;
  if (/quarter/.test(d)) return 4 / 12;
  if (/week/.test(d)) return 52 / 12;
  if (/day/.test(d)) return 365 / 12;
  return 1;
};
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

console.log(`Current month key (this machine's clock): ${curMonthKey}\n`);

for (const site of sites) {
  console.log(`\n${'='.repeat(70)}\nSITE: ${site}\n${'='.repeat(70)}`);

  const { data: rrRow, error: rrErr } = await admin
    .from('raw_report').select('id,data,pulled_at')
    .eq('site_code', site).eq('month', curMonthKey).eq('report', 'rent_roll')
    .order('id', { ascending: false }).limit(1).maybeSingle();
  if (rrErr) { console.error('rent_roll fetch error:', rrErr.message); continue; }
  if (!rrRow) { console.log('NO rent_roll row stored for this site/month at all.'); continue; }

  const rr = rrRow.data || {};
  console.log(`rent_roll: id=${rrRow.id}  pulled_at=${rrRow.pulled_at}`);
  console.log(`  top-level: std_rent_sum=${rr.std_rent_sum}  area_sum=${rr.area_sum}  rent_sum=${rr.rent_sum}`);
  console.log(`  self_storage: ${JSON.stringify(rr.self_storage)}`);
  console.log(`  unit_rows present: ${Array.isArray(rr.unit_rows)} (length ${rr.unit_rows ? rr.unit_rows.length : 'n/a'})`);
  const unitRowsForRate = rr.unit_rows || [];
  if (unitRowsForRate.length) {
    const ssRows = unitRowsForRate.filter((u) => isSelfStorageUnit(u.type));
    console.log(`  unit_rows self-storage-matched: ${ssRows.length} / ${unitRowsForRate.length}`);
    console.log(`  sample row: ${JSON.stringify(unitRowsForRate[0])}`);
    console.log(`  sum(rent) all rows: ${R2(unitRowsForRate.reduce((a, u) => a + (u.rent || 0), 0))}`);
    console.log(`  sum(rent) self-storage rows: ${R2(ssRows.reduce((a, u) => a + (u.rent || 0), 0))}`);
  }

  const { data: bfRow, error: bfErr } = await admin
    .from('raw_report').select('id,data,pulled_at')
    .eq('site_code', site).eq('month', curMonthKey).eq('report', 'billing_frequency')
    .order('id', { ascending: false }).limit(1).maybeSingle();
  if (bfErr) console.error('billing_frequency fetch error:', bfErr.message);

  const bfByLedger = (bfRow && bfRow.data && bfRow.data.by_ledger) || {};
  const hasBillingFreq = Object.keys(bfByLedger).length > 0;
  console.log(`\nbilling_frequency: ${bfRow ? `id=${bfRow.id} pulled_at=${bfRow.pulled_at}` : 'NO ROW STORED'}`);
  console.log(`  by_ledger entries: ${Object.keys(bfByLedger).length}  hasBillingFreq=${hasBillingFreq}`);
  if (Object.keys(bfByLedger).length) {
    const sampleKey = Object.keys(bfByLedger)[0];
    console.log(`  sample: ledgerId=${sampleKey} -> "${bfByLedger[sampleKey]}"`);
  }

  const canAdjustRate = hasBillingFreq && unitRowsForRate.length > 0;   // useBillingAdjustedRate is true for the current month's full record
  console.log(`\ncanAdjustRate = ${canAdjustRate}`);

  const billingAdjustedRentSum = (filterFn) => {
    let numer = 0;
    for (const u of unitRowsForRate) {
      if (!filterFn(u)) continue;
      const matched = Object.prototype.hasOwnProperty.call(bfByLedger, u.ledgerId);
      numer += (u.rent || 0) * billingFactor(bfByLedger[u.ledgerId]);
      if (!matched) numer += 0; // no-op, just documents that unmatched ledgers default to factor 1, not 0
    }
    return numer;
  };

  const adjRentSum = canAdjustRate ? R2(billingAdjustedRentSum(() => true)) : (rr.std_rent_sum || 0);
  const ssAdjRentSum = canAdjustRate ? R2(billingAdjustedRentSum((u) => isSelfStorageUnit(u.type))) : ((rr.self_storage && rr.self_storage.std_rent_sum) || 0);
  const rate = (rr.area_sum || 0) ? R2(adjRentSum / rr.area_sum * 12) : 0;
  const ssRate = ((rr.self_storage && rr.self_storage.area_sum) || 0) ? R2(ssAdjRentSum / rr.self_storage.area_sum * 12) : 0;

  console.log(`\nadjRentSum (path actually used: ${canAdjustRate ? 'billing-adjusted' : 'fallback std_rent_sum'}) = ${adjRentSum}`);
  console.log(`ssAdjRentSum (path actually used: ${canAdjustRate ? 'billing-adjusted' : 'fallback self_storage.std_rent_sum'}) = ${ssAdjRentSum}`);
  console.log(`=> Rate = ${rate}   Self Storage Rate = ${ssRate}`);
  console.log(rate === 0 || ssRate === 0
    ? '  *** REPRODUCES THE ZERO — see whichever of the values above is unexpectedly 0/missing. ***'
    : '  Both non-zero here — if the live portal still shows £0.00, the bug is downstream of buildPayload.js (payload staleness, or a page.js read).');
}

process.exit(0);
