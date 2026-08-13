-- Online Kahvem - account progression core.
-- Source of truth is Supabase. Clients may read progression, but only the
-- Colyseus/server service role can grant XP.

alter table public.profiles add column if not exists account_level integer not null default 1;
alter table public.profiles add column if not exists account_xp_total bigint not null default 0;
alter table public.profiles add column if not exists account_xp_updated_at timestamptz;

update public.profiles
   set account_xp_total = greatest(coalesce(account_xp_total, 0), 0),
       account_level = greatest(1, least(coalesce(account_level, 1), 100));

alter table public.profiles drop constraint if exists profiles_account_level_range;
alter table public.profiles add constraint profiles_account_level_range
  check (account_level between 1 and 100) not valid;

alter table public.profiles drop constraint if exists profiles_account_xp_total_nonnegative;
alter table public.profiles add constraint profiles_account_xp_total_nonnegative
  check (account_xp_total >= 0) not valid;

alter table public.profiles validate constraint profiles_account_level_range;
alter table public.profiles validate constraint profiles_account_xp_total_nonnegative;

create table if not exists public.account_xp_events (
  id bigserial primary key,
  user_id text not null,
  event_key text not null,
  source text not null,
  game text,
  base_xp integer not null,
  multiplier numeric(6, 3) not null default 1.000,
  xp_awarded integer not null,
  level_before integer not null,
  level_after integer not null,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, event_key)
);

create index if not exists account_xp_events_user_created_idx
  on public.account_xp_events (user_id, created_at desc);
create index if not exists account_xp_events_source_created_idx
  on public.account_xp_events (source, created_at desc);

alter table public.account_xp_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'account_xp_events'
      and policyname = 'account_xp_events_select_own'
  ) then
    create policy account_xp_events_select_own on public.account_xp_events
      for select to authenticated using (user_id = auth.uid()::text);
  end if;
end $$;

revoke all on public.account_xp_events from public, anon, authenticated;
grant select on public.account_xp_events to authenticated;
revoke all on sequence public.account_xp_events_id_seq from public, anon, authenticated;

create or replace function public.account_xp_required_for_next(p_level integer)
returns bigint
language sql
immutable
as $$
  select case
    when coalesce(p_level, 1) >= 100 then 0
    when coalesce(p_level, 1) < 10 then (100 + coalesce(p_level, 1) * 35)::bigint
    when coalesce(p_level, 1) < 30 then (450 + (coalesce(p_level, 1) - 10) * 65)::bigint
    when coalesce(p_level, 1) < 60 then (1800 + (coalesce(p_level, 1) - 30) * 120)::bigint
    when coalesce(p_level, 1) < 90 then (5500 + (coalesce(p_level, 1) - 60) * 220)::bigint
    else (12500 + (coalesce(p_level, 1) - 90) * 450)::bigint
  end;
$$;

create or replace function public.account_level_for_xp(p_xp_total bigint)
returns integer
language plpgsql
immutable
as $$
declare
  v_left bigint := greatest(coalesce(p_xp_total, 0), 0);
  v_level integer := 1;
  v_need bigint;
begin
  while v_level < 100 loop
    v_need := public.account_xp_required_for_next(v_level);
    exit when v_need <= 0 or v_left < v_need;
    v_left := v_left - v_need;
    v_level := v_level + 1;
  end loop;
  return v_level;
end;
$$;

create or replace function public.account_daily_bonus_pct(p_level integer)
returns integer
language sql
immutable
as $$
  select case
    when coalesce(p_level, 1) >= 100 then 30
    when coalesce(p_level, 1) >= 75 then 25
    when coalesce(p_level, 1) >= 50 then 20
    when coalesce(p_level, 1) >= 35 then 15
    when coalesce(p_level, 1) >= 20 then 10
    when coalesce(p_level, 1) >= 10 then 5
    else 0
  end;
$$;

