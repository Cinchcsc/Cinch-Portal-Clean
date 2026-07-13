// period_days=30 rules out a too-wide date range. But raw_response IS stored for June's true_revenue
// rows (confirmed 2026-07-08 pulled_at) -- meaning the actual SOAP response behind the ~3x inflated
// number can be inspected directly, no live SiteLink call needed. This reads that stored raw_response
// back, finds every table in it (same logic as probe-truerevenue-coverage.js's Check #1, but against
// what's ALREADY STORED for June rather than a fresh live pull), and checks the kept table for
// literal duplicate rows (same tenant+unit+charge+period appearing more than once) -- if each real
// charge line is sitting in there 3 times, that would fully explain a ~3x inflation baked directly
// into the persisted data, independent of anything buildPayload.js does at read time.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-stored-truerevenue-raw.js [SITE] [YYYY-MM]
// Example: node --env-file=.env scripts/check-stored-truerevenue-raw.js L001 2026-06
import { admin } from '../lib/supabaseAdmin.js';

const site = process.argv[2] || 'L001';
const monthArg = process.argv[3] || '2026-06';
const month = monthArg + '-01';

function findAllTables(result) {
  let diff = null;
  (function find(node) {
    if (!node || typeof node !== 'object' || diff) return;
    for (const [k, v] of Object.entries(node)) {
      if (diff) return;
      if (/diffgram/i.test(k) && v && typeof v === 'object') { diff = v; return; }
      if (v && typeof v === 'object') find(v);
    }
  })(result);
  const tables = [];
  (function walk(node, path) {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
        tables.push({ path: `${path}.${k}`, name: k, count: v.length, rows: v });
      } else if (v && typeof v === 'object') walk(v, `${path}.${k}`);
    }
  })(diff || result, 'root');
  return tables;
}

const num = (r, field) => { const n = Number(String(r[field] ?? 0).replace(/[£,%\s]/g, '')); return Number.isNaN(n) ? 0 : n; };

const { data, error } = await admin
  .from('raw_report').select('data,raw_response,pulled_at').eq('report', 'true_revenue').eq('site_code', site).eq('month', month).maybeSingle();
if (error) { console.log('read error:', error.message); process.exit(1); }
if (!data?.raw_response) { console.log(`${site} ${month}: no stored raw_response.`); process.exit(0); }

console.log(`${site} ${month} — pulled_at=${data.pulled_at}\n`);

const tables = findAllTables(data.raw_response);
console.log(`Found ${tables.length} table(s) in the stored raw_response:\n`);
for (const t of tables) {
  const sum = t.rows.reduce((a, r) => a + num(r, 'TruePeriod'), 0);
  console.log(`  ${t.name} (${t.count} rows): TruePeriod sum = ${sum.toFixed(2)}`);
}

// Which table does the CURRENT stored `data` (the parsed output) match? Compare the parsed sum to
// each table's sum, so we know which raw table was actually consumed to produce the number we're
// questioning.
let dParsed = data.data;
if (typeof dParsed === 'string') { try { dParsed = JSON.parse(dParsed); } catch {} }
const parsedSum = (dParsed?.by_type || []).reduce((a, r) => a + (r.truePeriod || 0), 0);
console.log(`\nParsed/stored 'data' truePeriod sum: ${parsedSum.toFixed(2)}`);
const matching = tables.find((t) => Math.abs(t.rows.reduce((a, r) => a + num(r, 'TruePeriod'), 0) - parsedSum) < 1);
console.log(matching ? `Matches table: ${matching.name} (${matching.count} rows) -- confirms which raw table extractRows() actually picked for this row.` : 'Does not closely match ANY single table sum -- something else is going on (possibly a concatenation of tables, or the parser math itself).');

// Duplicate-row check on the biggest (per-transaction detail) table specifically, since that's the
// one most likely to be extractRows()'s pick and the one #180's hypothesis was about.
const biggest = tables.reduce((a, t) => (t.count > (a?.count || 0) ? t : a), null);
if (biggest) {
  const candidateFields = ['Unit', 'Tenant', 'ChargeDesc', 'ChargeStart', 'ChargeEnd', 'Amount', 'Date'];
  const presentFields = candidateFields.filter((f) => biggest.rows[0][f] !== undefined);
  console.log(`\n--- Duplicate check on '${biggest.name}' (${biggest.count} rows), key fields: ${presentFields.join(', ') || '(none matched)'} ---`);
  if (presentFields.length) {
    const counts = new Map();
    for (const r of biggest.rows) {
      const k = presentFields.map((f) => String(r[f])).join('|');
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const dupeKeys = [...counts.entries()].filter(([, c]) => c > 1);
    console.log(`Distinct keys: ${counts.size} / ${biggest.count} rows. Keys appearing more than once: ${dupeKeys.length}`);
    if (dupeKeys.length) {
      console.log('Sample duplicate keys (first 5):');
      for (const [k, c] of dupeKeys.slice(0, 5)) console.log(`  [${c}x] ${k}`);
      const seen = new Set(); let dedupSum = 0;
      for (const r of biggest.rows) {
        const k = presentFields.map((f) => String(r[f])).join('|');
        if (!seen.has(k)) { seen.add(k); dedupSum += num(r, 'TruePeriod'); }
      }
      const rawSum = biggest.rows.reduce((a, r) => a + num(r, 'TruePeriod'), 0);
      console.log(`Raw sum: ${rawSum.toFixed(2)}, de-duplicated sum: ${dedupSum.toFixed(2)}, difference: ${(rawSum - dedupSum).toFixed(2)}`);
    } else {
      console.log('No duplicate keys -- each row is genuinely distinct. The inflation is NOT simple row duplication.');
    }
  }
}
process.exit(0);
