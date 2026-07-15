'use client';
// Task #202 (13 Jul 2026) — login form. Plain email+password against Supabase Auth; no self-service
// sign-up here on purpose (Michael's pick: invite-only via scripts/invite-user.js, not open signup —
// this is a private ops/JV portal, not a public product). "Forgot password" reuses the exact same
// invite/reset -> /auth/confirm -> /set-password path as a brand-new invite (see /set-password's own
// comment), so there's only one flow to maintain instead of two.
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabaseBrowser } from '../../lib/supabaseBrowser.js';

const C = { blue: '#2757E8', ink: '#101828', sub: '#667085', border: '#E4E7EC', red: '#D92D20', bg: '#F7F8FA' };

// Cloudflare Turnstile (15 Jul 2026, pentest finding: "no rate-limiting/CAPTCHA on login" — 6-8
// rapid fake login attempts all went through instantly with no throttling, confirmed against
// production both by Michael's friend and independently by me). Supabase's Attack Protection is the
// actual enforcement point (rejects signInWithPassword/resetPasswordForEmail server-side if the
// captchaToken is missing/invalid once enabled there) — this widget only obtains that token.
// Loaded as a plain <script> (not a React wrapper package) to avoid adding a new dependency for one
// widget. NEXT_PUBLIC_TURNSTILE_SITE_KEY is safe to ship client-side (it's the PUBLIC half — unlike
// the Secret Key, which only ever goes into Supabase's dashboard, never into this codebase).
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '';

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
  const [captchaToken, setCaptchaToken] = useState('');
  const turnstileRef = useRef(null);
  const widgetIdRef = useRef(null);

  // Mount the Turnstile script once, then render the widget into turnstileRef once the script's
  // global is ready. widgetIdRef lets us .reset() it after every submit — a token is single-use, and
  // a failed login (wrong password) would otherwise leave a spent token that the NEXT attempt can't
  // reuse, silently blocking retries with no visible error.
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    const renderWidget = () => {
      if (window.turnstile && turnstileRef.current && widgetIdRef.current == null) {
        widgetIdRef.current = window.turnstile.render(turnstileRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (token) => setCaptchaToken(token),
          'expired-callback': () => setCaptchaToken(''),
          'error-callback': () => setCaptchaToken(''),
        });
      }
    };
    if (window.turnstile) { renderWidget(); return; }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true; script.defer = true;
    script.onload = renderWidget;
    document.head.appendChild(script);
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setNotice(''); setBusy(true);
    const supabase = supabaseBrowser();
    try {
      if (mode === 'reset') {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}/auth/confirm?next=/set-password`,
          captchaToken: captchaToken || undefined,
        });
        if (err) throw err;
        setNotice('If that email has an account, a reset link is on its way — check your inbox.');
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password, options: { captchaToken: captchaToken || undefined } });
        if (err) throw err;
        router.push(redirectTo);
        router.refresh();
      }
    } catch (err) {
      // FIXED 14 Jul 2026: same class of bug as scripts/invite-user.js — some Supabase errors come
      // back with a message that isn't human-readable (e.g. literally "{}"), so showing err.message
      // alone can be a dead end. Append status/code when the message looks unhelpful, so there's
      // always something diagnosable on screen instead of just "{}".
      let msg = err.message === 'Invalid login credentials' ? 'Incorrect email or password.' : err.message;
      const looksUnhelpful = !msg || msg === '{}' || msg === '[object Object]';
      if (looksUnhelpful || err.status || err.code) {
        const details = [err.status && `status ${err.status}`, err.code && `code ${err.code}`].filter(Boolean).join(', ');
        msg = `${looksUnhelpful ? 'Something went wrong' : msg}${details ? ` (${details})` : ''}`;
      }
      setError(msg);
    } finally {
      setBusy(false);
      // Turnstile tokens are single-use — reset after every attempt (success or fail) so the widget
      // issues a fresh one for next time instead of silently failing on a spent token.
      if (window.turnstile && widgetIdRef.current != null) window.turnstile.reset(widgetIdRef.current);
      setCaptchaToken('');
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

        {TURNSTILE_SITE_KEY && <div ref={turnstileRef} style={{ marginBottom: '12px' }} />}

        {error && <div style={{ fontSize: '12px', color: C.red, marginBottom: '10px' }}>{error}</div>}
        {notice && <div style={{ fontSize: '12px', color: '#08875D', marginBottom: '10px' }}>{notice}</div>}

        <button
          type="submit" disabled={busy || (!!TURNSTILE_SITE_KEY && !captchaToken)}
          style={{ width: '100%', padding: '10px', fontSize: '13px', fontWeight: 600, color: '#fff', background: C.blue, border: 'none', borderRadius: '8px', cursor: (busy || (!!TURNSTILE_SITE_KEY && !captchaToken)) ? 'default' : 'pointer', opacity: (busy || (!!TURNSTILE_SITE_KEY && !captchaToken)) ? 0.7 : 1, marginTop: mode === 'reset' ? '4px' : '8px' }}
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
