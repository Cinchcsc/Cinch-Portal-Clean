// Live SiteLink call for ONE site only (cheap, seconds not minutes) — calls the REAL pullReport()/
// parse() code exactly as pull.js would, WITHOUT touching Supabase or running the full 27-site pull.
// This verifies the dMovedIn-based insured_new_customers fix actually works end-to-end before
// spending 30 minutes on a full `npm run pull`.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/test-insurance-parse.js [siteCode]
import { pullReport } from '../lib/reportMap.js';

const loc = (process.argv[2] || (process.env.SITELINK_LOCATIONS || '').split(',')[0] || '').trim();
if (!loc) { console.error('No site code given and SITELINK_LOCATIONS not set'); process.exit(1); }

const now = new Date();
const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const prevEnd = new Date(now.getFullYear(), now.getMonth(), 0);

console.log(`Testing insurance_roll parse for ${loc}, period ${prevMonth.toISOString().slice(0,10)} to ${prevEnd.toISOString().slice(0,10)}...\n`);
const { data, rowcount } = await pullReport('insurance_roll', loc, prevMonth, prevEnd);
console.log(`rowcount=${rowcount}`);
console.log(`insured_units=${data.insured_units}, monthly_premium=£${data.monthly_premium}`);
console.log(`insured_new_customers=${JSON.stringify(data.insured_new_customers)}`);
process.exit(0);
