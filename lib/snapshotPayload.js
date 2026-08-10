// Single shared reader for snapshot_payload — the one row of daily/weekly/quarterly aggregated
// JSON that lib/pullSnapshot.js writes and app/api/snapshot/route.js reads. Mirrors
// lib/portalPayload.js's readPortalPayload() exactly; kept as a separate table/reader (not folded
// into portal_payload) so the Weekly/Daily Snapshot page can refresh on its own lean schedule
// independent of the main monthly pull.
import { admin } from './supabaseAdmin.js';
import { buildSnapshotPayloadFromRawReport, latestSnapshotSourcePulledAt, SNAPSHOT_PAYLOAD_BUILD_VERSION, snapshotPeriodWindows } from './pullSnapshot.js';
import { retryOnStatementTimeout } from './supabaseRetry.js';

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
    return { payload, generatedAt: payload?.generated_at || null };
  } catch (error) {
    console.warn('[snapshotPayload] fresh raw_report snapshot rebuild failed; falling back to stored snapshot_payload:', error?.message || error);
    if (stored?.payload) return stored;
    throw error;
  }
}
