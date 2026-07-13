// Browser-side Supabase client for Client Components (login form, set-password form, logout button
// — task #202, 13 Jul 2026). Uses the ANON key, same as lib/supabaseServer.js — this is the ONLY
// Supabase key that's safe to ship to the browser (it's subject to RLS; the service-role key in
// lib/supabaseAdmin.js must never appear in any client-bundled file).
'use client';
import { createBrowserClient } from '@supabase/ssr';

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let client;
export function supabaseBrowser() {
  // Singleton (per Supabase's own guidance) — avoids re-creating the client (and its auth-state
  // listeners) on every re-render of whatever component calls this.
  if (!client) client = createBrowserClient(url, anonKey);
  return client;
}
