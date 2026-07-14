// Task #175 — connectivity probe for lib/stortrack.js. Deliberately prints STRUCTURE only (top-level
// key names, array lengths, value TYPES) — never actual values — so Michael can safely paste the
// output here without exposing any account/pricing data or the key itself.
// Run:  cd cinch-portal-clean && node --env-file=.env scripts/test-stortrack.js
import { fetchDailyRates } from '../lib/stortrack.js';

function describeShape(v, depth = 0) {
  if (depth > 2) return typeof v;
  if (Array.isArray(v)) return `array(${v.length})${v.length ? ' of ' + describeShape(v[0], depth + 1) : ''}`;
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = describeShape(v[k], depth + 1);
    return out;
  }
  return typeof v; // 'string' / 'number' / 'boolean' — never the actual value
}

try {
  console.log('Calling StorTrack API (base URL + path from lib/stortrack.js — both still unconfirmed guesses)...');
  const data = await fetchDailyRates();
  console.log('SUCCESS. Response shape (structure only, no real values):');
  console.log(JSON.stringify(describeShape(data), null, 2));
} catch (e) {
  console.log('FAILED:', e.message);
  console.log('\nA 401/403 usually means the auth header guess (Authorization: Bearer) is wrong for');
  console.log('your account — tell me the real header name/format and I\'ll fix lib/stortrack.js.');
  console.log('A 404 usually means the base URL or path guess is wrong — tell me the real endpoint.');
}
process.exit(0);
