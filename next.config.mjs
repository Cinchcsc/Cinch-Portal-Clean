// SECURITY HEADERS (15 Jul 2026, pentest via Michael's friend + Claude — "Minor: missing CSP/
// X-Frame-Options headers"). CSP is scoped to what this app actually loads: Google Fonts
// (app/portal-v2/page.js's <link> tags), same-origin Next.js script/asset bundles, and the
// Supabase project URL (lib/supabaseBrowser.js's auth.* calls talk to it directly from the
// browser). style-src needs 'unsafe-inline' because this app renders inline style={{...}} on
// nearly every element plus one literal <style> tag with @keyframes — locking that down further
// would need a nonce wired through every render, not worth the risk of breaking styling right
// before go-live. script-src does NOT need 'unsafe-inline'/'unsafe-eval' — Next's production
// hydration bundles are same-origin external <script src> files.
const SUPABASE_ORIGIN = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  `connect-src 'self'${SUPABASE_ORIGIN ? ' ' + SUPABASE_ORIGIN : ' https://*.supabase.co'}`,
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
