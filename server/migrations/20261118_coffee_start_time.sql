-- 18.11 KAHVE SAATİ: pencere maçın BAŞLANGIÇ saatine göre (kullanıcı kararı).
--  • 20:00'den önce başlayan maç 20:00'den sonra bitse de iade/bonus/2× puan ALMAZ.
--  • 20:00–23:00 arasında başlayan maç 23:00'ten sonra bitse de ALIR.
-- Sunucu p_started_at gönderir; gelmezse eski davranış (bitiş anı). ÖNCE bu SQL, SONRA sunucu güncellemesi.
begin;
drop function if exists public.match_extras(text, text, int, boolean, bigint, bigint, text);
create or replace function public.match_extras(
  p_user text, p_game text, p_hands int, p_won boolean, p_bet bigint, p_net bigint, p_key text,
  p_started_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now   timestamp := public.tr_now();
  v_day   date := v_now::date;
  v_week  date := public.tr_week_start(v_now);
  v_hands int := greatest(1, least(11, coalesce(p_hands, 1)));
  -- 18.11: pencere maçın BAŞLADIĞI saate göre (20:00 öncesi başlayan dahil değil; 23:00 öncesi başlayan bitince de alır)
  v_start timestamp := coalesce(p_started_at at time zone 'Europe/Istanbul', v_now);
  v_live  boolean := extract(hour from v_start) >= 20 and extract(hour from v_start) < 23
                     and v_start::date >= v_now::date - 1;
  v_base  int;
  v_pts   int;
  v_today int;
  v_used  int;
  v_kind  text := null;
  v_amt   bigint := 0;
begin
  if p_user is null or btrim(p_user) = '' or p_user like 'bot:%' or p_key is null then
    return jsonb_build_object('ok', false);
  end if;
  if exists (select 1 from public.match_extras_log where match_key = p_key and user_id = p_user) then
    return (select jsonb_build_object('ok', true, 'dup', true, 'points', points, 'coffee_kind', coffee_kind, 'coffee_amount', coffee_amount)
              from public.match_extras_log where match_key = p_key and user_id = p_user);
  end if;

  -- haftalık puan (günlük tavan 600)
  v_base := round(10 + 12.5 * (v_hands - 1));
  if v_live then v_base := v_base * 2; end if;
  select coalesce(points, 0) into v_today from public.daily_points where day = v_day and user_id = p_user;
  v_pts := greatest(0, least(v_base, 600 - coalesce(v_today, 0)));
  insert into public.daily_points (day, user_id, points) values (v_day, p_user, v_pts)
    on conflict (day, user_id) do update set points = daily_points.points + excluded.points;
  insert into public.weekly_points (week_start, user_id, points, matches, updated_at)
    values (v_week, p_user, v_pts, 1, now())
    on conflict (week_start, user_id) do update
      set points = weekly_points.points + excluded.points, matches = weekly_points.matches + 1,
          updated_at = case when excluded.points > 0 then now() else weekly_points.updated_at end;

  -- kayıpsız kahve saati (günde ilk 5 maç)
  if v_live and coalesce(p_bet, 0) > 0 then
    select count(*) into v_used from public.match_extras_log
     where user_id = p_user and coffee_kind is not null
       and (created_at at time zone 'Europe/Istanbul')::date = v_day;
    if v_used < 5 then
      if p_won and coalesce(p_net, 0) > 0 then
        v_kind := 'bonus';  v_amt := least(50000, floor(p_net * 0.30));
      elsif not p_won then
        v_kind := 'refund'; v_amt := least(50000, floor(p_bet * 0.50));
      end if;
      if v_amt > 0 then perform public.add_chips(p_user, v_amt); else v_kind := null; v_amt := 0; end if;
    end if;
  end if;

  insert into public.match_extras_log (match_key, user_id, game, hands, points, coffee_kind, coffee_amount)
    values (p_key, p_user, p_game, v_hands, v_pts, v_kind, v_amt);
  return jsonb_build_object('ok', true, 'points', v_pts, 'capped', v_pts < v_base, 'double', v_live,
                            'coffee_kind', v_kind, 'coffee_amount', v_amt);
end;
$$;
revoke execute on function public.match_extras(text, text, int, boolean, bigint, bigint, text, timestamptz) from public, anon, authenticated;
grant  execute on function public.match_extras(text, text, int, boolean, bigint, bigint, text, timestamptz) to service_role;
commit;
notify pgrst, 'reload schema';
