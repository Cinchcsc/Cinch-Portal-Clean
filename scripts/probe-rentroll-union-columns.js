// PROBE (22 Jul 2026), task #308. Follow-up to probe-rentroll-full-dump.js: that script's "ALL 75
// COLUMN NAMES" list was Object.keys(rows[0]) only -- but its own row #2 and #3 output already prove
// that's incomplete. Row 2 has CreditCardID and dcPushRateAtMoveIn; row 3 has dcChargeBalance; NONE
// of those three are in row 1, so none of them were in the "75 columns" list either. SOAP/ADO.NET
// diffgrams can omit a field entirely on rows where it doesn't apply, rather than padding every row
// with the same fixed set of keys. That means the real RentRoll schema is bigger than any one row
// shows, and a billing-frequency field could be sitting on some subset of rows only.
//
// This takes the UNION of every key across ALL rows (not just the first one), diffs it against the
// row[0]-only list, and reports distinct-value counts for anything new -- so nothing sparse gets
// missed the way it did last time.
//
// Run:  node --env-file=.env scripts/probe-rentroll-union-columns.js [siteCode]
import { callReport } from '../lib/sitelink.js';

const need = ['SITELINK_WSDL', 'SITELINK_CORP_CODE', 'SITELINK_CORP_USER', 'SITELINK_CORP_PASSWORD', 'SITELINK_LICENSE_KEY'];
const miss = need.filter((k) => !process.env[k]);
if (miss.length) { console.error('Missing env:', miss.join(', ')); process.exit(1); }

const site = process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
if (!site) { console.error('Usage: node --env-file=.env scripts/probe-rentroll-union-columns.js <siteCode>'); process.exit(1); }

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? '').trim());

console.log(`Site: ${site}   Month: ${start.toISOString().slice(0, 7)}`);
const { rows } = await callReport('RentRoll', site, start, now);
console.log(`${rows.length} total rows.\n`);

const firstRowCols = new Set(rows[0] ? Object.keys(rows[0]) : []);

// Union of every key across every row, plus which rows actually carry each key.
const unionCounts = new Map(); // key -> count of rows that have it (non-undefined)
for (const r of rows) {
  for (const k of Object.keys(r)) {
    unionCounts.set(k, (unionCounts.get(k) || 0) + 1);
  }
}

const allKeys = [...unionCounts.keys()].sort();
console.log(`=== UNION across all ${rows.length} rows: ${allKeys.length} distinct keys (vs ${firstRowCols.size} from row[0] alone) ===`);
for (const k of allKeys) {
  const n = unionCounts.get(k);
  const isNew = !firstRowCols.has(k) ? '  <-- NOT in row[0], only appears on some rows' : '';
  console.log(`  ${k}: present on ${n}/${rows.length} rows${isNew}`);
}

const newKeys = allKeys.filter((k) => !firstRowCols.has(k));
console.log(`\n${newKeys.length} key(s) exist somewhere in the data but were invisible in a row[0]-only column dump.`);

const occ = rows.filter((r) => yes(r.bRented));
if (newKeys.length) {
  console.log('\n=== Distinct values + sample rows for each newly-found key (occupied rows only) ===');
  for (const k of newKeys) {
    const withVal = occ.filter((r) => r[k] !== undefined);
    const vals = new Set(withVal.map((r) => String(r[k] ?? '(blank)')));
    console.log(`\n${k}: present on ${withVal.length}/${occ.length} occupied rows, ${vals.size} distinct value(s)`);
    if (vals.size <= 12) console.log(`  values: [${[...vals].join(', ')}]`);
    for (const r of withVal.slice(0, 3)) {
      console.log(`  e.g. ${r.sUnitName} (TenantID ${r.TenantID}): ${k}=${r[k]}`);
    }
  }
} else {
  console.log('\nNo new keys found beyond row[0] -- the 75-column list really was the full schema.');
}

// Sanity check on iAutoBillType while we're here: is the split consistent with "autopay enrollment"
// (expect a large majority) or something closer to a small minority (which would read more like a
// specific billing-plan flag)?
const abtDist = {};
for (const r of occ) { const v = String(r.iAutoBillType ?? '(blank)'); abtDist[v] = (abtDist[v] || 0) + 1; }
console.log('\n=== iAutoBillType split (occupied rows), sanity check on the autopay-vs-frequency reading ===');
console.log(JSON.stringify(abtDist));
process.exit(0);
