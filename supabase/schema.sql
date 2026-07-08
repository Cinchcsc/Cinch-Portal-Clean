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

alter table portal_payload enable row level security;
alter table sites enable row level security;
alter table raw_report enable row level security;
alter table refresh_log enable row level security;

drop policy if exists "anon reads payload" on portal_payload;
create policy "anon reads payload" on portal_payload for select using (true);
drop policy if exists "anon reads sites" on sites;
create policy "anon reads sites" on sites for select using (true);
-- raw_report + refresh_log: RLS on, no anon policy => service-role only.

insert into portal_payload (id, payload) values (1, '{"sites":[],"reports":{},"months":[]}'::jsonb)
on conflict (id) do nothing;
