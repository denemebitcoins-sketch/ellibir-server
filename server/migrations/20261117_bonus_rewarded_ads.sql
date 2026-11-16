-- Online Kahvem - Bonus ödüllü reklamlar (2026-11-17)
--   match_end   : antrenman (bot) maçı sonu ödüllü GEÇİŞ reklamı → 5.000-10.000 çip (500'ün katı), günde 5
--   menu_bubble : ana menü ödül balonu (ödüllü reklam)        → 10.000-20.000 çip (1.000'in katı), günde 3, en az 2 saat arayla
-- Ödülü yine AdMob SSV → finalize_rewarded_ad verir (oturumun reward_chips'i); istemci para yazmaz.
-- "Kazan" (kind='chip') reklamının günlük sayacı/bekleme süresi YALNIZ kendi türünü sayar.
-- VIP'e reklam yok (admin hariç). Gün sınırı İstanbul saatiyle.

begin;

alter table public.rewarded_ad_sessions add column if not exists kind text not null default 'chip';
create index if not exists rewarded_ad_sessions_user_kind_created_idx
  on public.rewarded_ad_sessions(user_id, kind, created_at desc);

-- Mevcut "Kazan" fonksiyonları yalnız kind='chip' saysın (canlı tanım okunur, yalnız bu koşul eklenir).
do $mig$
declare d text; before text; r record;
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('begin_rewarded_ad', 'get_rewarded_ad_state')
  loop
    d := pg_get_functiondef(r.oid);
    before := d;
    d := replace(d, $a$and status in ('pending', 'credited');$a$,
                    $a$and status in ('pending', 'credited') and kind = 'chip';$a$);
    if d = before then raise exception '% : sayaç koşulu bulunamadı', r.proname; end if;
    execute d;
  end loop;
end
$mig$;

create or replace function public.bonus_reward_rules(p_kind text,
  out daily_limit integer, out min_gap_seconds integer, out reward_min integer, out reward_max integer, out reward_step integer)
language sql immutable as $$
  select case p_kind when 'match_end' then 5 when 'menu_bubble' then 3 else 0 end,
         case p_kind when 'match_end' then 60 when 'menu_bubble' then 7200 else 0 end,
         case p_kind when 'match_end' then 5000 when 'menu_bubble' then 10000 else 0 end,
         case p_kind when 'match_end' then 10000 when 'menu_bubble' then 20000 else 0 end,
         case p_kind when 'match_end' then 500 when 'menu_bubble' then 1000 else 1 end;
$$;

create or replace function public.get_bonus_reward_state(p_kind text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_role text; v_vip timestamptz;
  v_rules record; v_used integer; v_last timestamptz; v_wait integer := 0;
  v_day_start timestamptz := (date_trunc('day', now() at time zone 'Europe/Istanbul')) at time zone 'Europe/Istanbul';
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'auth_required'); end if;
  select * into v_rules from public.bonus_reward_rules(p_kind);
  if v_rules.daily_limit <= 0 then return jsonb_build_object('ok', false, 'error', 'invalid_kind'); end if;
  select coalesce(role, 'normal'), vip_until into v_role, v_vip from public.profiles where id::text = v_uid::text;
  if v_role <> 'admin' and (v_role = 'vip' or (v_vip is not null and v_vip > now())) then
    return jsonb_build_object('ok', false, 'error', 'vip_no_ads');
  end if;
  update public.rewarded_ad_sessions set status = 'expired'
   where user_id = v_uid and kind = p_kind and status = 'pending' and expires_at <= now();
  select count(*)::integer, max(created_at) into v_used, v_last
    from public.rewarded_ad_sessions
   where user_id = v_uid and kind = p_kind and created_at >= v_day_start and status in ('pending', 'credited');
  if v_last is not null then
    v_wait := greatest(0, ceil(extract(epoch from ((v_last + make_interval(secs => v_rules.min_gap_seconds)) - now())))::integer);
  end if;
  return jsonb_build_object('ok', true, 'used', v_used, 'remaining', greatest(0, v_rules.daily_limit - v_used),
    'cooldown_seconds', v_wait, 'reward_min', v_rules.reward_min, 'reward_max', v_rules.reward_max);
end;
$$;

create or replace function public.begin_bonus_rewarded_ad(p_device_hash text, p_kind text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_state jsonb; v_rules record; v_reward integer; v_session uuid; v_steps integer;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'auth_required'); end if;
  if coalesce(length(trim(p_device_hash)), 0) < 16 then return jsonb_build_object('ok', false, 'error', 'device_required'); end if;
  v_state := public.get_bonus_reward_state(p_kind);
  if not coalesce((v_state->>'ok')::boolean, false) then return v_state; end if;
  if (v_state->>'remaining')::integer <= 0 then
    return v_state || jsonb_build_object('ok', false, 'error', 'daily_limit');
  end if;
  if (v_state->>'cooldown_seconds')::integer > 0 then
    return v_state || jsonb_build_object('ok', false, 'error', 'cooldown');
  end if;
  select * into v_rules from public.bonus_reward_rules(p_kind);
  v_steps := (v_rules.reward_max - v_rules.reward_min) / v_rules.reward_step;
  v_reward := v_rules.reward_min + floor(random() * (v_steps + 1))::integer * v_rules.reward_step;
  insert into public.rewarded_ad_sessions(user_id, device_hash, reward_chips, kind)
  values (v_uid, trim(p_device_hash), v_reward, p_kind) returning id into v_session;
  return jsonb_build_object('ok', true, 'session_id', v_session::text, 'custom_data', v_session::text,
    'reward_chips', v_reward, 'used', (v_state->>'used')::integer + 1,
    'remaining', greatest(0, (v_state->>'remaining')::integer - 1), 'cooldown_seconds', 0);
end;
$$;

-- Tanıtım ekranında VAZGEÇ / reklam açılamadı: oturum günlük hakkı yemesin.
create or replace function public.cancel_bonus_rewarded_ad(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth_required'); end if;
  update public.rewarded_ad_sessions set status = 'expired'
   where id = p_session_id and user_id = auth.uid() and status = 'pending' and kind <> 'chip';
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.bonus_reward_rules(text) from public, anon;
grant execute on function public.bonus_reward_rules(text) to authenticated, service_role;
revoke all on function public.get_bonus_reward_state(text) from public, anon;
grant execute on function public.get_bonus_reward_state(text) to authenticated;
revoke all on function public.begin_bonus_rewarded_ad(text, text) from public, anon;
grant execute on function public.begin_bonus_rewarded_ad(text, text) to authenticated;
revoke all on function public.cancel_bonus_rewarded_ad(uuid) from public, anon;
grant execute on function public.cancel_bonus_rewarded_ad(uuid) to authenticated;

commit;
