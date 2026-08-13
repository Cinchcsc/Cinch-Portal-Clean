// Rebuild portal_payload from the data already in Supabase (NO SiteLink calls).
// Use after a buildPayload change, or to re-assemble the JSON.  npm run rebuild
// Keep this on the SAME shared rebuild path as the cron/manual repair scripts so local rebuilds
// inherit the current fast-path / lock / retry behavior instead of bypassing it with the older
// direct buildPayload()+upsert flow.
//
// 13 Aug 2026 (egress audit): forceHistoricalRepair used to be hardcoded true here, so every plain
// `npm run rebuild` forced a full historical raw_response rescan whether or not it was actually
// needed — the same problem the hardcoded skipLockCheck had before that was made a flag below. Pass
// --force-historical-repair explicitly right after a buildPayload.js change that needs every stored
// month recomputed; otherwise this now takes the same cheap current-month-merge path the cron uses
// (and still self-triggers a full repair on its own whenever PORTAL_PAYLOAD_BUILD_VERSION or stored
// history genuinely needs it — see lib/rebuildPayload.js's storedBuildVersionMismatch handling).
import { runRebuildPayload } from '../lib/rebuildPayload.js';

const args = new Set(process.argv.slice(2));
const triggerLabel = process.argv.slice(2)
  .find((arg) => arg.startsWith('--trigger-label='))
  ?.slice('--trigger-label='.length) || process.env.PORTAL_TRIGGER_LABEL || 'cli:npm-run-rebuild';
const result = await runRebuildPayload({
  forceHistoricalRepair: args.has('--force-historical-repair'),
  skipLockCheck: args.has('--skip-lock-check'),
  triggerLabel,
});
if (result.status === 'error') {
  console.error(`rebuild failed: ${result.message || 'unknown error'}`);
  process.exit(1);
}
console.log(`Payload rebuilt (${result.durationMs}ms, mode=${result.mode || 'unknown'}).`);
process.exit(0);
