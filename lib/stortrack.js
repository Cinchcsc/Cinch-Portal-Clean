// StorTrack Daily Rates API client — competitor pricing data (task #175, 14 Jul 2026).
// Same credential pattern as lib/sitelink.js / lib/supabaseAdmin.js: the real API key lives ONLY in
// .env (STORTRACK_API_KEY) and Vercel's env vars — never in this file, never in chat, never in git.
//
// NOT YET CONFIRMED (Michael has an active API key but can't share the docs page itself — it shows
// account-specific info — so these are placeholders, not verified facts):
//   1. Base URL / endpoint path. StorTrack's public marketing copy describes a "Daily Rates API"
//      covering current rental rates for 60,000+ facilities, and a SEPARATE product that pushes
//      competitor rates directly into SiteLink's own Competitor Tracking page — these may be two
//      different APIs. STORTRACK_BASE_URL below is a placeholder; confirm the real one before using.
//   2. Auth mechanism. Guessed here as `Authorization: Bearer <key>` (the most common REST
//      convention) — could just as easily be a custom header (e.g. X-API-Key). CONFIRM before relying
//      on this; a wrong guess here fails loudly (401/403), which is safer than a wrong guess that
//      silently returns empty/wrong data.
//   3. Response shape. fetchDailyRates() below returns the raw parsed JSON as-is rather than mapping
//      fields into this codebase's usual { site_code, ... } shape (see lib/reportMap.js for that
//      convention) — there's nothing to map yet since the real field names aren't confirmed.
//
// Once confirmed: update the auth header below, set STORTRACK_BASE_URL correctly in .env, and add a
// proper parse function here (same spirit as reportMap.js's per-report parsers) instead of returning
// raw JSON.
const BASE_URL = (process.env.STORTRACK_BASE_URL || 'https://api.stortrack.com').replace(/\/+$/, '');

function requireKey() {
  const key = process.env.STORTRACK_API_KEY;
  if (!key) throw new Error('STORTRACK_API_KEY not set — add it to .env (never commit the real value).');
  return key;
}

// Single low-level call, kept generic until the real endpoint path + response shape are confirmed.
// `path` example guess: '/v1/rates/daily' — CONFIRM against the real docs.
export async function stortrackGet(path, params = {}) {
  const key = requireKey();
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: {
      // UNCONFIRMED — see file header comment. Swap for the real mechanism once known.
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`StorTrack API ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }
  return res.json();
}

// Placeholder entry point — path is a guess, response is returned raw (no parser yet). See file
// header for exactly what's confirmed vs assumed.
export async function fetchDailyRates(params = {}) {
  return stortrackGet('/v1/rates/daily', params);
}
