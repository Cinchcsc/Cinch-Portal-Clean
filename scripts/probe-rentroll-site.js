// Dumps the stored (already-pulled) RentRoll parser output for one site — NO SiteLink call, reads
// straight from Supabase raw_report, so it's instant. Lets us verify the authoritative rate formula
// (Michael, 1 Jul 2026) against a specific store's numbers without waiting on a full pull.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/probe-rentroll-site.js L002
import { admin } from '../lib/supabaseAdmin.js';

const code = process.argv[2];
if (!code) { console.log('Usage: node scripts/probe-rentroll-site.js <SITE_CODE>   e.g. L002'); process.exit(1); }

const { data, error } = await admin.from('raw_report')
  .select('month,data').eq('report', 'rent_roll').eq('site_code', code)
  .order('month', { ascending: false }).limit(1);
if (error) { console.log('err', error.message); process.exit(1); }
if (!data?.length) { console.log(`no rent_roll rows stored for ${code} — has it been pulled?`); process.exit(0); }
console.log(`site: ${code}  month: ${data[0].month}`);
console.log(JSON.stringify(data[0].data, null, 2));
