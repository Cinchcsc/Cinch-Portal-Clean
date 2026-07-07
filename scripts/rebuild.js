// Rebuild portal_payload from the data already in Supabase (NO SiteLink calls — instant).
// Use after a buildPayload change, or to re-assemble the JSON.  npm run rebuild
import { admin } from '../lib/supabaseAdmin.js';
import { buildPayload } from '../lib/buildPayload.js';

const now = new Date();
const cur = new Date(now.getFullYear(), now.getMonth(), 1);       // live, in-progress month (mirrors the old portal)
const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);  // last complete month — drives MoM deltas
const payload = await buildPayload(cur, prev);
const { error } = await admin.from('portal_payload').upsert({ id: 1, generated_at: new Date().toISOString(), payload });
if (error) { console.error('rebuild failed:', error.message); process.exit(1); }
console.log(`Payload rebuilt — ${payload.months.length} months, ${payload.sites.length} sites (current ${payload.current_month}).`);
process.exit(0);
