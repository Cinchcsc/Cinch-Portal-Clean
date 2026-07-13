# Cinch Portal Clean

Lean Next.js portal for Cinch reporting.

## What stays in this repo
- `app/` — live portal UI and API routes
- `lib/` — SiteLink pull, payload build, Supabase access
- `supabase/schema.sql` — database schema
- `scripts/` — operational maintenance scripts only

## Core commands
- `npm run dev` — local app on port `3001`
- `npm run build` — production build check
- `npm run pull` — run the main SiteLink pull
- `npm run pull:snapshot` — refresh the snapshot payload
- `npm run rebuild` — rebuild `portal_payload` from stored raw data
- `npm run rebuild:as-of -- 2026-06` — rebuild for a chosen month
- `npm run backfill` — backfill historical data
- `npm run reparse -- <report> [YYYY-MM]` — replay parser changes against stored raw responses
- `npm run repull:month -- <report> <YYYY-MM>` — repull one report/month
- `npm run repull:all -- <report>` — repull one report for every stored month
- `npm run check` — inspect the latest stored payload

## Setup
1. Point `.env` at valid SiteLink and Supabase credentials.
2. Run `supabase/schema.sql`.
3. Run `npm run test:connection`.
4. Run `npm run init:sites`.
5. Run `npm run pull`.

## Rollback
Pre-cleanup checkpoint branch:

`backup/pre-cleanup-2026-07-10`