create or replace function public.account_xp_progress(p_xp_total bigint)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_total bigint := greatest(coalesce(p_xp_total, 0), 0);
  v_level integer := public.account_level_for_xp(v_total);
  v_spent bigint := 0;
  v_i integer;
  v_current bigint := 0;
  v_next bigint := 0;
begin
  if v_level > 1 then
    for v_i in 1..(v_level - 1) loop
      v_spent := v_spent + public.account_xp_required_for_next(v_i);
    end loop;
  end if;

  v_next := public.account_xp_required_for_next(v_level);
  v_current := case when v_level >= 100 then 0 else greatest(v_total - v_spent, 0) end;

  return jsonb_build_object(
    'level', v_level,
    'xp_total', v_total,
    'xp_current', v_current,
    'xp_next', v_next,
    'daily_bonus_pct', public.account_daily_bonus_pct(v_level)
  );
end;
$$;

create or replace function public.get_account_progression()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := auth.uid()::text;
  v_xp bigint := 0;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;

  select coalesce(account_xp_total, 0)
    into v_xp
    from public.profiles
   where id::text = v_uid;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'profile_not_found');
  end if;

  return jsonb_build_object('ok', true) || public.account_xp_progress(v_xp);
end;
$$;

create or replace function public.grant_account_xp(
  p_user_id text,
  p_source text,
  p_event_key text,
  p_base_xp integer,
  p_game text default null,
  p_context jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_event_id bigint;
  v_key text := left(coalesce(trim(p_event_key), ''), 180);
  v_source text := left(coalesce(trim(p_source), ''), 48);
  v_game text := nullif(left(coalesce(trim(p_game), ''), 32), '');
  v_base integer := greatest(1, least(coalesce(p_base_xp, 0), 5000));
  v_multiplier numeric(6, 3) := 1.000;
  v_awarded integer;
  v_total_after bigint;
  v_level_before integer;
  v_level_after integer;
  v_progress jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'service_role') then
    return jsonb_build_object('ok', false, 'error', 'service_role_required');
  end if;

  if coalesce(trim(p_user_id), '') = '' or v_key = '' or v_source = '' or coalesce(p_base_xp, 0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_args');
  end if;

  select *
    into r
    from public.profiles
   where id::text = p_user_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'profile_not_found');
  end if;

  v_level_before := public.account_level_for_xp(coalesce(r.account_xp_total, 0));

  if coalesce(r.role, 'normal') = 'admin'
     or coalesce(r.role, 'normal') = 'vip'
     or (r.vip_until is not null and r.vip_until > now()) then
    v_multiplier := 1.150;
  end if;

  v_awarded := greatest(1, floor(v_base * v_multiplier)::integer);

  insert into public.account_xp_events (
    user_id, event_key, source, game, base_xp, multiplier, xp_awarded,
    level_before, level_after, context
  )
  values (
    p_user_id, v_key, v_source, v_game, v_base, v_multiplier, v_awarded,
    v_level_before, v_level_before, coalesce(p_context, '{}'::jsonb)
  )
  on conflict (user_id, event_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    v_progress := public.account_xp_progress(coalesce(r.account_xp_total, 0));
    return jsonb_build_object('ok', true, 'duplicate', true, 'xp_awarded', 0) || v_progress;
  end if;

  v_total_after := coalesce(r.account_xp_total, 0) + v_awarded;
  v_level_after := public.account_level_for_xp(v_total_after);

  update public.profiles
     set account_xp_total = v_total_after,
         account_level = v_level_after,
         account_xp_updated_at = now()
   where id::text = p_user_id;

  update public.account_xp_events
     set level_after = v_level_after
   where id = v_event_id;

  v_progress := public.account_xp_progress(v_total_after);
  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'xp_awarded', v_awarded,
    'level_before', v_level_before,
    'level_after', v_level_after
  ) || v_progress;
end;
$$;

-- Reinstall daily reward RPCs so daily chip rewards receive the authoritative
-- account-level bonus. Diamonds do not scale with level.
create or replace function public.get_daily_state()
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
  v_mask int := 0;
  v_vip_active boolean := false;
  v_vip_claimed boolean := false;
  v_vip_claimable boolean := false;
  v_progress jsonb := public.account_xp_progress(0);
