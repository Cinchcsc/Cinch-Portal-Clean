// PROBE (22 Jul 2026), task #308. R6, asked again, says billing frequency IS in RentRoll (no new
// column name given this time -- same claim as before, just reasserted). Every previous check of
// RentRoll in this thread filtered columns through a regex (/bill|freq|cycle|28.?day|weekly|anniv/i)
// looking for an OBVIOUSLY-named column. That regex is a guess about naming -- if the real column is
// called something like sPymtSched, iChargeInterval, sRateCode, PayPeriod, iTermType etc., it would
// never have matched and I'd have walked right past it while still truthfully saying "no bill/freq/
// cycle-named column exists." Task #400 (Edmonton) already taught this exact lesson once: a first
// miss from pattern-matching isn't proof of absence.
//
// This does zero filtering. It dumps literally every column name RentRoll returns, then prints 3 full
// rows (untouched, no field selection) so every value can be read directly instead of guessed at.
//
// Run:  node --env-file=.env scripts/probe-rentroll-full-dump.js [siteCode]
import { callReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-rentroll-full-dump.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());

console.log(`Site: ${site}   Month: ${start.toISOString().slice(0, 7)}`);
const { rows } = await callReport('RentRoll', site, start, now);
console.log(`\n${rows.length} total rows.`);

const cols = rows[0] ? Object.keys(rows[0]) : [];
console.log(`\n=== ALL ${cols.length} COLUMN NAMES, no filtering ===`);
cols.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));

const occ = rows.filter((r) => yes(r.bRented));
console.log(`\n${occ.length} occupied rows.`);

console.log('\n=== FULL untouched row #1 (occupied) ===');
console.log(JSON.stringify(occ[0], null, 2));

console.log('\n=== FULL untouched row #2 (occupied) ===');
console.log(JSON.stringify(occ[1], null, 2));

console.log('\n=== FULL untouched row #3 (occupied) ===');
console.log(JSON.stringify(occ[2], null, 2));

// Also: for every column, show how many DISTINCT values appear across all occupied rows, and list
// them if there are few (<=6) -- a real billing-frequency flag would show a SMALL set of repeating
// values (e.g. "Monthly"/"28 Day"/"Weekly", or 1/2/3), which stands out from free-form numeric fields.
console.log('\n=== Distinct-value counts per column (occupied rows) -- low-cardinality columns are the interesting ones ===');
for (const c of cols) {
  const vals = new Set(occ.map((r) => String(r[c] ?? '(blank)')));
  if (vals.size <= 8) {
    console.log(`  ${c}: ${vals.size} distinct -> [${[...vals].join(', ')}]`);
  }
}
process.exit(0);
