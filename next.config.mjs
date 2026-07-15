// SECURITY HEADERS (15 Jul 2026, pentest via Michael's friend + Claude — "Minor: missing CSP/
// X-Frame-Options headers"). CSP is scoped to what this app actually loads: Google Fonts
// (app/portal-v2/page.js's <link> tags), same-origin Next.js script/asset bundles, and the
// Supabase project URL (lib/supabaseBrowser.js's auth.* calls talk to it directly from the
// browser). style-src needs 'unsafe-inline' because this app renders inline style={{...}} on
// nearly every element plus one literal <style> tag with @keyframes — locking that down further
// would need a nonce wired through every render, not worth the risk of breaking styling right
// before go-live.
// FIXED 15 Jul 2026 (broke production — Michael: "portal wont show anything anymore, it shows a
// basic loading phase"): script-src originally shipped WITHOUT 'unsafe-inline', on the wrong
// assumption that Next's App Router only needs external same-origin <script src> files. It
// actually also emits inline <script>self.__next_f.push(...)</script> tags carrying the React
// Server Components streaming/hydration payload — confirmed by fetching the live page's own HTML
// and finding 4 of these per load, no nonce, no src attribute. With script-src blocking inline
// scripts, that payload never executes, so the app never finishes hydrating: the static shell
// paints but every client-side useEffect (including the one that fetches /api/portfolio) never
// runs — exactly the "stuck on the loading skeleton forever, no console errors, zero /api/*
// requests ever fired" symptom Michael hit. 'unsafe-inline' for script-src is a real, meaningful
// reduction in what CSP protects against (unlike style-src's version) — the correct long-term fix
// is a per-request nonce threaded through middleware.js + this inline script, but that's a bigger,
// riskier change to make blind right before go-live. Reinstate 'unsafe-inline' now to restore the
// app; revisit nonce-based hardening after Friday.
const SUPABASE_ORIGIN = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
// Cloudflare Turnstile (15 Jul 2026, login CAPTCHA — see app/login/page.js): loads its own script,
// renders its challenge inside an iframe, and makes its own XHR calls, all from
// challenges.cloudflare.com — needs allowances in script-src, frame-src, and connect-src.
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${TURNSTILE_ORIGIN}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  `connect-src 'self'${SUPABASE_ORIGIN ? ' ' + SUPABASE_ORIGIN : ' https://*.supabase.co'} ${TURNSTILE_ORIGIN}`,
  `frame-src ${TURNSTILE_ORIGIN}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // soap is a server-only Node package; keep it out of the client bundle (Next 14 key)
  experimental: { serverComponentsExternalPackages: ['soap'] },
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
};
export default nextConfig;
