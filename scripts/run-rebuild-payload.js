// Run just the portal_payload rebuild locally (no SiteLink calls — reads already-stored raw_report,
// writes portal_payload via the service-role key). Same job GET /api/rebuild-payload's cron runs —
// see lib/rebuildPayload.js / task #297 for why this is now split out of npm run pull.
// npm run rebuild:payload
// node --env-file=.env scripts/run-rebuild-payload.js --force-historical-repair
import { runRebuildPayload } from '../lib/rebuildPayload.js';

const args = new Set(process.argv.slice(2));
const repairMonths = process.argv.slice(2)
  .filter((arg) => arg.startsWith('--repair-month='))
  .map((arg) => arg.slice('--repair-month='.length))
  .filter(Boolean);
const triggerLabel = process.argv.slice(2)
  .find((arg) => arg.startsWith('--trigger-label='))
  ?.slice('--trigger-label='.length) || process.env.PORTAL_TRIGGER_LABEL || 'cli:npm-run-rebuild-payload';
const result = await runRebuildPayload({
  forceHistoricalRepair: args.has('--force-historical-repair'),
  repairMonths,
  skipLockCheck: args.has('--skip-lock-check'),
  triggerLabel,
});
console.log('REBUILD RESULT:', JSON.stringify(result, null, 2));
process.exit(result.status === 'error' ? 1 : 0);
