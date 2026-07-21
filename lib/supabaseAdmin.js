// Service-role Supabase client — SERVER ONLY. Bypasses RLS to write report data.
// Never import this into client/browser code.
import { createClient } from '@supabase/supabase-js';

// Accept the base project URL even if it's accidentally suffixed with /rest/v1 — the client adds
// /rest/v1 itself, so a suffixed value yields /rest/v1/rest/v1 → "Invalid path" on every call.
// IMPORTANT: read the SERVER-ONLY var (SUPABASE_URL), not NEXT_PUBLIC_SUPABASE_URL — this file is
// never supposed to be bundled client-side, and NEXT_PUBLIC_* vars get INLINED into the compiled
// bundle at build time by Next.js, so they silently freeze at whatever value existed when this
// module was first compiled and ignore all later .env edits without a full `.next` cache wipe.
// (Confirmed 2 Jul 2026: this was the actual cause of the dev server serving a payload from
// 2026-06-25 while fresh `npm run pull`/`npm run check` runs — which load .env fresh every
// invocation via `--env-file` — showed correct, current data.) Falls back to the NEXT_PUBLIC_
// name only for back-compat with any existing .env that hasn't been renamed yet.
const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(url && key);

if (!configured) console.warn('[supabaseAdmin] missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

function createStubClient() {
  const fail = (method) => () => {
    throw new Error(`Supabase admin client is not configured; cannot call ${method}.`);
  };
  return {
    from: fail('from'),
    rpc: fail('rpc'),
  };
}

// ADDED 21 Jul 2026: force every request this client makes to bypass Next.js's own fetch-level
// Data Cache. Next.js 14's App Router patches the global fetch() during server rendering/route
// handlers and can cache responses from it — INCLUDING fetches made deep inside a third-party
// library like supabase-js, which uses fetch under the hood to hit PostgREST — unless that
// specific fetch call opts out itself. A route's own `export const dynamic = 'force-dynamic'`
// is supposed to cover this, but doesn't reliably reach into library-internal fetch calls in
// every case. Root-caused this after ruling out every other explanation for /api/snapshot
// serving an old (06:24) row instead of a confirmed-current (10:20) one on Vercel specifically —
// never reproducible via a plain `node --env-file=.env` script, which never runs inside Next's
// fetch-patching machinery at all. Passing our own fetch here, with cache explicitly forced to
// 'no-store', makes this client's freshness independent of any route-level setting.
const noStoreFetch = (input, init) => fetch(input, { ...init, cache: 'no-store' });

export const admin = configured
  ? createClient(url, key, { auth: { persistSession: false }, global: { fetch: noStoreFetch } })
  : createStubClient();
