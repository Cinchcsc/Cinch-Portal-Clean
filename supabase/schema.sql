-- Cinch Portal — Supabase schema. Run once in the Supabase SQL editor.
-- The server-side pull (service-role key) writes raw report rows + an assembled "portal_payload"
-- JSON. The portal reads ONLY portal_payload with the public anon key. No tenant PII stored —
-- only aggregated per-site, per-month metrics.

create table if not exists sites (
  code text primary key, name text, lat numeric, lng numeric, active boolean default true
);
-- REMOVED 15 Jul 2026 (Michael: "remove anything to do with manager") — this column was added 14 Jul
-- 2026 for the Facility Groups widget (task #174/#207), grouping sites by manager/team. Michael never
-- provided the site->manager mapping, Facility Groups was removed the same day it was flagged as
-- unused, and this column had no other reader (dead field). Drops it outright rather than leaving an
-- orphaned column around; safe to run against production even if the column doesn't exist yet.
alter table sites drop column if exists manager;

create table if not exists raw_report (
  id bigserial primary key,
  site_code text references sites(code),
  month date not null,
  report text not null,
  data jsonb not null,
  pulled_at timestamptz default now(),
  unique (site_code, month, report)
);
create index if not exists raw_report_lookup on raw_report (report, month);

-- ADDED 7 Jul 2026: stores the untouched SiteLink SOAP response (before extractRows()'s "biggest
-- table wins" pick and before reportMap.js's parse()), alongside the already-parsed `data` column.
-- Rationale: almost every "wrong number" bug found this session (Debtor Levels, Rate per ft² by
-- Customer Type, Move-ins/Move-outs, rounding, etc.) was a bug in OUR parsing logic, not in
-- SiteLink's underlying data — yet the only way to apply a fix to already-pulled historical months
-- was a full live re-pull (SiteLink API calls, ~1-3 hours for a 122-month x 27-site report), even
-- though SiteLink's answer for a closed month never changes. With the raw response stored, a parser
-- fix can instead be replayed locally via scripts/reparse-report.js — no SiteLink calls, seconds not
-- hours. Nullable because existing rows won't have it until backfilled by one more real pull.
alter table raw_report add column if not exists raw_response jsonb;

create table if not exists portal_payload (
  id int primary key default 1,
  generated_at timestamptz default now(),
  payload jsonb not null,
  constraint single_row check (id = 1)
);

create table if not exists refresh_log (
  id bigserial primary key,
  started_at timestamptz default now(),
  finished_at timestamptz,
  status text,
  detail text
);
-- ADDED 10 Jul 2026 (overlap guard, roadmap #93): distinguishes the main pull from the Weekly/Daily
-- Snapshot pull. Both share ONE lock (see lib/pullLock.js) since they hit the same SiteLink account —
-- existing rows all default to 'pull', which is correct, they're all from the main pull.
alter table refresh_log add column if not exists kind text not null default 'pull';

-- ADDED 9 Jul 2026: Autobill Conversion cross-references a month's move-ins against RentRoll's
-- autobill set, but RentRoll is a live "today only" snapshot (SiteLink has no true historical "as of"
-- RentRoll report — confirmed repeatedly). A single read is one point on a curve, not a stable monthly
-- figure. Confirmed legacy's own equivalent widget has the identical volatility (9 Jul 2026: switching
-- legacy's OWN date filter from Jul-MTD to Jun 2026 moved its Bicester reading 100% -> 54%, matching
-- neither of Michael's two prior readings) -- there is no stable number on either side to chase.
-- Michael's decision: average the ratio across every day the month is live, rather than freeze
-- whatever RentRoll said on the single day the month happened to close. One row per site per calendar
-- day, written only while that site's month is still the CURRENT (not yet locked) month — see
-- lib/pull.js. lib/buildPayload.js averages these once a month has any rows, and falls back to the
-- old single-point value for any month with none (everything before this table existed).
create table if not exists autobill_daily (
  id bigserial primary key,
  site_code text references sites(code),
  month date not null,
  sample_date date not null,
  autobill_new_count int not null,
  autobill_new_total int not null,
  pct numeric,
  pulled_at timestamptz default now(),
  unique (site_code, month, sample_date)
);
create index if not exists autobill_daily_lookup on autobill_daily (site_code, month);

-- ADDED 9 Jul 2026: Weekly/Daily/Quarterly Snapshot page (roadmap #5/#6). Deliberately NOT a
-- day-by-day accumulating table — Michael's decision was a live-style period query (daily = just
-- yesterday, weekly = last 7 days, quarterly = quarter-to-date), so this is a single overwritten
-- row exactly like portal_payload, refreshed by lib/pullSnapshot.js instead of a growing history
-- table. If a real day-by-day trend chart is wanted later, that's a schema change, not a data change
-- (SiteLink's reports already accept the narrower ranges — confirmed via probe-daily-granularity.js).
create table if not exists snapshot_payload (
  id int primary key default 1,
  generated_at timestamptz default now(),
  payload jsonb not null,
  constraint single_row check (id = 1)
);
alter table snapshot_payload enable row level security;
-- REMOVED 15 Jul 2026 — see the big comment block below ("SECURITY FIX") for why the "anon reads
-- snapshot" policy that used to sit here is gone rather than recreated.
insert into snapshot_payload (id, payload) values (1, '{"sites":[],"daily":null,"weekly":null,"quarterly":null}'::jsonb)
on conflict (id) do nothing;

alter table portal_payload enable row level security;
alter table sites enable row level security;
alter table raw_report enable row level security;
alter table refresh_log enable row level security;
alter table autobill_daily enable row level security;
-- autobill_daily: RLS on, no anon policy => service-role only, same as raw_report/refresh_log —
-- the frontend never queries it directly, only lib/buildPayload.js's averaged output.

-- SECURITY FIX (15 Jul 2026, pentest via Michael's friend + Claude): this file used to grant the
-- ANON role a `for select using (true)` policy on portal_payload/sites/snapshot_payload, from back
-- when the plan was "the portal reads these tables directly with the public anon key" (see this
-- file's original header comment). That plan changed early on — every real read today goes through
-- our own Next.js API routes (/api/portfolio, /api/snapshot, /api/cockpit, /api/floor-occupancy),
-- which use the SERVICE-ROLE key server-side (lib/supabaseAdmin.js) and bypass RLS entirely by
-- design. lib/supabaseBrowser.js (the only Supabase client ever shipped to the browser, necessarily
-- using the anon key since that's the only key safe to expose) is used ONLY for auth.* calls
-- (sign-in, sign-out, password reset) — grep confirms no page ever calls .from(...) on it.
-- So these SELECT-using-true policies had been leaving portal_payload/sites/snapshot_payload
-- completely readable to ANYONE holding the anon key (which is unavoidably public — it ships in
-- every page's client JS bundle) via Supabase's own REST API directly, with NO login required —
-- entirely bypassing task #202's app-level auth gate (middleware.js), since that gate only sits in
-- front of OUR Next.js routes, not Supabase's own PostgREST endpoint. Confirmed exploitable in
-- production by the pentest. Fix: drop the anon policies outright (do NOT recreate them) — RLS
-- stays enabled with zero matching policy for the anon/authenticated roles, same "service-role only"
-- posture already used correctly for raw_report/refresh_log/autobill_daily/unit_floor_status/
-- daily_financial_snapshot the whole time. Run this against production immediately:
--   drop policy if exists "anon reads payload" on portal_payload;
--   drop policy if exists "anon reads sites" on sites;
--   drop policy if exists "anon reads snapshot" on snapshot_payload;
-- (No anon INSERT/UPDATE/DELETE policy was ever defined on any table in this file, so writes should
-- already have been blocked by RLS's default-deny — but re-test that against production after
-- dropping the SELECT policies above, since it wasn't independently confirmed either way.)

insert into portal_payload (id, payload) values (1, '{"sites":[],"reports":{},"months":[]}'::jsonb)
on conflict (id) do nothing;

-- ADDED 10 Jul 2026: floor-level unit data for the Occupancy by Floor widget (roadmap #132/#139).
-- UnitStatus itself is NOT a callable SOAP method, so the initial path here was a manual export
-- from SiteLink's web UI (column P = Floor) loaded by scripts/import-unit-status.js. FOLLOW-UP
-- 21 Jul 2026: CallCenterWs.UnitsInformation was confirmed live to return iFloor/bRented/bRentable
-- plus dimensions, and scripts/import-units-information.js now imports this table directly from the
-- API. This is still a static unit-level snapshot, not a monthly time series like raw_report, so
-- re-importing a site just replaces its rows (upsert on site_code+unit_name). Read via
-- lib/floorOccupancy.js / /api/floor-occupancy, deliberately independent of buildPayload.js's
-- monthly pipeline -- same separation already used for snapshot_payload.
create table if not exists unit_floor_status (
  id bigserial primary key,
  site_code text references sites(code),
  unit_name text not null,
  unit_type text,
  floor int,
  area numeric,
  rentable boolean,
  occupied boolean,
  imported_at timestamptz default now(),
  unique (site_code, unit_name)
);
create index if not exists unit_floor_status_lookup on unit_floor_status (site_code);
alter table unit_floor_status enable row level security;
-- service-role only, same as raw_report -- the frontend never queries this directly, only via
-- lib/floorOccupancy.js's aggregated output.

-- ADDED 14 Jul 2026 (task #174/#207, Cockpit Charting — District Manager): DELIBERATELY an
-- ACCUMULATING table, one row per site per calendar day, unlike snapshot_payload's single
-- overwritten row. Cockpit's whole point is a day-by-day cumulative income-by-category line within
-- the current month vs a 3-month-average pace line — that needs a real growing time series, not a
-- live "as of right now" period query. Each day's row stores the MONTH-TO-DATE cumulative total as of
-- that day (one FinancialSummary call per site per day, range = [month start, today]) — so the full
-- daily curve builds up for free across the month from cheap, single-call-per-day snapshots, with no
-- need to ever re-pull the same day twice or make N calls for N days. See lib/pullCockpit.js.
create table if not exists daily_financial_snapshot (
  id bigserial primary key,
  site_code text references sites(code),
  snapshot_date date not null,
  total_charge numeric not null,
  total_payment numeric not null,
  total_credit numeric not null default 0,
  categories jsonb not null default '[]'::jsonb,
  pulled_at timestamptz default now(),
  unique (site_code, snapshot_date)
);
create index if not exists daily_financial_snapshot_lookup on daily_financial_snapshot (snapshot_date);
alter table daily_financial_snapshot enable row level security;
-- service-role only, same as raw_report/autobill_daily -- the frontend never queries this directly,
-- only via lib/pullCockpit.js's aggregated /api/cockpit output.

-- MIGRATION 17 Jul 2026 (task #312, Michael: "make the mom page's 1-month Revenue Collected view show
-- the current month, daily"): total_credit wasn't captured when this table was first built (only
-- total_charge/total_payment) even though REPORTS.financial.parse() already computes it -- Revenue
-- Collected everywhere else on the portal is Charge MINUS Credit (see buildPayload.js's
-- revenue.collected), so a daily version of that same metric needs total_credit too, not just
-- total_charge alone. Existing rows default to 0 (i.e. read as if no credits yet) since the raw
-- SiteLink response isn't kept anywhere for this daily pipeline (unlike raw_report, which stores
-- `raw_response` specifically so reparse-report.js can replay parser fixes) -- there is no way to
-- backfill total_credit for days already captured before this column existed. Run this against
-- production once (idempotent, safe to re-run):
alter table daily_financial_snapshot add column if not exists total_credit numeric not null default 0;
