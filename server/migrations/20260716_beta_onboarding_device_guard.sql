-- Ucretsiz beta karsilama bakiyesi ve cihaz-bazli tekrar talep korumasi.
-- Idempotenttir. Uygulama bu migration canlida calismadan grant yapmaz.

begin;

create table if not exists public.device_accounts (
  device_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  banned_until timestamptz,
  ban_reason text
);

create index if not exists device_accounts_user_idx
  on public.device_accounts(user_id);

alter table public.device_accounts enable row level security;
revoke all on public.device_accounts from anon, authenticated;

create table if not exists public.beta_welcome_claims (
  user_id uuid primary key references auth.users(id) on delete cascade,
  device_hash text not null unique,
  chips_granted bigint not null default 50000,
  diamonds_granted integer not null default 500,
  claimed_at timestamptz not null default now()
);

alter table public.beta_welcome_claims enable row level security;
revoke all on public.beta_welcome_claims from anon, authenticated;

create or replace function public.claim_beta_welcome(p_device_hash text)
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
  v_existing public.beta_welcome_claims%rowtype;
  v_chips bigint;
  v_diamonds integer;
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
    return jsonb_build_object('ok', false, 'error', 'device_registered');
  end if;

  insert into public.device_accounts(device_hash, user_id)
  values (p_device_hash, v_uid)
  on conflict (device_hash) do update
    set last_seen_at = now()
    where public.device_accounts.user_id = excluded.user_id;

  select * into v_existing
  from public.beta_welcome_claims
  where user_id = v_uid or device_hash = p_device_hash
  limit 1;

  if found then
    if v_existing.user_id <> v_uid or v_existing.device_hash <> p_device_hash then
      return jsonb_build_object('ok', false, 'error', 'device_registered');
    end if;
    select chips, diamonds into v_chips, v_diamonds
      from public.profiles where id::text = v_uid::text;
    return jsonb_build_object('ok', true, 'granted', false,
      'chips', coalesce(v_chips, 0), 'diamonds', coalesce(v_diamonds, 0));
  end if;

  if not exists (select 1 from public.profiles where id::text = v_uid::text) then
    return jsonb_build_object('ok', false, 'error', 'profile_missing');
  end if;

  insert into public.beta_welcome_claims(user_id, device_hash)
  values (v_uid, p_device_hash);

  update public.profiles
  set chips = greatest(coalesce(chips, 0), 50000),
      diamonds = greatest(coalesce(diamonds, 0), 500)
  where id::text = v_uid::text
  returning chips, diamonds into v_chips, v_diamonds;

  return jsonb_build_object('ok', true, 'granted', true,
    'chips', v_chips, 'diamonds', v_diamonds);
end;
$$;

revoke all on function public.claim_beta_welcome(text) from public, anon;
grant execute on function public.claim_beta_welcome(text) to authenticated;

commit;
