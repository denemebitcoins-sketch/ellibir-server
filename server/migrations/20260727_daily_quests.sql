-- ════════════════════════════════════════════════════════════════════════════
-- GÜNLÜK GÖREVLER (2026-07-27) — kişiselleştirilmiş havuz + deterministik atama
-- + sunucu-otoriteli ilerleme/ödül.
--   Atama: slot1 'q_play' (3 oyun oyna), slot2 'q_daily' (günlük ödülü al),
--   slot3 gün+user tohumuyla dönen havuzdan (kazan/hediye/sohbet/beğeni/reklam/keşif).
--   İlerleme: settleMatch (record_match_stats çağrı noktaları, server) + istemci sosyal olaylar.
--   Ödül: claim_daily_quest → profiles.chips += reward (security definer).
-- KULLANICI NOTU: bu dosyayı Supabase SQL editöründe ÇALIŞTIR (migration pattern).
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.daily_quest_progress (
  user_id  text   not null,
  day      date   not null,
  quest_id text   not null,
  progress int    not null default 0,
  target   int    not null,
  reward   bigint not null,
  claimed  boolean not null default false,
  payload  jsonb  not null default '{}'::jsonb,
  primary key (user_id, day, quest_id)
);

alter table public.daily_quest_progress enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'daily_quest_progress' and policyname = 'dqp_select_own'
  ) then
    create policy dqp_select_own on public.daily_quest_progress
      for select to authenticated using (user_id = auth.uid()::text);
  end if;
end $$;

-- Doğrudan yazma YOK: ilerleme yalnız security definer fonksiyonlarla.
revoke insert, update, delete on public.daily_quest_progress from public, anon, authenticated;

-- Kişisel görev metni için son oynanan oyun (istemci "Kendi oyunun (X)" diye gösterir).
alter table public.profiles add column if not exists last_game text;

-- ── Günün 3 görevini (yoksa) üret ────────────────────────────────────────────
create or replace function public.ensure_daily_quests(p_uid text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'Europe/Istanbul')::date;
  v_pool text[] := array['q_win', 'q_gift', 'q_chat', 'q_like', 'q_ad', 'q_explore'];
  v_third text;
begin
  if p_uid is null or p_uid = '' then return; end if;
  -- hashtext NEGATİF dönebilir → mod negatif indeks üretir, abs şart (quest_id null hatası).
  v_third := v_pool[(abs(hashtext(p_uid || v_day::text)) % array_length(v_pool, 1)) + 1];

  insert into public.daily_quest_progress (user_id, day, quest_id, target, reward)
  values
    (p_uid, v_day, 'q_play',  3, 500),
    (p_uid, v_day, 'q_daily', 1, 250),
    (p_uid, v_day, v_third,
      case v_third
        when 'q_win'     then 1 when 'q_gift' then 1 when 'q_chat' then 1
        when 'q_like'    then 1 when 'q_ad'   then 1 else 2 end,
      case v_third
        when 'q_win'     then 300 when 'q_gift' then 250 when 'q_chat' then 200
        when 'q_like'    then 200 when 'q_ad'   then 250 else 600 end)
  on conflict (user_id, day, quest_id) do nothing;
end;
$$;

-- ── Görev listesi (istemci bunu çağırır) ─────────────────────────────────────
create or replace function public.get_daily_quests()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := auth.uid()::text;
  v_last text;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  perform public.ensure_daily_quests(v_uid);
  select last_game into v_last from public.profiles where id::text = v_uid;
  return jsonb_build_object(
    'ok', true,
    'last_game', coalesce(v_last, ''),
    'quests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.quest_id, 'progress', q.progress, 'target', q.target,
        'reward', q.reward, 'claimed', q.claimed) order by q.quest_id)
      from public.daily_quest_progress q
      where q.user_id = v_uid and q.day = (now() at time zone 'Europe/Istanbul')::date
    ), '[]'::jsonb)
  );
end;
$$;

