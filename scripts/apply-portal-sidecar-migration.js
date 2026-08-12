import { readFile } from 'node:fs/promises';

function projectRefFromUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname;
    const match = host.match(/^([a-z0-9-]+)\.supabase\.co$/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const accessToken = String(process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_MANAGEMENT_TOKEN || '').trim();
if (!accessToken) {
  console.error('Missing SUPABASE_ACCESS_TOKEN (or SUPABASE_MANAGEMENT_TOKEN). This script uses the Supabase Management API, not the service-role key.');
  process.exit(1);
}

const projectRef = String(process.env.SUPABASE_PROJECT_REF || projectRefFromUrl(process.env.SUPABASE_URL) || '').trim();
if (!projectRef) {
  console.error('Could not determine the Supabase project ref. Set SUPABASE_PROJECT_REF or SUPABASE_URL.');
  process.exit(1);
}

const query = await readFile(new URL('../supabase/portal-payload-sidecar-migration.sql', import.meta.url), 'utf8');
if (!query.trim()) {
  console.error('Migration SQL file is empty: supabase/portal-payload-sidecar-migration.sql');
  process.exit(1);
}

const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    query,
    read_only: false,
  }),
});

const text = await response.text();
if (!response.ok) {
  console.error(`Supabase Management API request failed (${response.status} ${response.statusText}).`);
  if (text) console.error(text);
  process.exit(1);
}

console.log(`Applied portal_payload sidecar migration to project ${projectRef}.`);
if (text) console.log(text);
