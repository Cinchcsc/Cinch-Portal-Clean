// Run just the portal_payload rebuild locally (no SiteLink calls — reads already-stored raw_report,
// writes portal_payload via the service-role key). Same job GET /api/rebuild-payload's cron runs —
// see lib/rebuildPayload.js / task #297 for why this is now split out of npm run pull.
// npm run rebuild:payload
import { runRebuildPayload } from '../lib/rebuildPayload.js';

const result = await runRebuildPayload();
console.log('REBUILD RESULT:', JSON.stringify(result, null, 2));
process.exit(result.status === 'error' ? 1 : 0);
