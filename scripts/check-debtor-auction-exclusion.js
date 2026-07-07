// Follow-up to check-debtor-gap-july.js: after ruling out stale data as the source of our ~£3k+
// Debtor Levels gap vs the legacy portal (fresh vs stored matched closely), a raw PastDueBalances
// dump for L012 (Gillingham) showed 3 of its 4 "30+ days overdue" rows carry
// `Auction_x0020_Status: "In Auction"` — units already scheduled for lien-sale/auction, which a
// typical "debtor levels" dashboard would treat as already-being-recovered rather than routine AR
// to chase. Our current parser (lib/reportMap.js's `past_due`) counts ALL DaysLate>30 rows regardless
// of auction status. This script re-pulls PastDueBalances for every site, computes the total BOTH
// ways (current: all 30+ rows; candidate fix: 30+ rows EXCLUDING any Auction_x0020_Status other than
// "None"/blank), and reports both portfolio totals so we can see how close the excluding-auction
// total lands to legacy's £22,589 (bearing in mind our portfolio also includes Bedford/Paulton, which
// legacy's number does not, and excludes Abingdon, which legacy's number does include).
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-debtor-auction-exclusion.js
import { admin } from '../lib/supabaseAdmin.js';
import { callReport } from '../lib/sitelink.js';

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const end = now; // cap at today — same rule as lib/pull.js's endOf() for the live current month

const { data: sites, error } = await admin.from('sites').select('code,name').order('code');
if (error) { console.error(error.message); process.exit(1); }

console.log(`Re-pulling PastDueBalances for ${sites.length} sites, comparing "all 30+" vs "30+ excluding auction/write-off statuses"...\n`);
console.log('CODE   NAME                  ALL_30+   EXCL_AUCTION   AUCTION_ROWS');
let allTotal = 0, exclTotal = 0;
for (const s of sites) {
  try {
    const { rows } = await callReport('PastDueBalances', s.code, start, end);
    let all = 0, excl = 0, auctionRows = 0;
    for (const r of rows) {
      const bal = Number(r.ChargeBalance) || 0;
      if (bal <= 0) continue;
      const days = Number(r.DaysLate) || 0;
      if (days <= 30) continue;
      all += bal;
      const status = (r.Auction_x0020_Status || '').trim();
      if (status && status.toLowerCase() !== 'none') { auctionRows++; continue; }
      excl += bal;
    }
    allTotal += all; exclTotal += excl;
    console.log(`${s.code.padEnd(6)} ${(s.name || s.code).padEnd(21)} £${String(Math.round(all)).padStart(7)}   £${String(Math.round(excl)).padStart(10)}   ${auctionRows}`);
  } catch (e) {
    console.log(`${s.code.padEnd(6)} ${(s.name || s.code).padEnd(21)} ERROR: ${e.message}`);
  }
}
console.log(`\nPortfolio ALL 30+ (current formula): £${Math.round(allTotal)}`);
console.log(`Portfolio 30+ EXCLUDING auction/write-off: £${Math.round(exclTotal)}`);
console.log(`\nLegacy's July total was £22,589 (26 sites, includes Abingdon, excludes Bedford/Paulton).`);
process.exit(0);
