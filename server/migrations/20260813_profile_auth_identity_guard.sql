-- Online Kahvem - profile auth identity guard (2026-08-13)
-- Prevent ghost profile rows: authenticated clients may only create/update the
-- profile row that matches their own auth.uid().

begin;

alter table public.profiles enable row level security;

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check (id::text = auth.uid()::text);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id::text = auth.uid()::text)
  with check (id::text = auth.uid()::text);

drop policy if exists profiles_select_authenticated on public.profiles;
create policy profiles_select_authenticated on public.profiles
  for select to authenticated
  using (true);

create table if not exists public.device_accounts (
  device_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  banned_until timestamptz,
  ban_reason text
);

alter table public.device_accounts enable row level security;
revoke all on public.device_accounts from anon, authenticated;

create or replace function public.bind_device_account(p_device_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_banned_until timestamptz;
  v_ban_reason text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if p_device_hash is null or p_device_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_device');
  end if;

  select user_id, banned_until, ban_reason
    into v_owner, v_banned_until, v_ban_reason
  from public.device_accounts
  where device_hash = p_device_hash
  for update;

  if v_banned_until is not null and v_banned_until > now() then
    return jsonb_build_object('ok', false, 'error', 'device_banned',
      'reason', coalesce(v_ban_reason, ''), 'until', v_banned_until);
  end if;

  if v_owner is not null and v_owner <> v_uid then
    return jsonb_build_object('ok', false, 'error', 'device_registered', 'owner', v_owner);
  end if;

  insert into public.device_accounts(device_hash, user_id)
  values (p_device_hash, v_uid)
  on conflict (device_hash) do update
    set last_seen_at = now()
    where public.device_accounts.user_id = excluded.user_id;

  return jsonb_build_object('ok', true, 'user_id', v_uid);
end;
$$;

revoke all on function public.bind_device_account(text) from public, anon;
grant execute on function public.bind_device_account(text) to authenticated;

commit;
