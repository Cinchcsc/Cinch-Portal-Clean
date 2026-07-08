# Cinch Portal — Roadmap

Living plan for the portal rebuild. Updated 8 Jul 2026.

---

## Where things stand

**Built:** a full replacement portal (Next.js + Supabase) pulling live SiteLink data for all 29 sites —
Dashboard, KPIs, Financials, Ancillaries, Marketing, Unit Mix Detail, and Month-on-Month — each with
per-site and portfolio views, a store filter, and a date-range selector.

**This past week:** mostly line-by-line reconciliation against the legacy portal, screenshot by
screenshot. That caught a run of real bugs — True Revenue was double-counted, move-ins were overcounted
10x, rent figures had a rounding bug, a tax adjustment column read zero, a UI flash on the Financials
page, backwards color conventions on some cells. Also built infrastructure so future fixes are cheap:
raw SiteLink responses are now stored, so a parsing fix can be replayed against already-pulled data in
seconds instead of re-pulling for hours.

**Still open:** an active investigation into why "Merchandise Income per New Customer" reads far higher
than legacy (several theories ruled out, still narrowing it down), a handful of sites with residual Real
Rate errors even after the main formula fix, and full page-by-page audits not yet finished for
Financials, Ancillaries, Marketing, Unit Mix Detail, and the full Month-on-Month history. A few
historical backfills (old rent-roll gaps, delinquency history, lead_funnel for the two newest sites) are
also still in progress.

**Widgets:** the core set is built. The "vs last month" up/down arrow on totals rows is live on
Dashboard and Financials, still pending for Ancillaries, Marketing, and Unit Mix Detail.

**Automation:** the scheduled auto-pull is currently **off** — `vercel.json`'s cron list is empty. The
original design (see `GO_LIVE.md`/`README.md`) was one pull per day at 6am UK, capturing the last
complete month's data. It needs a guard against overlapping runs before being switched back on. Right
now, data only refreshes when someone runs a pull or reparse manually.

---

## New widgets & pages (requested 8 Jul 2026)

### 1. Move-in Variance vs Standard Rate — KPI page
Compare actual move-in rate against the standard/asking rate.
**Lead:** `ManagementSummary`'s raw response already contains a table called `VarFromStdRate` — found
during last week's multi-table audit, never extracted (only the largest table, `UnitActivity`, is read
today). Strong candidate source, sitting in data we already pull every month. Next step: dump that
table's actual columns to confirm before building. *(Task #133)*

### 2. Discount Summary — which discounts are in use, per store, by how many customers
**Lead:** same `ManagementSummary` response also contains unused `Discounts` and `Concessions` tables —
also found last week, also never extracted. Likely no new SiteLink report needed at all, just extracting
tables we already have. Next step: dump their columns to confirm shape before building.
*New nav page: "Discount Summary". (Task #134)*

### 3. Gross sqft in/out — KPI page
Today the KPI page shows move-in count, move-out count, and a single net sqft figure. Want gross sqft
moved in and gross sqft moved out separately, from the Move-Ins/Move-Outs report.
**Status:** easy — the parser already computes both `moved_in_area` and `moved_out_area` internally;
only the net (the difference) is currently surfaced further up the chain. Small, low-risk change.
*(Task #135)*

### 4. Marketing — Year-on-Year analysis
Current Marketing page shows month-on-month direction only; want something smarter with YoY figures.
**Open questions:** (a) how far back does clean per-site history actually go? Full historical backfill
was deferred earlier in the project, and a couple of sites still have known gaps — worth confirming
before designing around a full 12+ months everywhere. (b) what should "smart" mean here — YoY % by lead
channel, a rolling 12-month comparison, something else? Worth a short conversation before building.
*(Task #136)*

### 5. Daily Snapshot — enquiries, reservations, forward move-ins, sqft in/out for the previous day
**Checked the original brief on API timing** (`GO_LIVE.md`/`README.md`): the system was designed around
one pull per day, and SiteLink's reports already accept arbitrary date ranges — we've been relying on
that all week for month-to-date partial queries, so asking for "just yesterday" is not a SiteLink
limitation.

The real gap is on our side: auto-refresh is currently off entirely (empty cron list, see above), and
even when it's on, the existing pull only fetches "last complete month" and **overwrites** it — it never
keeps a distinct record per day. A real daily snapshot needs a small new table to store one row per day,
plus a lean daily pull job for just these four metrics. One platform constraint to design around: the
free Vercel plan caps a single scheduled job at ~60 seconds.

**Verdict: feasible, but it's a small infrastructure addition, not just a new page.**
*New nav page: "Weekly/Daily Snapshot". (Task #137)*

### 6. Same, but weekly/quarterly
Once daily snapshots are being stored, weekly and quarterly views are just rollups over those stored
days — no new data problem. The catch is a cold-start period: quarterly needs about 90 days of history
accumulated before it's meaningful, so it'll fill in gradually after daily snapshots go live.
*(Task #138, depends on #137)*

### 7. Occupancy bar chart by floor (%) — KPI page
**Flagged by Michael to double-check before building** — good instinct. Searched the whole codebase: no
floor-level field has turned up in anything we pull today (occupancy, rent roll, etc.). This is genuinely
unconfirmed territory. Next step: a live probe against SiteLink's unit-level report to check whether a
per-unit Floor field actually exists before committing to build anything. *(Task #139)*

---

## Suggested order

Roughly cheapest/most-confirmed first:

1. Gross sqft in/out (#3) — trivial, data already computed.
2. Move-in Variance vs Standard Rate (#1) and Discount Summary (#2) — same next step for both (dump the
   already-pulled `ManagementSummary` tables), likely fast once confirmed.
3. Occupancy by floor (#7) — one SiteLink probe to either unlock or rule out.
4. Marketing YoY (#4) — needs a quick data-coverage check + a short design conversation first.
5. Daily/Weekly/Quarterly Snapshot (#5, #6) — the biggest lift, since it's new infrastructure
   (storage table + new pull job) rather than a new view on existing data. Worth doing after the cron
   safety guard is in anyway.
