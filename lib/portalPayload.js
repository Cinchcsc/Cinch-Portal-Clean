// Single shared reader for portal_payload — the one row of aggregated JSON that buildPayload.js
// writes and everything downstream (bootstrap.js legacy shim, the new /api/portfolio route, any
// future consumer) reads from. Do not duplicate this Supabase read elsewhere.
import { admin } from './supabaseAdmin.js';

export async function readPortalPayload() {
  const { data, error } = await admin
    .from('portal_payload')
    .select('payload,generated_at')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data?.payload) return null;

  const payload = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
  return { payload, generatedAt: data.generated_at };
}
