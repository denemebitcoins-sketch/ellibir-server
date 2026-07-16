-- Online Kahvem - free beta economy gates (2026-07-16)
-- Run once in Supabase SQL Editor. Safe to rerun.

begin;

create table if not exists public.app_features (
  key text primary key,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.app_feature_testers (
  feature_key text not null references public.app_features(key) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (feature_key, user_id)
);

insert into public.app_features(key, enabled) values
  ('shop', false),
  ('daily', false),
  ('economy_test', false)
on conflict (key) do nothing;

alter table public.app_features enable row level security;
alter table public.app_feature_testers enable row level security;
revoke all on table public.app_features from public, anon, authenticated;
revoke all on table public.app_feature_testers from public, anon, authenticated;

create or replace function public.has_app_feature(p_key text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or coalesce(trim(p_key), '') = '' then return false; end if;

  if exists (
    select 1 from public.profiles p
     where p.id::text = v_uid::text and p.role = 'admin'
  ) then
    return true;
  end if;

  return coalesce((select f.enabled from public.app_features f where f.key = p_key), false)
      or exists (
        select 1 from public.app_feature_testers t
         where t.feature_key = p_key and t.user_id = v_uid
      );
end;
$$;

create or replace function public.get_client_feature_flags()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'shop', public.has_app_feature('shop'),
    'daily', public.has_app_feature('daily')
  );
$$;

revoke execute on function public.has_app_feature(text) from public, anon, authenticated;
revoke execute on function public.get_client_feature_flags() from public, anon;
grant execute on function public.get_client_feature_flags() to authenticated;

-- Chip packages remain server-authoritative and are inaccessible during the free beta.
create or replace function public.buy_chip_package(p_package int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_chip_delta bigint;
  v_diamond_cost int;
  v_chips bigint;
  v_diamonds int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'auth_required');
  end if;
  if not public.has_app_feature('shop') then
    return jsonb_build_object('ok', false, 'error', 'beta_locked');
  end if;

  case p_package
    when 1 then v_chip_delta := 1000; v_diamond_cost := 2;
    when 2 then v_chip_delta := 3000; v_diamond_cost := 5;
    when 3 then v_chip_delta := 8000; v_diamond_cost := 10;
    else return jsonb_build_object('ok', false, 'error', 'invalid_package');
  end case;

  select coalesce(p.chips, 0), coalesce(p.diamonds, 0)
    into v_chips, v_diamonds
    from public.profiles p
   where p.id::text = v_uid::text
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'profile_missing');
  end if;
  if v_diamonds < v_diamond_cost then
    return jsonb_build_object(
      'ok', false, 'error', 'insufficient_diamonds',
      'chips', v_chips, 'diamonds', v_diamonds
    );
  end if;

  v_chips := v_chips + v_chip_delta;
  v_diamonds := v_diamonds - v_diamond_cost;
  update public.profiles
     set chips = v_chips,
         diamonds = v_diamonds,
         updated_at = now()
   where id::text = v_uid::text;

  return jsonb_build_object(
    'ok', true, 'error', '',
    'chips_delta', v_chip_delta, 'diamonds_delta', -v_diamond_cost,
    'chips', v_chips, 'diamonds', v_diamonds
  );
end;
$$;

-- This bridge has no Play receipt. It is deliberately stricter than the shop gate.
create or replace function public.buy_diamond_package_mock(p_package int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_diamond_delta int;
  v_chips bigint;
  v_diamonds int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'auth_required');
  end if;
  if not public.has_app_feature('economy_test') then
    return jsonb_build_object('ok', false, 'error', 'beta_locked');
  end if;

  case p_package
    when 1 then v_diamond_delta := 10;
    when 2 then v_diamond_delta := 50;
    when 3 then v_diamond_delta := 150;
    else return jsonb_build_object('ok', false, 'error', 'invalid_package');
  end case;

  select coalesce(p.chips, 0), coalesce(p.diamonds, 0)
    into v_chips, v_diamonds
    from public.profiles p
   where p.id::text = v_uid::text
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'profile_missing');
  end if;

  v_diamonds := v_diamonds + v_diamond_delta;
  update public.profiles
     set diamonds = v_diamonds,
         updated_at = now()
   where id::text = v_uid::text;

  return jsonb_build_object(
    'ok', true, 'error', '',
    'diamonds_delta', v_diamond_delta,
    'chips', v_chips, 'diamonds', v_diamonds
  );
