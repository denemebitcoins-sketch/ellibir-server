-- Online Kahvem - mail + PIN account recovery credentials (2026-08-19)
-- Service/Render owned. Clients never read or write this table directly.

begin;

create table if not exists public.account_recovery_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  pin_hash text not null,
  password_fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_recovered_at timestamptz,
  recovery_count integer not null default 0,
  check (email = lower(btrim(email))),
  check (length(pin_hash) >= 32),
  check (recovery_count >= 0)
);

create index if not exists account_recovery_credentials_email_idx
  on public.account_recovery_credentials(email);

alter table public.account_recovery_credentials enable row level security;
revoke all on public.account_recovery_credentials from public, anon, authenticated;
grant select, insert, update, delete on public.account_recovery_credentials to service_role;

alter table public.profiles
  add column if not exists recovery_secured_at timestamptz;

commit;
