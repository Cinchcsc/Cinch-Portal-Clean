// Task #202 (13 Jul 2026, Michael: invite-only accounts via Supabase's own invite-email flow, not
// self-service signup, not Michael manually setting/sharing passwords). Uses the SERVICE ROLE client
// (lib/supabaseAdmin.js) — inviteUserByEmail is an admin-only call, can't be done from the browser.
//
// ONE-TIME SETUP before the first invite (Supabase Dashboard):
//   1. Authentication -> URL Configuration -> Site URL = https://cinch-portal-clean.vercel.app
//      (and add it under "Redirect URLs" too, or the invite link will bounce with an error).
//   2. Authentication -> Email Templates -> "Invite user" -> change the link to:
//        {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/set-password
//      (replacing whatever default {{ .ConfirmationURL }} link is there) — see app/auth/confirm/
//      route.js's own comment for why this specific route+params matter.
//   3. Do the same for the "Reset Password" template, with type=recovery instead of type=invite.
//   4. Supabase's built-in email sender has a low rate limit meant for testing, not production volume
//      — fine for a handful of teammates, but if invites don't arrive or you're inviting more than a
//      few people at once, add your own SMTP provider under Authentication -> Settings -> SMTP.
//
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/invite-user.js someone@example.com
import { admin } from '../lib/supabaseAdmin.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/invite-user.js <email>');
  process.exit(1);
}

const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || 'https://cinch-portal-clean.vercel.app').replace(/\/+$/, '');

const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
  redirectTo: `${siteUrl}/set-password`,
});

if (error) {
  console.error(`Failed to invite ${email}:`, error.message);
  process.exit(1);
}

console.log(`Invited ${email} (user id: ${data.user.id}). They'll get an email with a link to set their password.`);
process.exit(0);
