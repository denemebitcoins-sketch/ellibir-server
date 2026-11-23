-- 24.11: Günlük görev ödülleri ×~5 (kullanıcı kararı): günde toplam 5.000 çip.
--   q_daily (günlük ödülü al) 1.000 · q_play (3 el oyna) 2.000 · günün görevi 2.000 (hangisi çıkarsa).
--   Bugünün henüz ALINMAMIŞ görevleri de yeni değerlere çekilir (alınmışlara dokunulmaz).
begin;
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
  v_third := v_pool[(abs(hashtext(p_uid || v_day::text)) % array_length(v_pool, 1)) + 1];

  insert into public.daily_quest_progress (user_id, day, quest_id, target, reward)
  values
    (p_uid, v_day, 'q_play',  3, 2000),
    (p_uid, v_day, 'q_daily', 1, 1000),
    (p_uid, v_day, v_third,
      case v_third
        when 'q_win'     then 1 when 'q_gift' then 1 when 'q_chat' then 1
        when 'q_like'    then 1 when 'q_ad'   then 1 else 2 end,
      2000)
  on conflict (user_id, day, quest_id) do nothing;
end;
$$;

update public.daily_quest_progress
   set reward = case quest_id when 'q_daily' then 1000 else 2000 end
 where day = (now() at time zone 'Europe/Istanbul')::date and not claimed;
commit;
