// Task #202 (13 Jul 2026, Michael: "password protect the site so each individual puts their own
// unique email and password into it"). Gates every page/API route behind a real Supabase Auth
// session, EXCEPT:
//   - The cron/API refresh routes — including the scheduled retry and hour-suffixed aliases Vercel
//     actually hits (`/api/pull-snapshot-retry`, `/api/pull-cockpit-retry`,
//     `/api/pull-floor-occupancy-retry`, `/api/rebuild-payload-05/-09/-14/-15`) — Vercel's own cron
//     hits these directly with no browser/cookies at all; they're already protected by their own
//     CRON_SECRET bearer-token check (see those route.js files). Gating them here too would just
//     break the daily auto-update.
//   - FIXED 20 Jul 2026: /api/rebuild-payload (task #297, added 17 Jul) was never added to this list
//     when it was created, so this middleware's catch-all matcher intercepted every cron invocation
//     FIRST, found no Supabase session (Vercel's cron request has no browser cookies), and returned
//     401 at line ~63 below — before the request ever reached the route's own CRON_SECRET check.
//     That made the route's auth logic entirely unreachable: every invocation 401'd regardless of
//     whether the correct secret was sent, which is why it looked identical to a misconfigured
//     secret. Confirmed via a live test: the SAME secret that correctly authenticates against
//     /api/pull-cockpit still 401'd against /api/rebuild-payload, which is only possible if something
//     upstream of that route's own check was rejecting it first. Zero refresh_log rows with
//     kind='rebuild' since deploy (3 days) is the direct consequence — runRebuildPayload() never got
//     the chance to run, so it never even reached the point of writing a 'running' row.
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

const CRON_PATHS = [
  '/api/pull',
  '/api/pull-snapshot',
  '/api/pull-snapshot-retry',
  '/api/pull-cockpit',
  '/api/pull-cockpit-retry',
  '/api/pull-floor-occupancy',
  '/api/pull-floor-occupancy-retry',
  '/api/rebuild-payload',
  '/api/rebuild-payload-05',
  '/api/rebuild-payload-09',
  '/api/rebuild-payload-14',
  '/api/rebuild-payload-15',
];
const PUBLIC_PATHS = ['/login', '/auth/confirm'];
const pathMatches = (pathname, base) => pathname === base || pathname.startsWith(`${base}/`);

export async function middleware(request) {
  const { pathname, search } = request.nextUrl;
  if (CRON_PATHS.some((p) => pathMatches(pathname, p))) return NextResponse.next();
  if (PUBLIC_PATHS.some((p) => pathMatches(pathname, p))) return NextResponse.next();
  const authHeader = request.headers.get('authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  // CHANGED 16 Jul 2026 (Michael's pentest ask, "penetrate it, i need to test security" — second,
  // independent pentest pass via Claude): this used to fail OPEN here (`return NextResponse.next()`),
  // meaning if NEXT_PUBLIC_SUPABASE_ANON_KEY/URL were ever missing or accidentally removed from
  // Vercel's env vars, the ENTIRE portal — every page, every /api/* route — would silently become
  // unauthenticated-readable to anyone, with only a server-side console.warn (which nobody watches
  // in real time) as the sole signal. Live-tested this same day: hitting /portal-v2 and /api/*
  // with no session cookie correctly redirects to /login / returns 401, which confirms these env
  // vars ARE present in production right now — so this change has ZERO effect on today's behavior.
  // It only changes what happens in the future if that config is ever lost: now it fails CLOSED
  // (blocks everything, same as "no valid user") instead of open (allows everything). A
  // misconfigured portal should go down, not go public.
  if (!url || !anonKey) {
    console.error('[middleware] NEXT_PUBLIC_SUPABASE_ANON_KEY/URL not set — auth gate cannot run, failing CLOSED (blocking all access) rather than exposing the portal unauthenticated.');
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Portal temporarily unavailable (auth misconfigured)' }, { status: 503 });
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

  let user = null;
  try {
    // Continued production hardening (10 Aug 2026): some deployed browser/API flows can end up with
    // a valid client-side Supabase session while an individual same-origin API request arrives
    // without the refreshed auth cookies middleware normally expects. Accept an explicit bearer token
    // from the signed-in portal fetch path as a second, equally revalidated proof of identity instead
    // of forcing the UI down its mock-data fallback when cookies alone are flaky.
    //
    // RE-ADDED 10 Aug 2026: this bearer-token path briefly lost the 28 Jul timeout race around
    // supabase.auth.getUser() when it was added — see this file's own removed comment (still in git
    // history) for the full incident: live, repeated 504 GATEWAY_TIMEOUT / Vercel's own
    // MIDDLEWARE_INVOCATION_TIMEOUT on /portal-v2 (3 of 4 attempts) with a hung, un-timed-out
    // getUser() call, confirmed live and fixed same day. Both calls below can independently hang the
    // same way, so both get the same race against a local timeout — a slow/stuck auth check now fails
    // the same CLOSED way an explicit auth error does (redirect to /login, or 401 for /api/*) instead
    // of hanging until Vercel's own platform timeout kills the function and shows a bare, unbranded
    // error page. 8s is comfortably above healthy latency and comfortably under Vercel's own ceiling.
    const AUTH_CHECK_TIMEOUT_MS = 8000;
    const withAuthTimeout = (promise) => Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`supabase.auth.getUser() timed out after ${AUTH_CHECK_TIMEOUT_MS}ms`)), AUTH_CHECK_TIMEOUT_MS);
      }),
    ]);
    let data = null;
    if (bearerToken) {
      const bearerResult = await withAuthTimeout(supabase.auth.getUser(bearerToken));
      data = bearerResult?.data || null;
      user = data?.user || null;
    }
    if (!user) {
      const cookieResult = await withAuthTimeout(supabase.auth.getUser());
      data = cookieResult?.data || null;
      user = data?.user || null;
    }
  } catch (error) {
    console.error('[middleware] supabase.auth.getUser failed or timed out — failing closed:', error?.message || error);
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const loginUrl = new URL('/login', request.url);
    if (pathname !== '/') loginUrl.searchParams.set('redirectTo', `${pathname}${search || ''}`);
    loginUrl.searchParams.set('error', 'Your session could not be verified — please sign in again.');
    return NextResponse.redirect(loginUrl);
  }

  if (!user) {
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const loginUrl = new URL('/login', request.url);
    if (pathname !== '/') loginUrl.searchParams.set('redirectTo', `${pathname}${search || ''}`);
    return NextResponse.redirect(loginUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
