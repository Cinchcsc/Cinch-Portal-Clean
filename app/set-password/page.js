'use client';
// Task #202 (13 Jul 2026) — lands here after /auth/confirm exchanges an invite or password-reset
// link for a real (temporary) session. Sets the user's actual password via supabase.auth.updateUser()
// while that session is active, then sends them into the portal. If someone reaches this page with NO
// active session (stale bookmark, link opened twice, etc.) there's nothing to update against, so it
// bounces to /login instead of showing a form that can't work.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '../../lib/supabaseBrowser.js';

const C = { blue: '#2757E8', ink: '#101828', sub: '#667085', border: '#E4E7EC', red: '#D92D20', bg: '#F7F8FA' };

export default function SetPasswordPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const supabase = supabaseBrowser();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) router.replace('/login?error=' + encodeURIComponent('That link is invalid or has expired — please request a new one.'));
      else { setHasSession(true); setChecking(false); }
    });
  }, [router]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    const supabase = supabaseBrowser();
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (err) {
      // Same fix as app/login/page.js (14 Jul 2026): some Supabase auth errors have an unhelpful
      // .message (e.g. literally "{}"), so fall back to status/code instead of a dead-end message.
      let msg = err.message;
      const looksUnhelpful = !msg || msg === '{}' || msg === '[object Object]';
      if (looksUnhelpful || err.status || err.code) {
        const details = [err.status && `status ${err.status}`, err.code && `code ${err.code}`].filter(Boolean).join(', ');
        msg = `${looksUnhelpful ? 'Something went wrong' : msg}${details ? ` (${details})` : ''}`;
      }
      return setError(msg);
    }
    router.push('/portal-v2');
    router.refresh();
  };

  if (checking || !hasSession) return null;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg }}>
      <form onSubmit={submit} style={{ width: '340px', background: '#fff', border: `1px solid ${C.border}`, borderRadius: '12px', padding: '32px', boxShadow: '0 4px 16px rgba(16,24,40,.06)' }}>
        <div style={{ fontSize: '15px', fontWeight: 700, color: C.ink, marginBottom: '2px' }}>CINCH</div>
        <div style={{ fontSize: '11px', color: C.sub, letterSpacing: '.04em', marginBottom: '22px' }}>SELF STORAGE PORTAL</div>
        <div style={{ fontSize: '13px', fontWeight: 600, color: C.ink, marginBottom: '16px' }}>Set your password</div>

        <label style={{ display: 'block', fontSize: '12px', color: C.sub, marginBottom: '4px' }}>New password</label>
        <input
          type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
          autoFocus autoComplete="new-password"
          style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', fontSize: '13px', borderRadius: '8px', border: `1px solid ${C.border}`, marginBottom: '14px', outline: 'none' }}
        />
        <label style={{ display: 'block', fontSize: '12px', color: C.sub, marginBottom: '4px' }}>Confirm password</label>
        <input
          type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', fontSize: '13px', borderRadius: '8px', border: `1px solid ${C.border}`, marginBottom: '6px', outline: 'none' }}
        />

        {error && <div style={{ fontSize: '12px', color: C.red, margin: '4px 0 10px' }}>{error}</div>}

        <button
          type="submit" disabled={busy}
          style={{ width: '100%', padding: '10px', fontSize: '13px', fontWeight: 600, color: '#fff', background: C.blue, border: 'none', borderRadius: '8px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1, marginTop: '8px' }}
        >
          {busy ? 'Saving…' : 'Save & continue'}
        </button>
      </form>
    </div>
  );
}
