// StorTrack Daily Rates API client — competitor pricing data (task #175, 14 Jul 2026).
// Same credential pattern as lib/sitelink.js / lib/supabaseAdmin.js: real credentials live ONLY in
// .env and Vercel's env vars — never in this file, never in chat, never in git.
//
// CONFIRMED (14 Jul 2026, from Michael reading StorTrack's own docs page — he can't share the page
// itself since it shows account-specific info, but described this part in his own words):
//   Auth is OAuth2 "password grant" — a login-style flow, not a static API key in a header. You POST
//   your username + password (grant_type=password) to a token endpoint, which returns an access_token
//   + token_type + expires_in (seconds). That access_token is then used as a Bearer token on the
//   actual data requests, and needs refreshing once it expires.
//
// CONFIRMED (14 Jul 2026, from the docs page's own example request body, shared with placeholder
// example values only — not Michael's real credentials):
//   { "grant_type": "password", "username": "...", "password": "..." }
//   This is sent as a JSON body (Content-Type: application/json), NOT form-urlencoded — updated
//   below to match.
//
// CONFIRMED (14 Jul 2026, from the actual Swagger/OpenAPI docs page at https://api.stortrack.com/docs —
// Michael copy-pasted the Authentication section's text, which is documentation, not his secret data):
//   - Base URL: https://api.stortrack.com (matches our existing default, now confirmed not just guessed).
//   - Token endpoint: POST /authtoken — request body schema is EXACTLY
//       { "username": "string", "password": "string", "grant_type": "string" }
//     with no client_id/client_secret fields in the schema at all — so that's not required.
//   - Response: access token + token type + expiration in seconds (exact field names still assumed
//     as access_token/expires_in below — the docs prose didn't spell those out, only described them).
//   - Every subsequent data request must carry `Authorization: Bearer <access_token>` — confirms the
//     mechanism already implemented in stortrackGet() below.
//   - The API also exposes a "Store Price Options" concept: a `storestatus` attribute per StoreID/
//     MasterID (1 = price available, 2 = website available but no pricing, 3 = neither) — suggests the
//     data endpoint(s) key off StoreID/MasterID, but the actual path for that isn't shown in what's
//     been shared yet.
//
// STILL NOT CONFIRMED:
//   1. The actual data endpoint path + response shape for pulling daily rates (fetchDailyRates()'s
//      '/v1/rates/daily' below is still a placeholder guess — the Authentication section doesn't cover
//      this; there's likely a separate "Pricing" or "Store" section in the same docs page with it).
//   2. Exact token-response field casing (access_token vs accessToken, expires_in vs expiresIn) —
//      code below tries both.
const BASE_URL = (process.env.STORTRACK_BASE_URL || 'https://api.stortrack.com').replace(/\/+$/, '');
const TOKEN_PATH = process.env.STORTRACK_TOKEN_PATH || '/authtoken'; // confirmed 14 Jul 2026 — see header comment

function requireCreds() {
  const username = process.env.STORTRACK_USERNAME;
  const password = process.env.STORTRACK_PASSWORD;
  if (!username || !password) throw new Error('STORTRACK_USERNAME / STORTRACK_PASSWORD not set — add both to .env (never commit the real values).');
  return { username, password };
}

// In-memory token cache (module-level — fine for both the Next.js server process and one-off
// scripts; a fresh process just re-authenticates once on first call). Refreshes 60s before the
// token's own reported expiry rather than waiting for a request to fail first.
let _token = null; // { accessToken, expiresAt }

async function getAccessToken() {
  if (_token && _token.expiresAt > Date.now() + 60_000) return _token.accessToken;

  const { username, password } = requireCreds();
  // Body matches the confirmed schema exactly: username, password, grant_type. No client_id/secret —
  // the docs' own request schema doesn't include those fields.
  const body = { username, password, grant_type: 'password' };

  const res = await fetch(BASE_URL + TOKEN_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`StorTrack token request failed: ${res.status} ${res.statusText}${errBody ? ` — ${errBody.slice(0, 300)}` : ''}`);
  }
  const json = await res.json();
  // Field names guessed from the docs description Michael relayed ("access token, token type &
  // expiration in seconds") — standard OAuth2 password-grant response fields. Adjust if the real
  // field names differ (e.g. snake_case vs camelCase).
  const accessToken = json.access_token || json.accessToken;
  const expiresIn = json.expires_in ?? json.expiresIn ?? 3600; // fall back to 1hr if the field is missing/misnamed
  if (!accessToken) throw new Error(`StorTrack token response had no access_token field. Keys received: ${Object.keys(json).join(', ')}`);
  _token = { accessToken, expiresAt: Date.now() + expiresIn * 1000 };
  return accessToken;
}

// Single low-level GET, kept generic until the real data-endpoint path + response shape are
// confirmed. `path` example guess: '/v1/rates/daily' — CONFIRM against the real docs.
export async function stortrackGet(path, params = {}) {
  const accessToken = await getAccessToken();
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`StorTrack API ${res.status} ${res.statusText}${errBody ? ` — ${errBody.slice(0, 300)}` : ''}`);
  }
  return res.json();
}

// Placeholder entry point — path is a guess, response is returned raw (no parser yet). See file
// header for exactly what's confirmed vs assumed.
export async function fetchDailyRates(params = {}) {
  return stortrackGet('/v1/rates/daily', params);
}
