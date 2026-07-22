// PROBE (22 Jul 2026), task #308/#403 — Michael: "needs to be exact... near is unacceptable." The
// wired-verify probe just showed the LIVE Real Rate formula (Σ true_revenue by_type[].truePeriod ÷
// total area × 12) at £20.33 vs legacy £18.66 -- an 8.95% gap, not exact. Re-reading reportMap.js's
// true_revenue parser (CorpReportID 781861) closely: it groups the SAME underlying per-(ChargeDesc,
// UnitType)-combination rows TWO ways -- `by_type` (grouped by UnitType, SUMMING ACROSS EVERY
// ChargeDesc -- Rent, Insurance, Late Fee, StoreProtect, Combi Padlock, Insufficient Notice Fee,
// Extended Hours Access, Bin Charge, Merchandise, everything) and `by_desc` (grouped by ChargeDesc).
// buildPayload.js's realRate numerator sums `by_type[].truePeriod` -- i.e. it is Rent BLENDED WITH
// EVERY OTHER CHARGE CATEGORY, not rent alone. "Real Rate" is conceptually a £/sqft RENT metric --
// Insurance premiums, late fees and merchandise sales riding along in the same numerator would inflate
// it above the true rent figure by exactly the size of those other categories, which is a highly
// plausible candidate for the current £1.67-£3,467 gap (this site's own Insurance Roll/Ancillaries
// revenue is known to be non-trivial from elsewhere in this portal).
//
// This tests that directly: pulls the SAME raw per-(ChargeDesc,UnitType) rows the production parser
// uses (extractNamedTable(raw, 'Table1'), exactly as reportMap.js's true_revenue parser does — not a
// new report/SOAP method, just reading the same already-fetched data differently), then computes Real
// Rate using ONLY rows where ChargeDesc is 'Rent' (case-insensitive, matching the established
// convention from task #195), both Total (all unit types) and Self Storage (unit type filter combined
// with the Rent filter, which by_type/by_desc alone can't do since each only groups by ONE field).
//
// Run:  node --env-file=.env scripts/probe-truerevenue-rentonly.js [siteCode]
import { callCustomReport, extractNamedTable } from '../lib/sitelink.js';
import { pullReport } from '../lib/reportMap.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-truerevenue-rentonly.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const isSS = (t) => /self.?storage/i.test(t || '');
const legacy = 18.66;

console.log(`Site: ${site}   (local calendar month start used for the actual SiteLink query, regardless of what any UTC-based log label shows)\n`);

// Raw per-(ChargeDesc, UnitType) combination rows -- SAME extraction reportMap.js's true_revenue
// parser uses internally (Table1, confirmed 15 Jul 2026 as the correct 36-row per-combination table,
// not Table2's 1853+ day-prorated lines).
const { raw } = await callCustomReport(781861, site, start, now);
const trRows = extractNamedTable(raw, 'Table1');
console.log(`Table1: ${trRows.length} (ChargeDesc, UnitType) combination row(s).\n`);

console.log('All rows (ChargeDesc | UnitType | TruePeriod):');
for (const r of trRows) console.log(`  ${r.ChargeDesc} | ${r.UnitType} | ${num(r.TruePeriod)}`);

const rentRows = trRows.filter((r) => /rent/i.test(r.ChargeDesc || ''));
console.log(`\n${rentRows.length} row(s) matched ChargeDesc=/rent/i:`);
for (const r of rentRows) console.log(`  ${r.ChargeDesc} | ${r.UnitType} | TruePeriod=${num(r.TruePeriod)}`);

const rentOnlyTotal = rentRows.reduce((a, r) => a + num(r.TruePeriod), 0);
const rentOnlySS = rentRows.filter((r) => isSS(r.UnitType)).reduce((a, r) => a + num(r.TruePeriod), 0);

// Pull rent_roll through the same production path for the area denominators.
const { data: rr } = await pullReport('rent_roll', site, start, now);
const totalArea = rr.total_area_all_units || 0;
const ssArea = (rr.self_storage && rr.self_storage.total_area_all_units) || 0;

const rateOf = (numer, area) => area ? R2(numer / area * 12) : 0;
const rentOnlyRate = rateOf(rentOnlyTotal, totalArea);
const rentOnlySSRate = rateOf(rentOnlySS, ssArea);

console.log(`\n${'='.repeat(70)}`);
console.log(`Σ TruePeriod, ChargeDesc=Rent only, ALL unit types:  £${R2(rentOnlyTotal)}   totalArea=${totalArea}`);
console.log(`Σ TruePeriod, ChargeDesc=Rent only, Self Storage:    £${R2(rentOnlySS)}   ssArea=${ssArea}\n`);
console.log(`Real Rate (Rent-only numerator), Total:        £${rentOnlyRate}/sqft/yr`);
console.log(`Real Rate (Rent-only numerator), Self Storage: £${rentOnlySSRate}/sqft/yr\n`);
console.log(`Legacy target (Total): £${legacy}`);
console.log(`Gap: £${R2(rentOnlyRate - legacy)}  (${R2((rentOnlyRate - legacy) / legacy * 100)}%)`);
console.log(`\n${Math.abs(rentOnlyRate - legacy) < 0.005 ? '*** EXACT MATCH ***' : 'Not exact — do not wire yet.'}`);
process.exit(0);
