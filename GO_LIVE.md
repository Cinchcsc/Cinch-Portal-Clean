# Get the Cinch Portal live & online — step by step

One GitHub repo → one Vercel app that serves the portal **and** pulls SiteLink into Supabase **daily at
6am UK**. Four stages: database, code on GitHub, deploy on Vercel, switch the data on.

> **Golden rule:** API keys/passwords go into the Supabase/Vercel screens — **never into chat.** I can't type them for you.

## Step 1 — Supabase (done if your 4 tables exist)
Supabase → **SQL Editor** → paste `supabase/schema.sql` → **Run**. Check **Table Editor** shows
`sites`, `raw_report`, `portal_payload`, `refresh_log`. From **Settings → API / Data API** copy the
**Project URL**, the **anon/publishable** key, and the **service_role** key.

## Step 2 — GitHub (get the code into your repo)
Use your existing **cinch portal** repo (empty is fine). In **GitHub Desktop**: clone it →
**Repository → Show in Finder** → copy **everything inside** `sitelink-backend/` (the `app`, `lib`,
`public`, `supabase` folders + `package.json`, `vercel.json`, etc.) into the cloned folder so they sit at
its **top level** → Commit → **Push**.
*If the homepage 404s after deploy, the files landed one level too deep — in Vercel set
**Settings → Build → Root Directory** to the sub-folder, or re-copy the contents to the top level.*

## Step 3 — Vercel (deploy + secrets)
Import the repo (detects Next.js). **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `SITELINK_WSDL` | `https://api.smdservers.net/CCWs_3.5/ReportingWs.asmx?WSDL` |
| `SITELINK_CORP_CODE` / `_CORP_USER` / `_CORP_PASSWORD` / `_LICENSE_KEY` | your SiteLink creds (API user needs "API All Reports" right) |
| `SITELINK_LOCATIONS` | `L001,L002,…,L027` |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | from Supabase |
| `CRON_SECRET` | a long random string you invent |

Deploy → open `your-app.vercel.app` (or `…/Cinch_Portal.html`). It shows **"Preview data"** until the pull runs.

## Step 4 — Switch the data on (we now have the API docs!)
1. On your computer in the repo: `cp .env.example .env`, fill the real values, `npm install`.
2. `npm run test:connection` — confirms login and prints the real **column names**.
3. **Send me that output** → I finalise the field mapping → you push.
4. Trigger a pull: open `your-app.vercel.app/api/pull` once (or `npm run pull`).
5. In `public/Cinch_Portal.html` set `LIVE = { url, anon }` to your Supabase URL + anon key → header shows **"Live data"**.

## Step 5 — Confirm
`refresh_log` newest row = **ok**; `portal_payload` has sites; portal occupancy widgets show all sites live.

### Notes
- Occupancy widgets go live first (occupancy + rent_roll). Others switch on as columns are confirmed.
- True Revenue (#781861) isn't in the API — derived from FinancialSummary or kept manual.
- Free Vercel plan caps a job ~60s; the default pull is just occupancy + rent_roll to stay fast.
