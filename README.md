# Cinch Portal — live data backend (SiteLink → Supabase → portal)

A scheduled job pulls SiteLink reports into Supabase; the portal reads the result. **The SiteLink
credentials never touch the browser or chat — they live in Vercel, used only server-side.** No tenant
PII is stored, only aggregated per-site, per-month numbers.

```
SiteLink ReportingWs.asmx ──(daily pull, server-side)──► Supabase portal_payload ──(anon read)──► portal
```

## Files
- `supabase/schema.sql` — database tables + read security. Run once.
- `lib/sitelink.js` — SOAP client + auth (license key rides on username as `user:::key`).
- `lib/reportMap.js` — confirmed method per report + how to aggregate it.
- `lib/buildPayload.js` — assembles the JSON the portal reads.
- `lib/pull.js` — runs a refresh (all sites, this month + last). Default reports: occupancy + rent_roll.
- `app/api/pull/route.js` — endpoint Vercel cron calls.
- `vercel.json` — one cron at 05:00 UTC (= 6am UK in summer).
- `scripts/test-connection.js` — confirms creds, lists methods, prints the real response columns.
- `app/`, `next.config.mjs`, `package.json` — make it a deployable Next.js app that also serves the portal.

## What the API docs confirmed
- Reports are on **`ReportingWs.asmx`** (not CallCenterWs). All 13 methods we need exist.
- Auth = corp code + `username:::licenseKey` + password; API user needs the **"API All Reports"** right.
- **True Revenue (#781861) is NOT exposed by the API** — derive from FinancialSummary or keep manual.
- The doc doesn't list success **columns** — `npm run test:connection` prints them; then we lock the mapping.

## Go live
1. **Supabase** → SQL editor → run `supabase/schema.sql`.
2. **Vercel** → add the env vars from `.env.example` (SiteLink creds, locations, Supabase keys, a random `CRON_SECRET`). Deploy.
3. **Confirm columns:** `cp .env.example .env`, fill it, `npm install`, `npm run test:connection`. Send me the printed method check + columns → I finalise `reportMap.js`.
4. Trigger once via `/api/pull` (or `npm run pull`); check `refresh_log` = ok and `portal_payload` filled.
5. In `Cinch_Portal.html` set `LIVE = { url, anon }` → header flips to "Live data".

Occupancy widgets light up first; the rest follow as each method's columns are confirmed.
