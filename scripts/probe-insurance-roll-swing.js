// Portfolio Insurance Roll swung hard between two back-to-back pulls on the same day (3 Jul 2026):
//   insurancePremium  £169,379 -> £60,744   (-64%)
//   insurancePctInsured  83.1% -> 28.5%     (-66%)
//   insurancePctRoll     13.4% -> 4.8%      (-64%)
// All three move by roughly the same ratio, which points at a chunk of sites' InsuranceRoll data
// going missing/zero on the second pull rather than a real business change (InsuranceRoll is a
// point-in-time snapshot of currently-insured units, not something that should swing 60%+ in an
// hour). This was NOT touched by the 3 Jul month-scoping fix (insurance_roll isn't in TWO_MONTH and
// isn't in buildPayload.js's prevByCode override list) — so if this is a bug, it's a separate,
// pre-existing one that just happened to surface now. This dumps per-site InsuranceRoll numbers
// directly from SiteLink (not from stored raw_report) so we can see which sites, if any, are
// returning 0/empty right now.
// PII-SAFE: only prints per-site aggregate counts/premiums, no tenant data.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-insurance-roll-swing.js
import { callReport } from '../lib/sitelink.js';

const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const now = new Date();
// Mirror lib/pull.js's exact date window for insurance_roll (dated:true, current month only,
// end capped at "now") so this probe is comparable to what production actually stored.
const start = new Date(now.getFullYear(), now.getMonth(), 1);
const end = now;
const yes = (v) => v === true || v === 1 || /^(1|true|yes|y)$/i.test(String(v ?? ''));
const num = (r, k) => Number(r[k] ?? 0) || 0;

let totalInsured = 0, totalPremium = 0;
const rows = [];

for (const loc of locations) {
  process.stderr.write(`[insurance-roll] ${loc}...\n`);
  try {
    const { rows: r } = await callReport('InsuranceRoll', loc, start, end);
    // EXACT same filter as lib/reportMap.js's insurance_roll parser: active policies only, via iActive.
    let insured = 0, premium = 0, inactiveCount = 0;
    for (const row of r) {
      if (!yes(row.iActive)) { inactiveCount++; continue; }
      insured++; premium += num(row, 'dcPremium');
    }
    totalInsured += insured; totalPremium += premium;
    rows.push({ loc, rowcount: r.length, insured, inactiveCount, premium: Math.round(premium * 100) / 100 });
    if (rows.length === 1 && r.length) {
      console.log('Sample columns on an InsuranceRoll row:', Object.keys(r[0]).filter(k => !/^(diffgr|msdata)/i.test(k)).join(', '));
      console.log('Sample iActive raw values (first 10 rows):', r.slice(0, 10).map(x => x.iActive), '\n');
    }
  } catch (e) {
    rows.push({ loc, error: e.message });
  }
}

console.log('Per-site InsuranceRoll (live, right now):');
for (const r of rows) {
  if (r.error) console.log(`  ${r.loc}: ERROR ${r.error}`);
  else console.log(`  ${r.loc.padEnd(6)} rows=${String(r.rowcount).padEnd(5)} active(insured)=${String(r.insured).padEnd(5)} inactive=${String(r.inactiveCount).padEnd(5)} premium=£${r.premium}`);
}
console.log(`\nPortfolio total (live, right now): insured=${totalInsured}  premium=£${Math.round(totalPremium * 100) / 100}`);
console.log('Compare against the last two pulls: £169,379 premium (pull 1) vs £60,744 premium (pull 2) — see which this matches, or if it lands on a third number.');
console.log('If most sites show rows=0 or a huge inactive count relative to rows, that points at the iActive flag or the date window being the issue, not real business data.');
process.exit(0);
