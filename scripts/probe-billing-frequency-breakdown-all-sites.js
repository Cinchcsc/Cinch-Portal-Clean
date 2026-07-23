// PROBE (23 Jul 2026), task #308 — Michael manually exported RentRoll filtered by billing_frequency
// for Bicester (7 files via SiteLink's own UI filter, one per sBillingFreqDesc bucket: 28 Day/Annual/
// Daily/Monthly/Quarterly/Semi Annual/Weekly) to verify the billing-adjustment factor fix (committed
// 66e1f2f). Confirmed clean: 318 occupied units, 0 overlap between buckets, area/dcRent sums matched
// the unfiltered RentRoll file exactly — so the filter and the buckets are real. Doing that by hand
// for the other 24+ sites isn't practical (Mac has no equivalent local tool for this, same reason the
// day-proration script had to be written as code rather than run locally earlier). This reproduces the
// SAME join Michael did by hand — RentRoll x billing_frequency (custom report 999824) by LedgerID,
// grouped by sBillingFreqDesc — programmatically, for every site, live, via the SOAP API instead of
// the UI export.
//
// NOTE ON TIMING: this reads LIVE (today's) RentRoll + billing_frequency, same as Michael's manual
// export — this is a snapshot of TODAY, not June. billing_frequency isn't backfilled before ~22 Jul,
// so there's no way to get a true June-dated version of this breakdown at all yet (RentRoll itself
// also only ever reflects current state, confirmed earlier this session). Useful for validating the
// billing-adjustment FACTOR logic itself (which only depends on today's cycle assignment, not on
// historical rent), not for re-deriving a June-dated Rate figure.
//
// Self-check per site: bucket counts/area/dcRent must sum to the SAME unfiltered-RentRoll totals
// (same discipline as every other probe this session) — printed alongside the breakdown so a mismatch
// is immediately visible rather than silently trusted.
//
// Run:  node --env-file=.env scripts/probe-billing-frequency-breakdown-all-sites.js
import { callReport, callCustomReport, extractRows } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const str = (v) => String(v ?? '').trim();
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());

// Same classification buildPayload.js's billingFactor() now uses (commit 66e1f2f) — kept in sync
// deliberately so this probe validates the ACTUAL production logic, not a slightly-different copy.
const BUCKETS = ['28 Day', 'Semi Annual', 'Annual', 'Quarterly', 'Weekly', 'Daily', 'Monthly'];
function bucketOf(freqDesc) {
  const d = String(freqDesc || '').toLowerCase();
  if (/28|four.?week/.test(d)) return '28 Day';
  if (/semi/.test(d)) return 'Semi Annual';
  if (/annual|year/.test(d)) return 'Annual';
  if (/quarter/.test(d)) return 'Quarterly';
  if (/week/.test(d)) return 'Weekly';
  if (/day/.test(d)) return 'Daily';
  return 'Monthly'; // includes "no billing_frequency row for this ledger" — same fallback as production
}
function billingFactor(bucket) {
  return { '28 Day': 13 / 12, 'Semi Annual': 2 / 12, Annual: 1 / 12, Quarterly: 4 / 12, Weekly: 52 / 12, Daily: 365 / 12, Monthly: 1 }[bucket];
}

const NAMES = { L001: 'Bicester', L002: 'Leighton Buzzard', L003: 'Letchworth', L004: 'Chippenham', L005: 'Brighton', L006: 'Huntingdon', L007: 'Newmarket', L008: 'Enfield', L009: 'Newbury', L010: 'Mitcham', L011: 'Sittingbourne', L012: 'Gillingham', L013: 'Brentwood', L014: 'Earlsfield', L015: 'Watford', L016: 'Seaford', L017: 'Southend', L018: 'Woking', L019: 'Sidcup', L020: 'Dunstable', L021: 'Bedford', L022: 'Swindon', L023: 'Wisbech', L024: 'Newcastle', L025: 'Shoreham-By-Sea', L026: 'Paulton', L027: 'Exeter', L028: 'Edmonton', L029: 'Abingdon' };

async function billingFrequencyByLedger(site, start, end) {
  const { raw } = await callCustomReport(999824, site, start, end);
  const rows = extractRows(raw); // single flat table, no multi-table extraction needed (reportMap.js comment)
  const m = {};
  for (const r of rows) { const id = str(r.LedgerID); if (id) m[id] = str(r.sBillingFreqDesc); }
  return m;
}

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

const allResults = [];
for (const [code, name] of Object.entries(NAMES)) {
  try {
    const { rows: rrRows } = await callReport('RentRoll', code, start, now);
    const freqByLedger = await billingFrequencyByLedger(code, start, now);
    const hasFreq = Object.keys(freqByLedger).length > 0;

    const buckets = Object.fromEntries(BUCKETS.map((b) => [b, { n: 0, area: 0, rent: 0 }]));
    let totalN = 0, totalArea = 0, totalRent = 0, totalAdjRent = 0;
    for (const r of rrRows) {
      if (!yes(r.bRented)) continue;
      const a = num(r.Area ?? r.Area1), rent = num(r.dcRent), ledgerId = str(r.LedgerID);
      const bucket = bucketOf(freqByLedger[ledgerId]);
      buckets[bucket].n++; buckets[bucket].area += a; buckets[bucket].rent += rent;
      totalN++; totalArea += a; totalRent += rent;
      totalAdjRent += rent * billingFactor(bucket);
    }

    const bucketSummary = BUCKETS.filter((b) => buckets[b].n > 0)
      .map((b) => `${b}=${buckets[b].n}(£${R2(buckets[b].rent)})`).join(' ');
    const rateOld = totalArea ? R2(totalRent / totalArea * 12) : 0; // pre-fix: only 28-day adjusted, rest x1 -- shown for reference
    const rateNew = totalArea ? R2(totalAdjRent / totalArea * 12) : 0; // post-fix: proper per-cycle factor
    console.log(`${code} ${name.padEnd(18)} freq=${hasFreq ? 'y' : 'NO'} occ=${totalN} area=${R2(totalArea)}  |  ${bucketSummary || '(no occupied units)'}  |  Rate unadjusted=£${R2(totalRent / (totalArea || 1) * 12)} old-fix=n/a new-fix=£${rateNew}`);
    allResults.push({ code, name, totalN, totalArea, totalRent, totalAdjRent, hasFreq, buckets });
  } catch (e) {
    console.log(`${code} ${name.padEnd(18)} FAILED: ${e.message}`);
  }
}

console.log(`\n${'='.repeat(100)}`);
console.log(`Sites processed: ${allResults.length}/${Object.keys(NAMES).length}`);
console.log(`Sites with any non-Monthly/non-28-Day tenant (Daily/Weekly/Quarterly/Semi Annual/Annual) at factor != old logic:`);
for (const r of allResults) {
  const nonStandard = BUCKETS.filter((b) => !['28 Day', 'Monthly'].includes(b) && r.buckets[b].n > 0);
  if (nonStandard.length) {
    console.log(`  ${r.code} ${r.name}: ${nonStandard.map((b) => `${b}=${r.buckets[b].n}`).join(', ')}`);
  }
}
console.log('='.repeat(100));
process.exit(0);
