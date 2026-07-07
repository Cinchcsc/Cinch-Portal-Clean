import { admin } from '../lib/supabaseAdmin.js';
const { data, error } = await admin.from('raw_report')
  .select('month,data').eq('report','rent_roll').eq('site_code','L001')
  .order('month', { ascending: false }).limit(1);
if (error) { console.log('err', error.message); process.exit(1); }
console.log('month:', data?.[0]?.month);
console.log(JSON.stringify(data?.[0]?.data, null, 2));
