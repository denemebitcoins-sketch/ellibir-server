-- Online Kahvem - Rewarded ad daily stepped rewards
-- Rewards reset daily: 1000, 1250, 1500, 1750, 2000 chips.

begin;

create or replace function public.rewarded_ad_chips_for_index(p_used_before integer)
returns integer
language sql
immutable
as $$
  select case
    when coalesce(p_used_before, 0) <= 0 then 1000
    when p_used_before = 1 then 1250
    when p_used_before = 2 then 1500
    when p_used_before = 3 then 1750
    when p_used_before = 4 then 2000
    else 0
  end;
$$;

alter table public.rewarded_ad_sessions
  alter column reward_chips set default 1000;

create or replace function public.begin_rewarded_ad(p_device_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_vip_until timestamptz;
  v_used integer;
  v_last timestamptz;
  v_session uuid;
  v_wait integer;
  v_reward integer;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'auth_required'); end if;
  if coalesce(length(trim(p_device_hash)), 0) < 16 then
    return jsonb_build_object('ok', false, 'error', 'device_required');
  end if;

  select coalesce(role, 'normal'), vip_until
    into v_role, v_vip_until
    from public.profiles where id::text = v_uid::text;
  if v_role <> 'admin' and (v_role = 'vip' or (v_vip_until is not null and v_vip_until > now())) then
    return jsonb_build_object('ok', false, 'error', 'vip_no_ads');
  end if;

  update public.rewarded_ad_sessions
     set status = 'expired'
   where user_id = v_uid and status = 'pending' and expires_at <= now();

  select count(*)::integer, max(created_at)
    into v_used, v_last
    from public.rewarded_ad_sessions
   where user_id = v_uid
     and created_at >= date_trunc('day', now())
     and status in ('pending', 'credited');

  if v_used >= 5 then
    return jsonb_build_object('ok', false, 'error', 'daily_limit', 'used', v_used,
      'remaining', 0, 'cooldown_seconds', 0, 'reward_chips', 0);
  end if;

  v_wait := greatest(0, ceil(extract(epoch from ((v_last + interval '15 minutes') - now())))::integer);
  if v_last is not null and v_wait > 0 then
    return jsonb_build_object('ok', false, 'error', 'cooldown', 'used', v_used,
      'remaining', greatest(0, 5 - v_used), 'cooldown_seconds', v_wait,
      'reward_chips', public.rewarded_ad_chips_for_index(v_used));
  end if;

  v_reward := public.rewarded_ad_chips_for_index(v_used);
  insert into public.rewarded_ad_sessions(user_id, device_hash, reward_chips)
  values (v_uid, trim(p_device_hash), v_reward) returning id into v_session;

  return jsonb_build_object('ok', true, 'session_id', v_session::text,
    'custom_data', v_session::text, 'used', v_used,
    'remaining', greatest(0, 4 - v_used), 'cooldown_seconds', 0,
    'reward_chips', v_reward);
end;
$$;

create or replace function public.get_rewarded_ad_state(p_session_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_reward bigint := 0;
  v_used integer := 0;
  v_last timestamptz;
  v_wait integer := 0;
  v_chips bigint := 0;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'auth_required'); end if;
  if p_session_id is not null then
    select status, reward_chips into v_status, v_reward
      from public.rewarded_ad_sessions where id = p_session_id and user_id = v_uid;
  end if;
  select count(*)::integer, max(created_at)
    into v_used, v_last
    from public.rewarded_ad_sessions
   where user_id = v_uid and created_at >= date_trunc('day', now())
     and status in ('pending', 'credited');
  if v_last is not null then
    v_wait := greatest(0, ceil(extract(epoch from ((v_last + interval '15 minutes') - now())))::integer);
  end if;
  select coalesce(chips, 0) into v_chips
    from public.profiles where id::text = v_uid::text;
  return jsonb_build_object('ok', true, 'status', coalesce(v_status, ''),
    'credited', v_status = 'credited',
    'reward_chips', case when v_reward > 0 then v_reward else public.rewarded_ad_chips_for_index(v_used) end,
    'chips', v_chips, 'used', v_used, 'remaining', greatest(0, 5 - v_used),
    'cooldown_seconds', v_wait);
end;
$$;

revoke all on function public.rewarded_ad_chips_for_index(integer) from public, anon;
grant execute on function public.rewarded_ad_chips_for_index(integer) to authenticated, service_role;
revoke all on function public.begin_rewarded_ad(text) from public, anon;
grant execute on function public.begin_rewarded_ad(text) to authenticated;
revoke all on function public.get_rewarded_ad_state(uuid) from public, anon;
grant execute on function public.get_rewarded_ad_state(uuid) to authenticated;

commit;
