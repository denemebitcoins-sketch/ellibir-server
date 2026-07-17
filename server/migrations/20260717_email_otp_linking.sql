-- Online Kahvem - server controlled 6 digit email OTP linking (2026-07-17)
-- Run once in Supabase SQL Editor. Safe to rerun.

create table if not exists public.email_link_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  purpose text not null default 'link' check (purpose in ('link')),
  code_hash text not null,
  attempts int not null default 0 check (attempts >= 0),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists email_link_codes_active_idx
  on public.email_link_codes (user_id, email, purpose, created_at desc)
  where consumed_at is null;

create index if not exists email_link_codes_expiry_idx
  on public.email_link_codes (expires_at)
  where consumed_at is null;

alter table public.email_link_codes enable row level security;
revoke all on public.email_link_codes from public, anon, authenticated;
grant select, insert, update, delete on public.email_link_codes to service_role;
