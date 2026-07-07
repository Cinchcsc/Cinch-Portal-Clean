// Calls the REAL buildPayload() function directly (no Supabase write, just inspects the in-memory
// result) to settle whether the merchandise fix is actually broken in production code, or whether
// something in rebuild.js / the stored portal_payload row was stale/corrupted. This removes any
// possibility that check-merch-pipeline.js's hand-rolled replication of the fetch/idx logic was
// itself subtly wrong.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/check-buildpayload-direct.js
import { buildPayload } from '../lib/buildPayload.js';

const now = new Date();
const cur = new Date(now.getFullYear(), now.getMonth(), 1);
const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);

console.log('Calling buildPayload() directly (no DB write)...\n');
const payload = await buildPayload(cur, prev);

console.log(`months=${payload.months?.length}, sites=${payload.sites?.length}, current_month=${payload.current_month}\n`);

const CHECK = ['L001', 'L002', 'L003', 'L014'];
for (const code of CHECK) {
  const s = payload.sites.find(x => x.code === code);
  if (!s) { console.log(`${code}: NOT FOUND in sites array`); continue; }
  console.log(`${code} (${s.name}): merchandise.chargeFromFinancial=£${(s.merchandise?.chargeFromFinancial ?? 'undefined')}`);
}
process.exit(0);
