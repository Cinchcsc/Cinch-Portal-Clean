// Server-side Supabase client for Server Components / Route Handlers (task #202, 13 Jul 2026 —
// Michael: password-protect the portal, each person their own email/password). Uses the ANON key
// (safe to expose — RLS still applies to any table this client touches) plus the request's auth
// cookies, NOT the service-role key in lib/supabaseAdmin.js (that one bypasses RLS entirely and must
// never be reachable from anything a signed-in-but-otherwise-unprivileged user's session could hit).
// This file is for READING the current user's session (e.g. in a Server Component that wants to show
// their email) — the actual route-protection gate lives in middleware.js, which needs its own cookie
// wiring because Next.js middleware doesn't have access to next/headers' cookies().
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function createClient() {
  const cookieStore = cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() { return cookieStore.getAll(); },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component render (not a Route Handler/Server Action) — cookies()
          // is read-only there. Harmless as long as middleware.js is also refreshing the session
          // (it runs on every request and CAN write cookies), which it does below.
        }
      },
    },
  });
}
