'use client';
// Task #202 (13 Jul 2026) — login form. Plain email+password against Supabase Auth; no self-service
// sign-up here on purpose (Michael's pick: invite-only via scripts/invite-user.js, not open signup —
// this is a private ops/JV portal, not a public product). "Forgot password" reuses the exact same
// invite/reset -> /auth/confirm -> /set-password path as a brand-new invite (see /set-password's own
// comment), so there's only one flow to maintain instead of two.
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabaseBrowser } from '../../lib/supabaseBrowser.js';

const C = { blue: '#2757E8', ink: '#101828', sub: '#667085', border: '#E4E7EC', red: '#D92D20', bg: '#F7F8FA' };

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = params.get('redirectTo') || '/portal-v2';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState('signin'); // 'signin' | 'reset'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(params.get('error') || '');
  const [notice, setNotice] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setNotice(''); setBusy(true);
    const supabase = supabaseBrowser();
    try {
      if (mode === 'reset') {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}/auth/confirm?next=/set-password`,
        });
        if (err) throw err;
        setNotice('If that email has an account, a reset link is on its way — check your inbox.');
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (err) throw err;
        router.push(redirectTo);
        router.refresh();
      }
    } catch (err) {
      setError(err.message === 'Invalid login credentials' ? 'Incorrect email or password.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg }}>
      <form onSubmit={submit} style={{ width: '340px', background: '#fff', border: `1px solid ${C.border}`, borderRadius: '12px', padding: '32px', boxShadow: '0 4px 16px rgba(16,24,40,.06)' }}>
        <div style={{ fontSize: '15px', fontWeight: 700, color: C.ink, marginBottom: '2px' }}>CINCH</div>
        <div style={{ fontSize: '11px', color: C.sub, letterSpacing: '.04em', marginBottom: '22px' }}>SELF STORAGE PORTAL</div>
        <div style={{ fontSize: '13px', fontWeight: 600, color: C.ink, marginBottom: '16px' }}>{mode === 'reset' ? 'Reset your password' : 'Sign in'}</div>

        <label style={{ display: 'block', fontSize: '12px', color: C.sub, marginBottom: '4px' }}>Email</label>
        <input
          type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          autoFocus autoComplete="email"
          style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', fontSize: '13px', borderRadius: '8px', border: `1px solid ${C.border}`, marginBottom: '14px', outline: 'none' }}
        />

        {mode === 'signin' && (
          <>
            <label style={{ display: 'block', fontSize: '12px', color: C.sub, marginBottom: '4px' }}>Password</label>
            <input
              type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', fontSize: '13px', borderRadius: '8px', border: `1px solid ${C.border}`, marginBottom: '6px', outline: 'none' }}
            />
          </>
        )}

        {error && <div style={{ fontSize: '12px', color: C.red, marginBottom: '10px' }}>{error}</div>}
        {notice && <div style={{ fontSize: '12px', color: '#08875D', marginBottom: '10px' }}>{notice}</div>}

        <button
          type="submit" disabled={busy}
          style={{ width: '100%', padding: '10px', fontSize: '13px', fontWeight: 600, color: '#fff', background: C.blue, border: 'none', borderRadius: '8px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1, marginTop: mode === 'reset' ? '4px' : '8px' }}
        >
          {busy ? 'Please wait…' : mode === 'reset' ? 'Send reset link' : 'Sign in'}
        </button>

        <div style={{ marginTop: '14px', textAlign: 'center' }}>
          <button
            type="button"
            onClick={() => { setMode(mode === 'reset' ? 'signin' : 'reset'); setError(''); setNotice(''); }}
            style={{ background: 'none', border: 'none', color: C.sub, fontSize: '12px', cursor: 'pointer', textDecoration: 'underline' }}
          >
            {mode === 'reset' ? 'Back to sign in' : 'Forgot password?'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
