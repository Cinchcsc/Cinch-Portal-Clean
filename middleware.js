// Task #202 (13 Jul 2026, Michael: "password protect the site so each individual puts their own
// unique email and password into it"). Gates every page/API route behind a real Supabase Auth
// session, EXCEPT:
//   - /api/pull, /api/pull-snapshot, and /api/pull-cockpit — Vercel's own cron hits these directly
//     with no browser/cookies at all; they're already protected by their own CRON_SECRET bearer-token
//     check (see those route.js files). Gating them here too would just break the daily auto-update.
//   - /login and /auth/confirm — have to be reachable BEFORE a session exists (the login form itself,
//     and the invite/reset-link landing route that's the very thing that ESTABLISHES a session).
//     /set-password is deliberately NOT listed here: by the time a user reaches it, /auth/confirm has
//     already exchanged their invite/reset code and set real session cookies, so the normal gate below
//     lets them through anyway — and if someone hits /set-password with no valid session (a stale or
//     reused link), correctly bouncing them to /login is the right fallback, not silently allowing it.
// Uses supabase.auth.getUser() (not getSession()) — revalidates the token against Supabase's own
// server on every request rather than trusting a JWT that could be stale, matching Supabase's own
// documented guidance for middleware (the actual security boundary lives here, not in getSession()'s
// cheaper but unverified local read).
import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const CRON_PATHS = ['/api/pull', '/api/pull-snapshot', '/api/pull-cockpit'];
const PUBLIC_PATHS = ['/login', '/auth/confirm'];

export async function middleware(request) {
  const { pathname } = request.nextUrl;
  if (CRON_PATHS.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) return NextResponse.next();

  // Auth not configured yet (NEXT_PUBLIC_SUPABASE_ANON_KEY missing) — fail OPEN rather than lock
  // everyone out (including Michael) before the env var has been added in Vercel. Logged loudly so
  // this doesn't go unnoticed.
  if (!url || !anonKey) {
    console.warn('[middleware] NEXT_PUBLIC_SUPABASE_ANON_KEY not set — auth gate is DISABLED, portal is currently unprotected.');
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({ request });
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() { return request.cookies.getAll(); },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) supabaseResponse.cookies.set(name, value, options);
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const loginUrl = new URL('/login', request.url);
    if (pathname !== '/') loginUrl.searchParams.set('redirectTo', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