-- ── İlerleme olayı (istemci: sosyal/kolay türler + offline maçlar) ───────────
create or replace function public.quest_event(p_kind text, p_game text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := auth.uid()::text;
  v_day date := (now() at time zone 'Europe/Istanbul')::date;
  v_dow int := extract(isodow from (now() at time zone 'Europe/Istanbul'))::int;
  v_week text := to_char((now() at time zone 'Europe/Istanbul')::date, 'IYYY-IW');
  v_mask int;
  v_week_db text;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  perform public.ensure_daily_quests(v_uid);

  -- 'daily' olayı sunucuda doğrulanır: günlük ödül GERÇEKTEN alınmış olmalı.
  if p_kind = 'daily' then
    select daily_claim_week, daily_claim_mask into v_week_db, v_mask
      from public.profiles where id::text = v_uid;
    if coalesce(v_week_db, '') <> v_week or (coalesce(v_mask, 0) & (1 << (v_dow - 1))) = 0 then
      return jsonb_build_object('ok', false, 'error', 'daily_not_claimed');
    end if;
  end if;

  -- 'play' son oyunu işler (kişisel görev metni) + q_play/q_explore ilerletir.
  if p_kind = 'play' then
    if p_game is not null and p_game <> '' then
      update public.profiles set last_game = p_game where id::text = v_uid;
    end if;
    update public.daily_quest_progress
       set progress = least(target, progress + 1)
     where user_id = v_uid and day = v_day and quest_id = 'q_play' and progress < target;
    if p_game is not null and p_game <> '' then
      update public.daily_quest_progress
         set payload = case
               when payload->'games' ? p_game then payload
               else jsonb_set(payload, '{games}', coalesce(payload->'games', '[]'::jsonb) || to_jsonb(p_game))
             end,
             progress = least(target,
               jsonb_array_length(case
                 when payload->'games' ? p_game then payload->'games'
                 else coalesce(payload->'games', '[]'::jsonb) || to_jsonb(p_game) end))
       where user_id = v_uid and day = v_day and quest_id = 'q_explore' and progress < target;
    end if;
    return jsonb_build_object('ok', true);
  end if;

  update public.daily_quest_progress
     set progress = least(target, progress + 1)
   where user_id = v_uid and day = v_day and progress < target
     and quest_id = case p_kind
       when 'win'  then 'q_win'  when 'gift' then 'q_gift' when 'chat' then 'q_chat'
       when 'like' then 'q_like' when 'ad'   then 'q_ad'   when 'daily' then 'q_daily'
       else '' end;
  return jsonb_build_object('ok', true);
end;
$$;

-- ── İlerleme olayı (sunucu: settleMatch kancası — service_role only) ─────────
create or replace function public.quest_event_for(p_user_id text, p_kind text, p_game text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null or p_user_id = '' then return jsonb_build_object('ok', false); end if;
  perform public.ensure_daily_quests(p_user_id);
  -- Aynı gövde; auth bağımsız sürüm.
  if p_kind = 'play' then
    if p_game is not null and p_game <> '' then
      update public.profiles set last_game = p_game where id::text = p_user_id;
    end if;
    update public.daily_quest_progress
       set progress = least(target, progress + 1)
     where user_id = p_user_id and day = (now() at time zone 'Europe/Istanbul')::date
       and quest_id = 'q_play' and progress < target;
    if p_game is not null and p_game <> '' then
      update public.daily_quest_progress
         set payload = case
               when payload->'games' ? p_game then payload
               else jsonb_set(payload, '{games}', coalesce(payload->'games', '[]'::jsonb) || to_jsonb(p_game))
             end,
             progress = least(target,
               jsonb_array_length(case
                 when payload->'games' ? p_game then payload->'games'
                 else coalesce(payload->'games', '[]'::jsonb) || to_jsonb(p_game) end))
       where user_id = p_user_id and day = (now() at time zone 'Europe/Istanbul')::date
         and quest_id = 'q_explore' and progress < target;
    end if;
    return jsonb_build_object('ok', true);
  end if;
  update public.daily_quest_progress
     set progress = least(target, progress + 1)
   where user_id = p_user_id and day = (now() at time zone 'Europe/Istanbul')::date
     and progress < target
     and quest_id = case when p_kind = 'win' then 'q_win' else '' end;
  return jsonb_build_object('ok', true);
end;
$$;

-- ── Ödül alma ────────────────────────────────────────────────────────────────
create or replace function public.claim_daily_quest(p_quest_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := auth.uid()::text;
  v_day date := (now() at time zone 'Europe/Istanbul')::date;
  r record;
  v_chips bigint;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth'); end if;
  select * into r from public.daily_quest_progress
    where user_id = v_uid and day = v_day and quest_id = p_quest_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'quest_not_found'); end if;
  if r.claimed then return jsonb_build_object('ok', false, 'error', 'already_claimed'); end if;
  if r.progress < r.target then return jsonb_build_object('ok', false, 'error', 'not_complete'); end if;

  update public.daily_quest_progress set claimed = true
    where user_id = v_uid and day = v_day and quest_id = p_quest_id;
  update public.profiles set chips = coalesce(chips, 0) + r.reward
    where id::text = v_uid
    returning chips into v_chips;
  return jsonb_build_object('ok', true, 'reward', r.reward, 'chips', v_chips);
end;
$$;

-- ── Yetkiler ─────────────────────────────────────────────────────────────────
revoke all on function public.ensure_daily_quests(text) from public, anon, authenticated;
grant  execute on function public.ensure_daily_quests(text) to service_role;

revoke all on function public.get_daily_quests() from public, anon;
grant  execute on function public.get_daily_quests() to authenticated;

revoke all on function public.quest_event(text, text) from public, anon;
grant  execute on function public.quest_event(text, text) to authenticated;

revoke all on function public.quest_event_for(text, text, text) from public, anon, authenticated;
grant  execute on function public.quest_event_for(text, text, text) to service_role;

revoke all on function public.claim_daily_quest(text) from public, anon;
grant  execute on function public.claim_daily_quest(text) to authenticated;
