// Single shared reader for snapshot_payload — the one row of daily/weekly/quarterly aggregated
// JSON that lib/pullSnapshot.js writes and app/api/snapshot/route.js reads. Mirrors
// lib/portalPayload.js's readPortalPayload() exactly; kept as a separate table/reader (not folded
// into portal_payload) so the Weekly/Daily Snapshot page can refresh on its own lean schedule
// independent of the main monthly pull.
import { admin } from './supabaseAdmin.js';
import { buildSnapshotPayloadFromRawReport, latestSnapshotSourcePulledAt, SNAPSHOT_PAYLOAD_BUILD_VERSION, snapshotPeriodWindows } from './pullSnapshot.js';
import { retryOnStatementTimeout } from './supabaseRetry.js';

async function writeSnapshotPayload(payload) {
  if (!payload || typeof payload !== 'object') return { payload: null, generatedAt: null };
  const generatedAt = payload.generated_at || new Date().toISOString();
  const payloadToStore = payload.generated_at ? payload : { ...payload, generated_at: generatedAt };
  const { error } = await retryOnStatementTimeout(async () => admin
    .from('snapshot_payload')
    .upsert({ id: 1, generated_at: generatedAt, payload: payloadToStore }), 5, 2500);
  if (error) throw new Error(error.message);
  return { payload: payloadToStore, generatedAt };
}

export async function readSnapshotPayload() {
  const data = await retryOnStatementTimeout(async () => {
    const { data, error } = await admin
      .from('snapshot_payload')
      .select('payload,generated_at')
      .eq('id', 1)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data;
  }, 5, 2500);
  if (!data?.payload) return null;

  const parsedPayload = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
  const payload = parsedPayload && typeof parsedPayload === 'object'
    ? { ...parsedPayload, generated_at: data.generated_at || null }
    : parsedPayload;
  return { payload, generatedAt: data.generated_at };
}

export async function readLatestSnapshotRefreshAt() {
  const data = await retryOnStatementTimeout(async () => {
    const { data, error } = await admin
      .from('refresh_log')
      .select('finished_at,started_at')
      .eq('kind', 'snapshot')
      .eq('status', 'ok')
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data || null;
  }, 5, 2500);
  return data?.finished_at || data?.started_at || null;
}

export async function readSnapshotPayloadFresh(now = new Date()) {
  let stored = null;
  try {
    stored = await readSnapshotPayload();
  } catch (error) {
    console.warn('[snapshotPayload] stored snapshot_payload read failed; attempting fresh raw_report rebuild:', error?.message || error);
  }

  const locations = (process.env.SITELINK_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const windows = snapshotPeriodWindows(now);
  const storedHasCompleteShape = !!(
    stored?.payload &&
    stored.payload.daily?.range?.start &&
    stored.payload.weekly?.range?.start &&
    stored.payload.quarterly?.range?.start
  );
  const storedBuildVersionCurrent = stored?.payload?.build_version === SNAPSHOT_PAYLOAD_BUILD_VERSION;

  if (storedHasCompleteShape && storedBuildVersionCurrent && stored?.generatedAt) {
    try {
      const latestRawPulledAt = await latestSnapshotSourcePulledAt(locations, windows);
      const storedAtMs = new Date(stored.generatedAt).getTime();
      const latestRawAtMs = latestRawPulledAt ? new Date(latestRawPulledAt).getTime() : 0;
      const storedCoversLatestRaw = !latestRawPulledAt || (Number.isFinite(storedAtMs) && Number.isFinite(latestRawAtMs) && storedAtMs >= latestRawAtMs);
      if (storedCoversLatestRaw) return stored;
    } catch (error) {
      console.warn('[snapshotPayload] snapshot freshness probe failed; serving stored snapshot_payload instead of forcing a rebuild:', error?.message || error);
      if (storedBuildVersionCurrent) return stored;
    }
  }

  try {
    const payload = await buildSnapshotPayloadFromRawReport({ now, locations });
    // Self-heal stale/legacy snapshot rows after deploys or failed morning writes so the first good
    // rebuild becomes the new stored default instead of being thrown away after one request.
    try {
      return await writeSnapshotPayload(payload);
    } catch (persistError) {
      console.warn('[snapshotPayload] fresh raw_report snapshot rebuild succeeded but snapshot_payload write-back failed; serving rebuilt payload directly:', persistError?.message || persistError);
      return { payload, generatedAt: payload?.generated_at || null };
    }
  } catch (error) {
    console.warn('[snapshotPayload] fresh raw_report snapshot rebuild failed; falling back to stored snapshot_payload:', error?.message || error);
    if (stored?.payload) return stored;
    throw error;
  }
}
