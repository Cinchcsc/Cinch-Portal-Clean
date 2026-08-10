// Rebuild portal_payload from the data already in Supabase (NO SiteLink calls).
// Use after a buildPayload change, or to re-assemble the JSON.  npm run rebuild
// Keep this on the SAME shared rebuild path as the cron/manual repair scripts so local rebuilds
// inherit the current fast-path / lock / retry behavior instead of bypassing it with the older
// direct buildPayload()+upsert flow.
import { runRebuildPayload } from '../lib/rebuildPayload.js';

const result = await runRebuildPayload({ forceHistoricalRepair: true, skipLockCheck: true });
if (result.status === 'error') {
  console.error(`rebuild failed: ${result.message || 'unknown error'}`);
  process.exit(1);
}
console.log(`Payload rebuilt (${result.durationMs}ms, mode=${result.mode || 'unknown'}).`);
process.exit(0);
