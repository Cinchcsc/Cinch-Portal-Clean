// Task #202 (13 Jul 2026) — lands here from BOTH the invite email and the "forgot password" email
// (Supabase's own /login page reset flow points here too, with next=/set-password). Exchanges the
// token_hash+type from the email link for a real session (writing auth cookies via
// lib/supabaseServer.js), then sends the user on to `next` (defaults to /set-password so a
// brand-new/reset account always sets its own password before landing on the portal).
//
// IMPORTANT (Michael, one-time setup): Supabase's DEFAULT email templates link to Supabase's own
// hosted verify endpoint via {{ .ConfirmationURL }}, not to this route. For the invite/reset links to
// land here (so the SSR session cookie actually gets set and middleware.js recognizes it), the
// "Invite user" and "Reset Password" templates in Supabase Dashboard -> Authentication -> Email
// Templates need their link changed to:
//   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/set-password   (Invite user template)
//   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/set-password  (Reset Password template)
// and Authentication -> URL Configuration -> Site URL should be the deployed
// https://cinch-portal-clean.vercel.app (so {{ .SiteURL }} resolves correctly instead of localhost).
import { NextResponse } from 'next/server';
import { createClient } from '../../../lib/supabaseServer.js';

export async function GET(request) {
  const { searchParams, origin } = new URL(request.url);
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const next = searchParams.get('next') || '/set-password';

  if (token_hash && type) {
    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }
  const loginUrl = new URL('/login', origin);
  loginUrl.searchParams.set('error', 'That link is invalid or has expired — please request a new one.');
  return NextResponse.redirect(loginUrl);
}
