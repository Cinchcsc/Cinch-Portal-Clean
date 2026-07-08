// Verifies the ACTUAL modified lead_funnel parser (lib/reportMap.js), called the same way
// pullReport()/pull.js call it in production — not a standalone reimplementation like
// probe-enquiries-dplaced.js. Confirms the real code change, not just the hypothesis.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/verify-enquiries-dplaced-fix.js
import { pullReport } from '../lib/reportMap.js';

const EXCLUDE = new Set(['L021', 'L026']);
const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map(s => s.trim()).filter((c) => c && !EXCLUDE.has(c));
const start = new Date(2026, 6, 1);
let end = new Date(); if (end > new Date(2026, 6, 31)) end = new Date(2026, 6, 31);

let phone = 0, walkin = 0, web = 0, webCombined = 0, email = 0, total = 0;

for (const loc of locations) {
  process.stderr.write(`[verify] ${loc}...\n`);
  try {
    const { data } = await pullReport('lead_funnel', loc, start, end);
    phone += data.phone || 0; walkin += data.walkin || 0; web += data.web || 0;
    webCombined += data.web_combined || 0; email += data.email || 0; total += data.total_enquiries || 0;
  } catch (e) { console.log(`  ${loc}: error: ${e.message}`); }
}

console.log('\n=== Actual reportMap.js lead_funnel parser output, via pullReport(), 25 sites, Jul 2026 MTD ===');
console.log(`Phone=${phone}  Walk-in=${walkin}  Web(raw)=${web}  Web(+Email, displayed tile)=${webCombined}  Email=${email}  Total=${total}`);
console.log('Legacy target:  Phone=54  Walk-in=60  Web=887  Total=1002');
process.exit(0);
