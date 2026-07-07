// Investigates the ~£3k-6k Debtor Levels gap found comparing our July 2026 dashboard (£28,790 total
// overdue-30+, portfolio-wide) against the legacy portal's Past Due Balances tile (£22,589) — even
// after excluding Bedford/Paulton (sites we track that legacy doesn't), our total only drops to
// £25,673, still £3,084 over legacy's number. Both sides claim the same "30+ days overdue" rule
// (lib/reportMap.js's past_due parser: `d > 30`), so this isn't an obvious definition mismatch.
// This script re-pulls PastDueBalances FRESH from SiteLink for every current site and compares it
// against what's currently stored in raw_report for July, per site — PastDueBalances is a live,
// point-in-time snapshot (not a full-month total like RentRoll), so a gap here could be either:
//   (a) a stale stored pull (July pulled early in the month, balances have moved since), or
//   (b) a real parsing/field difference worth digging into further.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-debtor-gap-july.js
import { admin } from '../lib/supabaseAdmin.js';
import { pullReport } from '../lib/reportMap.js';

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
// FIXED: must cap the end date at TODAY for the current in-progress month, exactly like
// lib/pull.js's endOf() does — PastDueBalances is a live snapshot report, not a historical range
// query, so requesting through the actual end of July (a future date, since today is only 7 Jul)
// returns an inflated/different result than what production actually pulls. First version of this
// script used full-month-end here and got £87,759 fresh vs £28,790 stored — a false alarm caused by
// this exact bug, not a real data problem.
const end = now;
const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

const { data: sites, error: sErr } = await admin.from('sites').select('code,name').order('code');
if (sErr) { console.error(sErr.message); process.exit(1); }

const { data: stored, error: stErr } = await admin.from('raw_report').select('site_code,data').eq('report', 'past_due').eq('month', monthKey);
if (stErr) { console.error(stErr.message); process.exit(1); }
const storedIndex = {}; for (const r of stored || []) storedIndex[r.site_code] = r.data;

console.log(`Comparing STORED vs FRESH PastDueBalances for ${monthKey.slice(0, 7)} across ${sites.length} sites.\n`);
console.log('CODE   NAME                  STORED(30+)   FRESH(30+)   DIFF     STORED_PULLED_AT');
let storedTotal = 0, freshTotal = 0;
for (const s of sites) {
  const storedVal = (storedIndex[s.code] && storedIndex[s.code].total_overdue_30plus) || 0;
  let freshVal = null, err = null;
  try {
    const { data } = await pullReport('past_due', s.code, start, end);
    freshVal = data.total_overdue_30plus || 0;
  } catch (e) { err = e.message; }
  storedTotal += storedVal;
  if (freshVal != null) freshTotal += freshVal;
  const diff = freshVal != null ? freshVal - storedVal : null;
  console.log(
    `${s.code.padEnd(6)} ${s.name.padEnd(21)} £${String(storedVal).padStart(8)}   ` +
    (err ? `ERROR: ${err}` : `£${String(freshVal).padStart(8)}   £${String(diff).padStart(6)}`)
  );
}
console.log(`\nTOTAL stored: £${storedTotal}   TOTAL fresh: £${freshTotal}   diff: £${freshTotal - storedTotal}`);
console.log('\nIf FRESH is close to legacy\'s £22,589 (minus Abingdon, plus Bedford/Paulton) and STORED is');
console.log('close to our current £28,790, the gap is stale data — just re-pull past_due for July.');
console.log('If FRESH is ALSO close to £28,790, the gap is real and needs a closer look at the DaysLate/');
console.log('ChargeBalance field logic itself, or at what "30+ days" means on the legacy side.');
process.exit(0);
