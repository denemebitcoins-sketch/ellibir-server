-- 6.9  HAFTANIN KAHVECİSİ + KAYIPSIZ KAHVE SAATİ
-- Kararlar (kullanıcı, 18.11 03:31):
--   Puan: el sayısına göre (okey/51/ihale el, tavla hedef puan) 10 + 12,5×(el−1) → 1:10, 3:35, 5:60, 7:85, 9:110, 11:135.
--         Kazanma/kaybetme fark etmez (aktiflik ödülü). Kahve Saati'nde 2×. Günlük tavan 600 (2× dahil). Botlar puan almaz.
--   Kahve Saati: her gün 20:00–23:00 (TR). Günde ilk 5 maç: kaybedene bahsin %50'si iade, kazanana net kazancın %30'u bonus.
--         Maç başı iade/bonus tavanı 50.000 çip (kötüye kullanım sigortası).
--   Haftalık ödül (hafta Pazartesi 00:00 TR kapanır, toplam ~1M çip):
--         1.: 400.000 + 100 elmas · 2.: 200.000 + 75 · 3.: 150.000 + 50 · 4.–10.: 35.000 + 10 elmas. admin_rewards ile teslim (oyunda ödül modalı).
-- Uygulama: Colyseus settleMatch her gerçek oyuncu için match_extras çağırır (idempotent: match_key+user).
--           Sunucu 10 dk'da bir weekly_close_due() çağırır (idempotent).

create table if not exists public.weekly_points (
  week_start date not null,
  user_id    text not null,
  points     int  not null default 0,
  matches    int  not null default 0,
  updated_at timestamptz not null default now(),
  primary key (week_start, user_id)
);
create index if not exists weekly_points_rank_idx on public.weekly_points (week_start, points desc, updated_at);

create table if not exists public.daily_points (
  day     date not null,
  user_id text not null,
  points  int  not null default 0,
  primary key (day, user_id)
);

create table if not exists public.match_extras_log (
  match_key     text not null,
  user_id       text not null,
  game          text,
  hands         int,
  points        int    not null default 0,
  coffee_kind   text,               -- 'refund' | 'bonus' | null
  coffee_amount bigint not null default 0,
  created_at    timestamptz not null default now(),
  primary key (match_key, user_id)
);
create index if not exists match_extras_coffee_idx on public.match_extras_log (created_at) where coffee_kind is not null;
create index if not exists match_extras_user_day_idx on public.match_extras_log (user_id, created_at) where coffee_kind is not null;

create table if not exists public.weekly_rewards (
  week_start date not null,
  rank       int  not null,           -- 0 = hafta kapandı işareti (kimse yoksa da yazılır)
  user_id    text,
  points     int  not null default 0,
  chips      bigint not null default 0,
  diamonds   int  not null default 0,
  created_at timestamptz not null default now(),
  primary key (week_start, rank)
);

alter table public.weekly_points   enable row level security;
alter table public.daily_points    enable row level security;
alter table public.match_extras_log enable row level security;
alter table public.weekly_rewards  enable row level security;

create or replace function public.tr_now() returns timestamp
language sql stable as $$ select (now() at time zone 'Europe/Istanbul') $$;

create or replace function public.tr_week_start(p_ts timestamp default null) returns date
language sql stable as $$ select date_trunc('week', coalesce(p_ts, public.tr_now()))::date $$;

-- ── maç sonu: puan + kahve saati (yalnız sunucu) ──────────────────────────────
create or replace function public.match_extras(
  p_user text, p_game text, p_hands int, p_won boolean, p_bet bigint, p_net bigint, p_key text)
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
  v_live  boolean := extract(hour from v_now) >= 20 and extract(hour from v_now) < 23;
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
revoke execute on function public.match_extras(text, text, int, boolean, bigint, bigint, text) from public, anon, authenticated;
grant  execute on function public.match_extras(text, text, int, boolean, bigint, bigint, text) to service_role;

-- ── liderlik tablosu (oyuncu) ───────────────────────────────────────────────
create or replace function public.weekly_leaderboard(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week date := public.tr_week_start();
  v_me   text := auth.uid()::text;
  v_rows jsonb;
  v_me_j jsonb;
begin
  with ranked as (
    select w.user_id, w.points, w.matches,
           row_number() over (order by w.points desc, w.updated_at asc) as rank
      from public.weekly_points w
     where w.week_start = v_week and w.points > 0
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'rank', r.rank, 'user_id', r.user_id, 'points', r.points,
           'name', p.name, 'avatar_url', case when coalesce(p.avatar_status, 'visible') in ('visible', 'approved') then p.avatar_url end,
           'role', p.role, 'gender', p.gender,
           'playing', coalesce(pr.status = 'masada' and pr.last_seen > now() - interval '3 minutes', false)) order by r.rank), '[]'::jsonb)
    into v_rows
    from ranked r
    join public.profiles p on p.id = r.user_id
    left join public.presence pr on pr.user_id::text = r.user_id
   where r.rank <= greatest(3, least(coalesce(p_limit, 50), 100));

  if v_me is not null then
    with ranked as (
      select w.user_id, w.points,
             row_number() over (order by w.points desc, w.updated_at asc) as rank
        from public.weekly_points w
       where w.week_start = v_week and w.points > 0
    )
    select jsonb_build_object('rank', m.rank, 'points', m.points,
             'to_third', greatest(0, coalesce((select points from ranked where rank = 3), 0) - m.points + 1))
      into v_me_j
      from ranked m where m.user_id = v_me;
  end if;

  return jsonb_build_object(
    'week_start', v_week,
    'ends_at', (v_week + 7)::timestamp at time zone 'Europe/Istanbul',
    'rows', v_rows,
    'me', coalesce(v_me_j, jsonb_build_object('rank', null, 'points', 0)),
    'rewards', jsonb_build_array(
      jsonb_build_object('rank', '1', 'chips', 400000, 'diamonds', 100),
      jsonb_build_object('rank', '2', 'chips', 200000, 'diamonds', 75),
      jsonb_build_object('rank', '3', 'chips', 150000, 'diamonds', 50),
      jsonb_build_object('rank', '4-10', 'chips', 35000, 'diamonds', 10)));
