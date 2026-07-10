// Run the Weekly/Daily/Quarterly Snapshot pull locally (no Vercel timeout — 174 sequential SiteLink
// calls take a couple of minutes). Writes to snapshot_payload via the service-role key.
// npm run pull:snapshot
import { runSnapshotPull } from '../lib/pullSnapshot.js';

const result = await runSnapshotPull();
console.log('SNAPSHOT PULL RESULT:', JSON.stringify(result, null, 2));
process.exit(result.status === 'error' ? 1 : 0);
