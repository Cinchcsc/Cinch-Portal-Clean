// Shared fix (14 Jul 2026) for the same bug class found in scripts/invite-user.js and
// app/login|set-password/page.js: some errors (Supabase AuthError instances, node-soap faults) have
// an unhelpful .message (missing, or literally "{}" from an Error's non-enumerable properties being
// stringified) — logging just e.message alone can be a dead end when diagnosing a failed pull. This
// falls back to a fuller dump (status/code/name + every own property, enumerable or not) whenever the
// plain message looks unhelpful, so refresh_log/backfill error text is always actually diagnosable.
export function describeError(e) {
  const msg = e && e.message;
  const looksUnhelpful = !msg || msg === '{}' || msg === '[object Object]';
  if (!looksUnhelpful) return msg;
  let full = '';
  try { full = JSON.stringify(e, Object.getOwnPropertyNames(e || {})); } catch { full = String(e); }
  const details = [e?.status && `status ${e.status}`, e?.code && `code ${e.code}`].filter(Boolean).join(', ');
  return `Something went wrong${details ? ` (${details})` : ''} — ${full}`;
}
