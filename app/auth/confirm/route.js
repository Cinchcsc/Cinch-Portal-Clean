// Task #202 (13 Jul 2026) — lands here from BOTH the invite email and the "forgot password" email.
// Handles TWO different link shapes Supabase can produce, since which one shows up depends on how
// the email was sent, not something we fully control from here:
//
//   1. token_hash + type — what a CUSTOM email template pointed directly at this route produces (see
//      the one-time template setup note below). Exchanged via verifyOtp().
//   2. code — what Supabase's own DEFAULT templates produce for a browser-initiated flow (e.g.
//      "Forgot password" called from lib/supabaseBrowser.js): the email links to Supabase's own
//      hosted /auth/v1/verify endpoint first, which then redirects HERE with ?code=... (a PKCE auth
//      code) instead of token_hash/type. FIXED 14 Jul 2026 (Michael hit "invalid or expired" on every
//      reset link): this route only checked token_hash/type before, so it silently failed 100% of the
//      time for this link shape regardless of whether the code itself was valid. Exchanged via
//      exchangeCodeForSession() — confirmed via Supabase's own docs as the correct call for this flow.
//
// IMPORTANT (Michael, optional but recommended one-time setup): Supabase's default templates route
// through Supabase's own hosted page first (shape 2 above) — works now, but for the branded/direct
// link (shape 1), and to guarantee this route's cookie-writing runs directly rather than depending on
// Supabase's hosted redirect passing the right param, the "Invite user" and "Reset Password" templates
// in Supabase Dashboard -> Authentication -> Email Templates can be changed to link directly here:
//   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/set-password   (Invite user template)
//   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/set-password  (Reset Password template)
// NOTE: Supabase only allows editing template content/links while a custom SMTP provider is enabled —
// with custom SMTP off (built-in sender), templates are locked to the default and this route falls
// back to handling the `code` param above, which is why this is optional now, not required.
// Also set Authentication -> URL Configuration -> Site URL to the deployed
// https://cinch-portal-clean.vercel.app (so {{ .SiteURL }} resolves correctly instead of localhost).
import { NextResponse } from 'next/server';
import { createClient } from '../../../lib/supabaseServer.js';

export async function GET(request) {
  const { searchParams, origin } = new URL(request.url);
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const code = searchParams.get('code');
  const next = searchParams.get('next') || '/set-password';

  const supabase = createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  } else if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }
  const loginUrl = new URL('/login', origin);
  loginUrl.searchParams.set('error', 'That link is invalid or has expired — please request a new one.');
  return NextResponse.redirect(loginUrl);
}
