export async function retryOnStatementTimeout(fn, attempts = 3, delayMs = 1500) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || '');
      const isTimeout = /statement timeout|canceling statement due to statement timeout/i.test(message);
      // ADDED 27 Jul 2026 (production-readiness audit): Supabase occasionally returns transient
      // Cloudflare 52x HTML error pages on otherwise-valid reads/writes (confirmed live during the
      // portal auto-update audit via 520/521 failures while the underlying data stayed intact). Those
      // failures have the same operational shape as the statement-timeout blips this helper already
      // mitigates: retrying the exact same query moments later often succeeds with no code/data
      // change. Keep the helper name for minimal churn, but broaden the retry condition so a single
      // transient 52x doesn't drop portal reads into mock-data fallback or strand refresh_log rows.
      const isTransientSupabaseEdge = /\b(?:520|521|522|523|524)\b|cloudflare|web server is down|unknown error/i.test(message);
      // ADDED 27 Jul 2026 (continued production-readiness audit): some Supabase client failures arrive
      // one layer earlier as transport-level fetch errors (`TypeError: fetch failed`, ECONNRESET,
      // ETIMEDOUT, ENOTFOUND, socket hang up, etc.) with no SQL error text at all. We observed this
      // exact shape during read-only payload checks while the same queries succeeded moments later
      // unchanged, so treat these as the same transient retry class rather than falling straight into
      // stale/mock fallback on the first blip.
      const isTransientTransport = /fetch failed|econnreset|etimedout|enotfound|socket hang up|network(?:error)?|connection reset|temporar(?:y|ily)|timeout of \d+ms exceeded/i.test(message);
      if ((!isTimeout && !isTransientSupabaseEdge && !isTransientTransport) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
