// Ad-hoc admin password reset (10 Aug 2026) — Michael forgot his password, and the in-app "Forgot
// password?" email link isn't landing on /set-password (it's dropping straight into the portal
// instead). Likely cause: the "Reset Password" email template in Supabase's dashboard was never
// updated to the custom {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=
// /set-password link the way the "Invite user" template was (see scripts/invite-user.js's setup
// comment, step 3) — so it's still using Supabase's default {{ .ConfirmationURL }}, which redirects
// to the plain Site URL (the portal) after confirming, never routing through /set-password at all.
// This script sidesteps that entirely: it sets a known password directly via the admin API
// (auth.admin.updateUserById), no email round-trip involved.
//
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/reset-password.js <email> <newPassword>
import { admin } from '../lib/supabaseAdmin.js';

const email = process.argv[2];
const newPassword = process.argv[3];
if (!email || !newPassword) {
  console.error('Usage: node scripts/reset-password.js <email> <newPassword>');
  process.exit(1);
}
if (newPassword.length < 8) {
  console.error('Password must be at least 8 characters (Supabase Auth default minimum).');
  process.exit(1);
}

// No admin.auth.admin.getUserByEmail() in supabase-js — list + find is the standard workaround.
const { data: list, error: listErr } = await admin.auth.admin.listUsers();
if (listErr) {
  console.error('Failed to list users:');
  console.error('  full:', JSON.stringify(listErr, Object.getOwnPropertyNames(listErr)));
  process.exit(1);
}

const user = list.users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`No user found with email ${email}. Users on file: ${list.users.map((u) => u.email).join(', ')}`);
  process.exit(1);
}

const { error: updateErr } = await admin.auth.admin.updateUserById(user.id, { password: newPassword });
if (updateErr) {
  console.error(`Failed to update password for ${email}:`);
  console.error('  message:', updateErr.message);
  console.error('  status:', updateErr.status);
  console.error('  code:', updateErr.code);
  console.error('  full:', JSON.stringify(updateErr, Object.getOwnPropertyNames(updateErr)));
  process.exit(1);
}

console.log(`Password updated for ${email}. Sign in with the new password now.`);
process.exit(0);
