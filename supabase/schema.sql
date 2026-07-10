-- Cinch Portal — Supabase schema. Run once in the Supabase SQL editor.
-- The server-side pull (service-role key) writes raw report rows + an assembled "portal_payload"
-- JSON. The portal reads ONLY portal_payload with the public anon key. No tenant PII stored —
-- only aggregated per-site, per-month metrics.

create table if not exists sites (
  code text primary key, name text, lat numeric, lng numeric, active boolean default true
);

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
drop policy if exists "anon reads snapshot" on snapshot_payload;
create policy "anon reads snapshot" on snapshot_payload for select using (true);
insert into snapshot_payload (id, payload) values (1, '{"sites":[],"daily":null,"weekly":null,"quarterly":null}'::jsonb)
on conflict (id) do nothing;

alter table portal_payload enable row level security;
alter table sites enable row level security;
alter table raw_report enable row level security;
alter table refresh_log enable row level security;
alter table autobill_daily enable row level security;
-- autobill_daily: RLS on, no anon policy => service-role only, same as raw_report/refresh_log —
-- the frontend never queries it directly, only lib/buildPayload.js's averaged output.

drop policy if exists "anon reads payload" on portal_payload;
create policy "anon reads payload" on portal_payload for select using (true);
drop policy if exists "anon reads sites" on sites;
create policy "anon reads sites" on sites for select using (true);
-- raw_report + refresh_log: RLS on, no anon policy => service-role only.

insert into portal_payload (id, payload) values (1, '{"sites":[],"reports":{},"months":[]}'::jsonb)
on conflict (id) do nothing;
