-- 21.11: Supabase anlık takılmalarında (2-3 dk) botların masadan düşmemesi için kira 45 sn -> 4 dk.
-- Sunucu tarafı geçici hatada (zaman aşımı) masayı kilitlemiyor; kira dolmadıkça oyun sürer.
-- Bedeli: sunucu çökerse/deploy olursa o botlar ~4 dk sonra serbest kalır (önce 45 sn).
do $$
declare r record; d text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in
             ('bot_population_claim','bot_population_claim_room','bot_population_heartbeat','bot_population_heartbeat_room')
  loop
    d := pg_get_functiondef(r.oid);
    if position('45 seconds' in d) > 0 then
      execute replace(d, 'interval ''45 seconds''', 'interval ''4 minutes''');
    end if;
  end loop;
end $$;
select p.proname, position('4 minutes' in pg_get_functiondef(p.oid)) > 0 as ok
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'bot_population_%' and pg_get_functiondef(p.oid) like '%minutes%' order by 1;
