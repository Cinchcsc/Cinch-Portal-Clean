// Task #180/#181 — recreated (the original was lost, and its own notes admit it was never
// confirmed to have actually run). True Revenue's parser (lib/reportMap.js true_revenue.parse)
// groups raw rows by ChargeDesc/UnitType and sums blindly with no de-duplication anywhere in the
// path — if the raw SOAP response for custom report 781861 contains the same tenant/unit/charge
// line more than once (pagination overlap, a "biggest table wins" concatenation artifact, or
// genuine SiteLink duplication), the TruePeriod sum feeding Real Rate would be silently inflated,
// which would make our calculated Real Rate too HIGH vs a correct figure -- the OPPOSITE direction
// from what's actually observed (every worst-offender site is LOW vs legacy, never high). This
// script checks anyway since it's cheap and was never actually confirmed either way, and prints
// full sample raw rows first since the exact identity field names on this report have never been
// directly inspected in this codebase.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-truerevenue-duplicates.js <SITE>
// Example: node --env-file=.env scripts/check-truerevenue-duplicates.js L001
import { callCustomReport } from '../lib/sitelink.js';
import { checkPullLock } from '../lib/pullLock.js';

const site = process.argv[2] || 'L001';
const lock = await checkPullLock();
if (lock.locked) { console.error('[check-truerevenue-duplicates] ' + lock.message); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);

const { rows } = await callCustomReport(781861, site, start, now);
console.log(`${site}: ${rows.length} raw True Revenue rows for ${start.toISOString().slice(0, 10)}..${now.toISOString().slice(0, 10)}\n`);

if (!rows.length) { console.log('No rows returned.'); process.exit(0); }

console.log('--- First 3 raw rows, every field (to find the real tenant/unit/charge-period field names) ---');
for (const r of rows.slice(0, 3)) {
  const clean = { ...r }; delete clean.attributes;
  console.log(JSON.stringify(clean, null, 2));
}

// Best-guess identity key: whichever of these fields actually exist on this report's rows.
const candidateFields = ['LedgerID', 'TenantID', 'sTenant', 'TenantName', 'UnitID', 'sUnit', 'UnitName',
  'ChargeDesc', 'ChargeStart', 'ChargeEnd', 'dChargeStart', 'dChargeEnd', 'InvoiceID', 'iInvoiceID'];
const presentFields = candidateFields.filter((f) => rows[0][f] !== undefined);
console.log(`\n--- Fields present for a de-dupe key: ${presentFields.join(', ') || '(none of the guessed names matched -- inspect the raw dump above manually)'} ---\n`);

if (presentFields.length) {
  const keyOf = (r) => presentFields.map((f) => String(r[f])).join('|');
  const counts = new Map();
  for (const r of rows) { const k = keyOf(r); counts.set(k, (counts.get(k) || 0) + 1); }
  const dupeKeys = [...counts.entries()].filter(([, c]) => c > 1);
  console.log(`Distinct keys: ${counts.size} / ${rows.length} rows.`);
  console.log(`Keys appearing MORE THAN ONCE: ${dupeKeys.length}`);
  if (dupeKeys.length) {
    const extraRows = dupeKeys.reduce((a, [, c]) => a + (c - 1), 0);
    console.log(`Total "extra" duplicate rows beyond the first occurrence: ${extraRows} (${((extraRows / rows.length) * 100).toFixed(1)}% of all rows)`);
    console.log('\nSample duplicate keys (first 5):');
    for (const [k, c] of dupeKeys.slice(0, 5)) console.log(`  [${c}x] ${k}`);
  } else {
    console.log('No exact-duplicate keys found using this field set -- duplication hypothesis looks dead for this site, unless the real identity fields differ from the ones guessed above (check the raw dump).');
  }
}

// Also: raw TruePeriod sum (undeduplicated, matching what the real parser currently does) vs a
// de-duplicated sum (keeping only the first occurrence of each key), so the actual £ impact (if
// any) is visible directly rather than just a row count.
const num = (r) => { const n = Number(String(r.TruePeriod ?? 0).replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };
const rawSum = rows.reduce((a, r) => a + num(r), 0);
if (presentFields.length) {
  const seen = new Set();
  let dedupSum = 0;
  for (const r of rows) {
    const k = presentFields.map((f) => String(r[f])).join('|');
    if (!seen.has(k)) { seen.add(k); dedupSum += num(r); }
  }
  console.log(`\nRaw (current) TruePeriod sum: ${rawSum.toFixed(2)}`);
  console.log(`De-duplicated TruePeriod sum: ${dedupSum.toFixed(2)}`);
  console.log(`Difference: ${(rawSum - dedupSum).toFixed(2)} (${rawSum ? (((rawSum - dedupSum) / rawSum) * 100).toFixed(1) : 0}%)`);
}
process.exit(0);
