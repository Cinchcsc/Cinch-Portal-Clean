// Single shared reader for portal_payload — the one row of aggregated JSON that buildPayload.js
// writes and everything downstream (bootstrap.js legacy shim, the new /api/portfolio route, any
// future consumer) reads from. Do not duplicate this Supabase read elsewhere.
import { admin } from './supabaseAdmin.js';
import { runRebuildPayload } from './rebuildPayload.js';

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

async function fetchPortalPayloadRow() {
  const { data, error } = await admin
    .from('portal_payload')
    .select('payload,generated_at')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data?.payload ? data : null;
}

async function latestCurrentMonthPullAt() {
  const { data, error } = await admin
    .from('raw_report')
    .select('pulled_at')
    .eq('month', monthKey(new Date()))
    .not('pulled_at', 'is', null)
    .order('pulled_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data?.pulled_at || null;
}

async function ensureFreshPortalPayload(row) {
  const latestPullAt = await latestCurrentMonthPullAt();
  if (!latestPullAt) return row;

  const generatedAtMs = row?.generated_at ? new Date(row.generated_at).getTime() : 0;
  const latestPullAtMs = new Date(latestPullAt).getTime();
  if (generatedAtMs >= latestPullAtMs) return row;

  const rebuild = await runRebuildPayload();
  if (rebuild.status === 'ok') return await fetchPortalPayloadRow();
  return row;
}

export async function readPortalPayload({ ensureFresh = false } = {}) {
  let data = await fetchPortalPayloadRow();
  if (ensureFresh) data = await ensureFreshPortalPayload(data);
  if (!data?.payload) return null;

  const payload = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
  return { payload, generatedAt: data.generated_at };
}
