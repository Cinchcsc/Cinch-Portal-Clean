// Single shared reader for snapshot_payload — the one row of daily/weekly/quarterly aggregated
// JSON that lib/pullSnapshot.js writes and app/api/snapshot/route.js reads. Mirrors
// lib/portalPayload.js's readPortalPayload() exactly; kept as a separate table/reader (not folded
// into portal_payload) so the Weekly/Daily Snapshot page can refresh on its own lean schedule
// independent of the main monthly pull.
import { admin } from './supabaseAdmin.js';

export async function readSnapshotPayload() {
  const { data, error } = await admin
    .from('snapshot_payload')
    .select('payload,generated_at')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data?.payload) return null;

  const payload = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
  return { payload, generatedAt: data.generated_at };
}