begin
  if auth.uid() is null then
    return jsonb_build_object('dow', v_dow, 'week', v_week, 'mask', 0, 'chips', 0, 'diamonds', 0,
      'vip_until', null, 'vip_claimed_today', false, 'vip_claimable_today', false)
      || v_progress;
  end if;

  select * into r from public.profiles where id::text = v_uid;
  if not found then
    return jsonb_build_object('dow', v_dow, 'week', v_week, 'mask', 0, 'chips', 0, 'diamonds', 0,
      'vip_until', null, 'vip_claimed_today', false, 'vip_claimable_today', false)
      || v_progress;
  end if;

  if coalesce(r.daily_claim_week, '') = v_week then
    v_mask := greatest(0, least(coalesce(r.daily_claim_mask, 0), 127));
  end if;

  v_vip_active := coalesce(r.role, 'normal') = 'admin' or (r.vip_until is not null and r.vip_until > now());
  v_vip_claimed := r.vip_last_daily = v_today and coalesce(r.vip_daily_day, 0) = v_dow;
  v_vip_claimable := v_vip_active
    and (v_mask & (1 << (v_dow - 1))) <> 0
    and not v_vip_claimed;
  v_progress := public.account_xp_progress(coalesce(r.account_xp_total, 0));

  return jsonb_build_object(
    'dow', v_dow,
    'week', v_week,
    'mask', v_mask,
    'chips', coalesce(r.chips, 0),
    'diamonds', coalesce(r.diamonds, 0),
    'vip_until', r.vip_until,
    'vip_claimed_today', v_vip_claimed,
    'vip_claimable_today', v_vip_claimable
  ) || v_progress;
end;
$$;

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
  v_progress jsonb := public.account_xp_progress(0);
  v_level int := 1;
  v_bonus_pct int := 0;
  v_level_bonus_chips bigint := 0;
begin
  if auth.uid() is null or p_day is null or p_day <> v_dow then
    return jsonb_build_object('ok', false, 'error', 'invalid_day');
  end if;
  if not public.has_app_feature('daily') then
    return jsonb_build_object('ok', false, 'error', 'beta_locked');
  end if;

  select * into r from public.profiles where id::text = v_uid for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'profile_not_found');
  end if;

  v_progress := public.account_xp_progress(coalesce(r.account_xp_total, 0));
  v_level := coalesce((v_progress->>'level')::int, 1);
  v_bonus_pct := public.account_daily_bonus_pct(v_level);

  if coalesce(r.daily_claim_week, '') = v_week then
    v_mask := greatest(0, least(coalesce(r.daily_claim_mask, 0), 127));
  end if;

  v_normal_claimed := (v_mask & v_day_bit) <> 0;
  v_vip_active := coalesce(r.role, 'normal') = 'admin' or (r.vip_until is not null and r.vip_until > now());
  v_vip_claimed := r.vip_last_daily = v_today and coalesce(r.vip_daily_day, 0) = v_dow;

  if v_normal_claimed then
    if not v_vip_active or v_vip_claimed then
      return jsonb_build_object('ok', false, 'error', 'already_claimed',
        'chips', coalesce(r.chips, 0), 'diamonds', coalesce(r.diamonds, 0))
        || v_progress;
    end if;

    v_chips_delta := 10000;
    v_diamonds_delta := 5;
    v_vip_only := true;
    v_level_bonus_chips := floor(v_chips_delta * v_bonus_pct / 100.0)::bigint;
    v_chips_delta := v_chips_delta + v_level_bonus_chips;

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
    v_level_bonus_chips := floor(v_chips_delta * v_bonus_pct / 100.0)::bigint;
    v_chips_delta := v_chips_delta + v_level_bonus_chips;

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
    'ok', true,
    'chips_delta', v_chips_delta,
    'diamonds_delta', v_diamonds_delta,
    'chips', coalesce(r.chips, 0),
    'diamonds', coalesce(r.diamonds, 0),
    'vip_only', v_vip_only,
    'level_bonus_pct', v_bonus_pct,
    'level_bonus_chips', v_level_bonus_chips
  ) || v_progress;
