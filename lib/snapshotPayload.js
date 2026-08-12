// Single shared reader for snapshot_payload — the one row of daily/weekly/quarterly aggregated
// JSON that lib/pullSnapshot.js writes and app/api/snapshot/route.js reads. Mirrors
// lib/portalPayload.js's readPortalPayload() exactly; kept as a separate table/reader (not folded
// into portal_payload) so the Weekly/Daily Snapshot page can refresh on its own lean schedule
// independent of the main monthly pull.
import { admin, createAdminClient } from './supabaseAdmin.js';
import { buildSnapshotPayloadFromRawReport, latestSnapshotSourcePulledAt, SNAPSHOT_PAYLOAD_BUILD_VERSION, snapshotPeriodWindows } from './pullSnapshot.js';
import { checkPullLock } from './pullLock.js';
import { isRetryableSupabaseMessage, retryOnStatementTimeout } from './supabaseRetry.js';

const SNAPSHOT_LOCK_PROBE_TIMEOUT_MS = 2500;
const SNAPSHOT_DB_QUERY_TIMEOUT_MS = 10_000;
const SUPABASE_REST_BASE = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '')
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/rest\/v1$/i, '')
  .replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTransportRetry(fn, attempts = 5, delayMs = 1500) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error?.message || String(error);
      if (!isRetryableSupabaseMessage(message) || attempt === attempts) throw error;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function runRetriedSnapshotQuery(fn, {
  attempts = 5,
  delayMs = 1500,
  timeoutMs = SNAPSHOT_DB_QUERY_TIMEOUT_MS,
  label = 'snapshot db query',
} = {}) {
  return withTransportRetry(async () => {
    const result = await withTimeout(retryOnStatementTimeout(fn, 1, 0), timeoutMs, label);
    if (result?.error) throw new Error(result.error.message || String(result.error));
    return result;
  }, attempts, delayMs);
}

async function readSingleSnapshotRestRow(path, label) {
  if (!SUPABASE_REST_BASE || !SUPABASE_SERVICE_ROLE_KEY) return null;
  const response = await withTransportRetry(
    () => withTimeout(fetch(`${SUPABASE_REST_BASE}/rest/v1/${path}`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
        Connection: 'close',
      },
      cache: 'no-store',
    }), SNAPSHOT_DB_QUERY_TIMEOUT_MS, label),
    5,
    1500,
  );
  if (!response.ok) throw new Error(`${label} failed (${response.status} ${response.statusText})`);
  const data = await response.json();
  return Array.isArray(data) ? (data[0] || null) : data;
}

async function writeSnapshotPayload(payload) {
  if (!payload || typeof payload !== 'object') return { payload: null, generatedAt: null };
  const generatedAt = payload.generated_at || new Date().toISOString();
  const payloadToStore = payload.generated_at ? payload : { ...payload, generated_at: generatedAt };
  const db = createAdminClient();
  await runRetriedSnapshotQuery(
    async () => db.from('snapshot_payload').upsert({ id: 1, generated_at: generatedAt, payload: payloadToStore }),
    { label: 'snapshot_payload write' },
  );
  return { payload: payloadToStore, generatedAt };
}

export async function readSnapshotPayload() {
  let data = null;
  try {
    const db = createAdminClient();
    const result = await runRetriedSnapshotQuery(async () => db
      .from('snapshot_payload')
      .select('payload,generated_at')
      .eq('id', 1).maybeSingle(), { label: 'snapshot_payload read' });
    data = result?.data || null;
  } catch (error) {
    const restRow = await readSingleSnapshotRestRow('snapshot_payload?id=eq.1&select=payload,generated_at', 'snapshot_payload REST read');
    data = restRow || null;
    if (!data) throw error;
  }
  if (!data?.payload) return null;

  const parsedPayload = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
  const payload = parsedPayload && typeof parsedPayload === 'object'
    ? { ...parsedPayload, generated_at: data.generated_at || null }
    : parsedPayload;
  return { payload, generatedAt: data.generated_at };
}

export async function readLatestSnapshotRefreshAt() {
  const [logRow, snapshotRow] = await Promise.all([
    (async () => {
      try {
        const db = createAdminClient();
        const { data } = await runRetriedSnapshotQuery(async () => db
          .from('refresh_log')
          .select('finished_at,started_at')
          .eq('kind', 'snapshot')
          .eq('status', 'ok')
          .order('id', { ascending: false })
          .limit(1).maybeSingle(), { label: 'snapshot refresh_log read' });
        return data || null;
      } catch {
        return readSingleSnapshotRestRow(
          'refresh_log?kind=eq.snapshot&status=eq.ok&select=finished_at,started_at&order=id.desc&limit=1',
          'snapshot refresh_log REST read',
        );
      }
    })(),
    (async () => {
      try {
        const db = createAdminClient();
        const { data } = await runRetriedSnapshotQuery(async () => db
          .from('snapshot_payload')
          .select('generated_at')
          .eq('id', 1).maybeSingle(), { label: 'snapshot generated_at read' });
        return data || null;
      } catch {
        return readSingleSnapshotRestRow('snapshot_payload?id=eq.1&select=generated_at', 'snapshot generated_at REST read');
      }
    })(),
  ]);
  const logAt = logRow?.finished_at || logRow?.started_at || null;
  const generatedAt = snapshotRow?.generated_at || null;
  const logMs = logAt ? new Date(logAt).getTime() : 0;
  const generatedMs = generatedAt ? new Date(generatedAt).getTime() : 0;
  if (generatedMs && (!logMs || generatedMs > logMs)) return generatedAt;
  return logAt;
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

  let sourceRefreshActive = false;
  try {
    const lock = await withTimeout(
      checkPullLock({ activeKinds: ['pull', 'snapshot'] }),
      SNAPSHOT_LOCK_PROBE_TIMEOUT_MS,
      'snapshot lock probe',
    );
    sourceRefreshActive = !!lock?.locked;
  } catch (error) {
    console.warn('[snapshotPayload] snapshot lock probe failed; serving stored snapshot_payload instead of rebuilding during possible source churn:', error?.message || error);
    sourceRefreshActive = true;
  }
  if (sourceRefreshActive) {
    if (stored?.payload) return stored;
    return null;
  }

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
