-- Restore account progression fields after the role/VIP entitlement unification.
-- Keeps admin/moderator/vip daily entitlement behavior, but again returns
-- level/xp/daily bonus data expected by the Unity daily reward screen.

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
  v_level int := 1;
begin
  if auth.uid() is null then
    return jsonb_build_object(
      'dow', v_dow,
      'week', v_week,
      'mask', 0,
      'chips', 0,
      'diamonds', 0,
      'vip_until', null,
      'vip_claimed_today', false,
      'vip_claimable_today', false,
      'daily_bonus_pct', public.account_daily_bonus_pct(1)
    ) || v_progress;
  end if;

  select * into r from public.profiles where id::text = v_uid;
  if not found then
    return jsonb_build_object(
      'dow', v_dow,
      'week', v_week,
      'mask', 0,
      'chips', 0,
      'diamonds', 0,
      'vip_until', null,
      'vip_claimed_today', false,
      'vip_claimable_today', false,
      'daily_bonus_pct', public.account_daily_bonus_pct(1)
    ) || v_progress;
  end if;

  if coalesce(r.daily_claim_week, '') = v_week then
    v_mask := greatest(0, least(coalesce(r.daily_claim_mask, 0), 127));
  end if;

  v_vip_active := coalesce(r.role, 'normal') in ('admin', 'moderator', 'vip')
    or (r.vip_until is not null and r.vip_until > now());
  v_vip_claimed := r.vip_last_daily = v_today and coalesce(r.vip_daily_day, 0) = v_dow;
  v_vip_claimable := v_vip_active
    and (v_mask & (1 << (v_dow - 1))) <> 0
    and not v_vip_claimed;

  v_progress := public.account_xp_progress(coalesce(r.account_xp_total, 0));
  v_level := coalesce((v_progress->>'level')::int, 1);

  return jsonb_build_object(
    'dow', v_dow,
    'week', v_week,
    'mask', v_mask,
    'chips', coalesce(r.chips, 0),
    'diamonds', coalesce(r.diamonds, 0),
    'vip_until', r.vip_until,
    'vip_claimed_today', v_vip_claimed,
    'vip_claimable_today', v_vip_claimable,
    'daily_bonus_pct', public.account_daily_bonus_pct(v_level)
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
  v_vip_active := coalesce(r.role, 'normal') in ('admin', 'moderator', 'vip')
    or (r.vip_until is not null and r.vip_until > now());
  v_vip_claimed := r.vip_last_daily = v_today and coalesce(r.vip_daily_day, 0) = v_dow;

  if v_normal_claimed then
    if not v_vip_active or v_vip_claimed then
      return jsonb_build_object('ok', false, 'error', 'already_claimed',
        'chips', coalesce(r.chips, 0), 'diamonds', coalesce(r.diamonds, 0),
        'daily_bonus_pct', v_bonus_pct)
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
    'level_bonus_chips', v_level_bonus_chips,
    'daily_bonus_pct', v_bonus_pct
  ) || v_progress;
end;
$$;

revoke execute on function public.get_daily_state() from public, anon;
revoke execute on function public.claim_daily(int) from public, anon;
grant execute on function public.get_daily_state() to authenticated;
grant execute on function public.claim_daily(int) to authenticated;