end;
$$;

-- Protect progression and other server-owned profile fields from client upserts.
create or replace function public.profiles_guard_client_sensitive()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  jwt_role text := coalesce(auth.role(), '');
  is_admin boolean := false;
begin
  if jwt_role = 'service_role' or current_user in ('postgres', 'service_role') then return new; end if;
  if auth.uid() is not null then is_admin := public.is_current_user_admin(); end if;

  -- Admin clients keep the existing moderation freedoms, but progression is
  -- still server-owned. A compromised/admin client cannot mint XP.
  if is_admin then
    if TG_OP = 'INSERT' then
      new.account_level := 1; new.account_xp_total := 0; new.account_xp_updated_at := null;
    elsif TG_OP = 'UPDATE' then
      new.account_level := old.account_level;
      new.account_xp_total := old.account_xp_total;
      new.account_xp_updated_at := old.account_xp_updated_at;
    end if;
    return new;
  end if;

  if TG_OP = 'INSERT' then
    new.chips := 5000; new.diamonds := 5;
    new.matches := 0; new.wins := 0; new.best_streak := 0; new.cur_streak := 0; new.total_won := 0;
    new.vip_until := null; new.last_daily := null; new.daily_day := 0;
    new.daily_claim_week := null; new.daily_claim_mask := 0;
    new.vip_daily_day := 0; new.vip_last_daily := null;
    new.account_level := 1; new.account_xp_total := 0; new.account_xp_updated_at := null;
    new.role := 'normal'; new.banned := false;
    new.chat_banned_until := null; new.message_banned_until := null; new.game_banned_until := null;
    new.avatar_status := 'visible';
  elsif TG_OP = 'UPDATE' then
    new.chips := old.chips; new.diamonds := old.diamonds;
    new.matches := old.matches; new.wins := old.wins; new.best_streak := old.best_streak;
    new.cur_streak := old.cur_streak; new.total_won := old.total_won;
    new.vip_until := old.vip_until; new.last_daily := old.last_daily; new.daily_day := old.daily_day;
    new.daily_claim_week := old.daily_claim_week; new.daily_claim_mask := old.daily_claim_mask;
    new.vip_daily_day := old.vip_daily_day; new.vip_last_daily := old.vip_last_daily;
    new.account_level := old.account_level;
    new.account_xp_total := old.account_xp_total;
    new.account_xp_updated_at := old.account_xp_updated_at;
    new.role := old.role; new.banned := old.banned;
    new.chat_banned_until := old.chat_banned_until;
    new.message_banned_until := old.message_banned_until;
    new.game_banned_until := old.game_banned_until;
    new.avatar_status := case when new.avatar_status = 'pending' then 'pending' else old.avatar_status end;
  end if;
  return new;
end;
$$;

revoke all on function public.account_xp_required_for_next(integer) from public, anon, authenticated;
grant execute on function public.account_xp_required_for_next(integer) to authenticated;

revoke all on function public.account_level_for_xp(bigint) from public, anon, authenticated;
grant execute on function public.account_level_for_xp(bigint) to authenticated;

revoke all on function public.account_daily_bonus_pct(integer) from public, anon, authenticated;
grant execute on function public.account_daily_bonus_pct(integer) to authenticated;

revoke all on function public.account_xp_progress(bigint) from public, anon, authenticated;
grant execute on function public.account_xp_progress(bigint) to authenticated;

revoke all on function public.get_account_progression() from public, anon;
grant execute on function public.get_account_progression() to authenticated;

revoke all on function public.grant_account_xp(text, text, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.grant_account_xp(text, text, text, integer, text, jsonb) to service_role;

revoke execute on function public.claim_daily(int) from public, anon;
grant execute on function public.get_daily_state() to authenticated;
grant execute on function public.claim_daily(int) to authenticated;
