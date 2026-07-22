// PROBE (22 Jul 2026), task #308/#403. Michael: "search for credits somewhere" -- Real Rate still
// can't be completed without a Credits (R6's "Fin_CreditsIssued") source. GeneralJournalEntries was
// already pulled once during the exhaustive billing-frequency sweep (probe-exhaustive-billing-search-
// v2.js, 54 rows at whichever site that ran against) but never followed up on -- its `Description`
// field takes exactly one of 4 values: [Income, Credits Issued, Refunds Paid, NSF]. "Credits Issued" is
// an extremely close linguistic match to "Fin_CreditsIssued," so this is the top lead.
//
// This does NOT assume any field name beyond Description (already confirmed). It dumps the true
// union-of-all-rows column list (not just rows[0] -- see the RentRoll/dcPushRateAtMoveIn bug this
// session, the whole reason the exhaustive sweep got rewritten as v2) and prints every row so the real
// amount/date/tenant-reference/note-field shape can be read directly rather than guessed at.
//
// Also specifically checks for any note/memo/reason-type field on "Credits Issued" rows, in case some
// of them are actually bad-debt write-offs mislabeled/co-mingled under the same Description bucket
// (which would need excluding from a true customer-facing "credit" figure) -- print whatever such
// field's value distribution looks like so that can be judged from real data, not assumed.
//
// Sums whatever numeric field(s) look like an amount, for ALL FOUR Description buckets (not just
// Credits Issued) for context, and specifically flags the Credits Issued total against the already-
// quantified ~£12k/month gap at Bicester between partial Real Rate (adjusted rent minus discounts
// only, no Credits) and legacy's true Real Rate.
//
// Run:  node --env-file=.env scripts/probe-generaljournal-credits.js [siteCode]
import { callReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-generaljournal-credits.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const num = (v) => { const n = Number(String(v ?? '').replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? null : n; };
const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

console.log(`Site: ${site}   Date range: ${start.toISOString()} to ${now.toISOString()} (${start.toISOString().slice(0, 7)})\n`);

const { rows } = await callReport('GeneralJournalEntries', site, start, now);
console.log(`GeneralJournalEntries: ${rows.length} row(s) total.\n`);
if (!rows.length) { console.log('No rows -- nothing more to check here.'); process.exit(0); }

// True union of columns across ALL rows, not just rows[0].
const allKeys = new Set();
for (const r of rows) for (const k of Object.keys(r)) allKeys.add(k);
const cols = [...allKeys];
console.log(`Columns (union across all ${rows.length} rows): ${cols.join(', ')}\n`);

// Description distribution.
const byDesc = {};
for (const r of rows) {
  const d = String(r.Description ?? '(blank)');
  (byDesc[d] ??= []).push(r);
}
console.log('Description value distribution:', JSON.stringify(Object.fromEntries(Object.entries(byDesc).map(([k, v]) => [k, v.length]))), '\n');

// Candidate amount columns: any column whose values, across the WHOLE report, mostly parse as numbers
// and aren't an obviously non-monetary ID/count column.
const idLike = /id$|^i[A-Z]|count|num$/i;
const amountCandidates = cols.filter((k) => {
  if (idLike.test(k)) return false;
  const vals = rows.map((r) => r[k]).filter((v) => v !== undefined && v !== null && v !== '');
  if (!vals.length) return false;
  const numeric = vals.filter((v) => num(v) !== null);
  return numeric.length / vals.length > 0.8;
});
console.log(`Candidate amount-like columns (>80% numeric-parseable, not ID-shaped): ${amountCandidates.join(', ') || '(none found)'}\n`);

// Candidate note/reason/memo columns: string-typed, not already an amount candidate, not Description
// itself, with enough distinct values to plausibly carry free text or a sub-category (unlike the
// 4-value Description field).
const noteCandidates = cols.filter((k) => {
  if (k === 'Description' || amountCandidates.includes(k)) return false;
  const vals = rows.map((r) => r[k]).filter((v) => v !== undefined && v !== null && v !== '');
  if (!vals.length) return false;
  const allString = vals.every((v) => typeof v === 'string' || Number.isNaN(Number(v)));
  return allString;
});
console.log(`Candidate note/reference/other string columns: ${noteCandidates.join(', ') || '(none found)'}\n`);

// Sum every amount candidate, per Description bucket.
console.log('=== Per-Description sums, for each amount-candidate column ===');
for (const [desc, drows] of Object.entries(byDesc)) {
  console.log(`\n[${desc}] (${drows.length} rows)`);
  for (const col of amountCandidates) {
    const total = drows.reduce((a, r) => a + (num(r[col]) || 0), 0);
    console.log(`  Σ ${col} = ${R2(total)}`);
  }
}

// If any note-like column exists, show its distribution specifically WITHIN "Credits Issued" rows --
// looking for anything resembling a bad-debt/write-off sub-reason that might need excluding.
const creditsRows = byDesc['Credits Issued'] || [];
if (creditsRows.length && noteCandidates.length) {
  console.log(`\n=== "Credits Issued" rows (${creditsRows.length}) -- note/reference column distributions ===`);
  for (const col of noteCandidates) {
    const dist = {};
    for (const r of creditsRows) { const v = String(r[col] ?? '(blank)'); dist[v] = (dist[v] || 0) + 1; }
    console.log(`  ${col}:`, JSON.stringify(dist));
  }
  const badDebtLike = creditsRows.filter((r) => noteCandidates.some((col) => /bad.?debt|write.?off/i.test(String(r[col] ?? ''))));
  console.log(`\nRows matching /bad debt|write off/i in any note column: ${badDebtLike.length} of ${creditsRows.length}`);
}

console.log('\n=== Full "Credits Issued" rows (all of them, not just first 10) ===');
creditsRows.forEach((r, i) => console.log(`  ${i + 1}.`, JSON.stringify(r)));

console.log(`\n=== Context: already-quantified Bicester gap (task #308) ===`);
console.log(`Partial Real Rate (adjusted rent minus discounts, no Credits): £28.59 (SS) / £27.39 (Total) per sqft/yr`);
console.log(`Legacy true Real Rate:                                          £19.50 (SS) / £18.66 (Total) per sqft/yr`);
console.log(`Implied missing Credits gap: roughly £12k/month at this one site -- compare that magnitude against`);
console.log(`the Credits Issued sum(s) printed above before trusting this as the source.`);
process.exit(0);
