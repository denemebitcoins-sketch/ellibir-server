-- Online Kahvem - Masa bahisleri 5k-25k (14.11.2026)
-- Colyseus odaları artık yalnız 5000/10000/15000/20000/25000 kabul eder (server/src/tableBets.ts).
-- Bot nüfusu tablolarındaki "500-5000, 500'ün katı" kısıtları 500-25000'e genişletilir (bot masaları 5000 ile açılır).
-- Genişletme eski aralığı kapsadığı için geçmiş kayıtlar geçerli kalır.
-- APPLIED to live Supabase on 2026-11-14.

do $$
declare c record;
begin
  for c in
    select n.nspname, t.relname, con.conname
      from pg_constraint con
      join pg_class t on t.oid = con.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'bot_population'
       and t.relname in ('leases', 'matches', 'room_hosts')
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%bet%500%'
  loop
    execute format('alter table %I.%I drop constraint %I', c.nspname, c.relname, c.conname);
  end loop;
end $$;

alter table bot_population.leases add constraint leases_shape_bet_v2_check check (
  (room_key is null and seat is null and game is null and bet is null and active_match is null)
  or (room_key is not null and char_length(room_key) between 1 and 120
    and seat is not null and game is not null and bet is not null
    and game in ('51', 'duz', 'banko', 'yuzbir', 'ihale', 'tavla')
    and seat between 0 and case when game = 'tavla' then 1 else 3 end
    and bet between 500 and 25000 and bet % 500 = 0)
);

alter table bot_population.matches add constraint matches_bet_v2_check
  check (bet between 500 and 25000 and bet % 500 = 0);

alter table bot_population.room_hosts add constraint room_hosts_bet_v2_check
  check (bet between 500 and 25000 and bet % 500 = 0);
