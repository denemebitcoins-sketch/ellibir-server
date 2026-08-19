-- Account deletion guard: stores only a server-HMAC device fingerprint.
-- No profile id, e-mail, name, raw device hash, balance or message content is kept here.

begin;

create table if not exists public.deleted_device_fingerprints (
  fingerprint_hash text primary key,
  first_deleted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delete_count integer not null default 1,
  check (fingerprint_hash ~ '^[0-9a-f]{64}$'),
  check (delete_count > 0)
);

alter table public.deleted_device_fingerprints enable row level security;
revoke all on public.deleted_device_fingerprints from public, anon, authenticated;
grant select, insert, update, delete on public.deleted_device_fingerprints to service_role;

commit;