end;
$$;

-- Daily reward writes are closed during the free beta even for old clients.
create or replace function public.claim_daily(p_day int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := auth.uid()::text;
  r record;
  v_today date := (now() at time zone 'Europe/Istanbul')::date;
  v_dow int := extract(isodow from (now() at time zone 'Europe/Istanbul'))::int;
  v_week text := to_char((now() at time zone 'Europe/Istanbul')::date, 'IYYY-IW');
  v_day_bit int := (1 << (v_dow - 1));
  v_mask int := 0;
  v_normal_chips bigint[] := array[250, 400, 600, 900, 1300, 1800, 2500];
  v_chips_delta bigint := 0;
  v_diamonds_delta int := 0;
  v_vip_active boolean := false;
  v_normal_claimed boolean := false;
  v_vip_claimed boolean := false;
  v_vip_only boolean := false;
begin
  if auth.uid() is null or p_day is null or p_day <> v_dow then
    return jsonb_build_object('ok', false, 'error', 'invalid_day');
  end if;
  if not public.has_app_feature('daily') then
    return jsonb_build_object('ok', false, 'error', 'beta_locked');
  end if;

  select * into r from public.profiles where id::text = v_uid for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'profile_not_found'); end if;

  if coalesce(r.daily_claim_week, '') = v_week then
    v_mask := greatest(0, least(coalesce(r.daily_claim_mask, 0), 127));
  end if;
  v_normal_claimed := (v_mask & v_day_bit) <> 0;
  v_vip_active := coalesce(r.role, 'normal') = 'admin' or (r.vip_until is not null and r.vip_until > now());
  v_vip_claimed := r.vip_last_daily = v_today and coalesce(r.vip_daily_day, 0) = v_dow;

  if v_normal_claimed then
    if not v_vip_active or v_vip_claimed then
      return jsonb_build_object('ok', false, 'error', 'already_claimed',
        'chips', coalesce(r.chips, 0), 'diamonds', coalesce(r.diamonds, 0));
    end if;
    v_chips_delta := 10000;
    v_diamonds_delta := 5;
    v_vip_only := true;
    update public.profiles
       set chips = coalesce(chips, 0) + v_chips_delta,
           diamonds = coalesce(diamonds, 0) + v_diamonds_delta,
           vip_daily_day = v_dow,
           vip_last_daily = v_today
     where id::text = v_uid
     returning chips, diamonds into r;
  else
    v_chips_delta := v_normal_chips[v_dow];
    v_diamonds_delta := case when v_dow = 7 then 2 else 0 end;
    if v_vip_active and not v_vip_claimed then
      v_chips_delta := v_chips_delta + 10000;
      v_diamonds_delta := v_diamonds_delta + 5;
    end if;
    update public.profiles
       set chips = coalesce(chips, 0) + v_chips_delta,
           diamonds = coalesce(diamonds, 0) + v_diamonds_delta,
           last_daily = v_today,
           daily_day = v_dow,
           daily_claim_week = v_week,
           daily_claim_mask = (v_mask | v_day_bit),
           vip_daily_day = case when v_vip_active and not v_vip_claimed then v_dow else vip_daily_day end,
           vip_last_daily = case when v_vip_active and not v_vip_claimed then v_today else vip_last_daily end
     where id::text = v_uid
     returning chips, diamonds into r;
  end if;

  return jsonb_build_object(
    'ok', true, 'chips_delta', v_chips_delta, 'diamonds_delta', v_diamonds_delta,
    'chips', coalesce(r.chips, 0), 'diamonds', coalesce(r.diamonds, 0), 'vip_only', v_vip_only
  );
end;
$$;

revoke execute on function public.buy_chip_package(int) from public, anon;
revoke execute on function public.buy_diamond_package_mock(int) from public, anon;
revoke execute on function public.claim_daily(int) from public, anon;
grant execute on function public.buy_chip_package(int) to authenticated;
grant execute on function public.buy_diamond_package_mock(int) to authenticated;
grant execute on function public.claim_daily(int) to authenticated;

-- Receipt-free VIP purchases stay unavailable to every client role.
revoke execute on function public.buy_vip_mock(int) from public, anon, authenticated;

commit;