end;
$$;
revoke execute on function public.weekly_leaderboard(int) from public, anon;
grant  execute on function public.weekly_leaderboard(int) to authenticated;

-- ── kahve saati durumu + son seansın kazananları (oyuncu) ─────────────────────
create or replace function public.coffee_hour_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now  timestamp := public.tr_now();
  v_me   text := auth.uid()::text;
  v_used int := 0;
  v_last date;
  v_win  jsonb;
  v_tot  bigint;
begin
  if v_me is not null then
    select count(*) into v_used from public.match_extras_log
     where user_id = v_me and coffee_kind is not null
       and (created_at at time zone 'Europe/Istanbul')::date = v_now::date;
  end if;
  select max((created_at at time zone 'Europe/Istanbul')::date) into v_last
    from public.match_extras_log where coffee_kind is not null and created_at > now() - interval '8 days';
  if v_last is not null then
    select coalesce(jsonb_agg(x order by x->>'amount' desc), '[]'::jsonb), coalesce(sum((x->>'amount')::bigint), 0)
      into v_win, v_tot
      from (
        select jsonb_build_object('user_id', p.id, 'name', p.name, 'avatar_url', case when coalesce(p.avatar_status, 'visible') in ('visible', 'approved') then p.avatar_url end, 'role', p.role, 'gender', p.gender,
                                  'amount', sum(l.coffee_amount), 'matches', count(*)) as x
          from public.match_extras_log l join public.profiles p on p.id = l.user_id
         where l.coffee_kind = 'bonus' and (l.created_at at time zone 'Europe/Istanbul')::date = v_last
         group by p.id, p.name, p.avatar_url, p.avatar_status, p.role, p.gender
         order by sum(l.coffee_amount) desc
         limit 10) t;
  end if;
  return jsonb_build_object('used_today', v_used, 'daily_limit', 5, 'refund_pct', 50, 'bonus_pct', 30,
                            'start_hour', 20, 'end_hour', 23, 'last_day', v_last,
                            'winners', coalesce(v_win, '[]'::jsonb), 'total_bonus', coalesce(v_tot, 0));
end;
$$;
revoke execute on function public.coffee_hour_state() from public, anon;
grant  execute on function public.coffee_hour_state() to authenticated;

-- ── haftayı kapat + ödülleri dağıt (yalnız sunucu, idempotent) ───────────────
create or replace function public.weekly_close_due()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cur  date := public.tr_week_start();
  v_week date;
  v_n    int := 0;
  r      record;
  v_chips bigint; v_dia int;
begin
  for v_week in
    select distinct w.week_start from public.weekly_points w
     where w.week_start < v_cur
       and not exists (select 1 from public.weekly_rewards x where x.week_start = w.week_start)
     order by 1
  loop
    insert into public.weekly_rewards (week_start, rank) values (v_week, 0) on conflict do nothing;
    for r in
      select w.user_id, w.points, row_number() over (order by w.points desc, w.updated_at asc) as rank
        from public.weekly_points w
       where w.week_start = v_week and w.points > 0
       order by 3 limit 10
    loop
      v_chips := case r.rank when 1 then 400000 when 2 then 200000 when 3 then 150000 else 35000 end;
      v_dia   := case r.rank when 1 then 100 when 2 then 75 when 3 then 50 else 10 end;
      insert into public.weekly_rewards (week_start, rank, user_id, points, chips, diamonds)
        values (v_week, r.rank, r.user_id, r.points, v_chips, v_dia) on conflict do nothing;
      insert into public.admin_rewards (user_id, message, chips, diamonds, admin_name)
        values (r.user_id,
                'Haftanın Kahvecisi ' || r.rank || '. oldun! (' || to_char(v_week, 'DD.MM') || ' – ' || to_char(v_week + 6, 'DD.MM') || ', ' || r.points || ' puan)',
                v_chips, v_dia, 'Haftanın Kahvecisi');
      v_n := v_n + 1;
    end loop;
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.weekly_close_due() from public, anon, authenticated;
grant  execute on function public.weekly_close_due() to service_role;
