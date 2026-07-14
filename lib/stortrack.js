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
// CONFIRMED (14 Jul 2026): token endpoint path is /authtoken (per Michael reading the docs page).
//
// STILL NOT CONFIRMED:
//   1. Whether /authtoken is relative to STORTRACK_BASE_URL as-is, or needs a version prefix
//      (e.g. /v1/authtoken) — try the plain path first, adjust STORTRACK_TOKEN_PATH in .env if it
//      404s.
//   2. Whether a client_id/client_secret is ALSO required alongside username/password (some password-
//      grant implementations need this, some don't) — STORTRACK_CLIENT_ID/STORTRACK_CLIENT_SECRET
//      below are optional and only sent if set, pending Michael confirming either way.
//   3. The actual data endpoint path + response shape (STORTRACK_BASE_URL + fetchDailyRates()'s path
//      below are still placeholder guesses, unconfirmed).
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
  const body = { grant_type: 'password', username, password };
  if (process.env.STORTRACK_CLIENT_ID) body.client_id = process.env.STORTRACK_CLIENT_ID;
  if (process.env.STORTRACK_CLIENT_SECRET) body.client_secret = process.env.STORTRACK_CLIENT_SECRET;

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
