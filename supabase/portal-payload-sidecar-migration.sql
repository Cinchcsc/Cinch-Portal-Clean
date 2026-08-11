alter table portal_payload add column if not exists current_month text;
alter table portal_payload add column if not exists current_slice jsonb;
alter table portal_payload add column if not exists build_version text;
alter table portal_payload add column if not exists current_month_slice_version text;
