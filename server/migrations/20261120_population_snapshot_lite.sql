-- 20.11 EGRESS: bot yoneticisi her 10 sn'de tam snapshot (100 karakterin tum alanlari ~26 KB + kiralar)
-- cekiyordu (gunde ~275 MB disari veri). Bu iki hafif okuma ayni veriyi cok daha kucuk dondurur:
--  * snapshot_lite: control + kiralar + karakterlerin yalniz degisen alanlari [id, chips, enabled, last_refill_day]
--  * control_state: yalniz mod/limit (runtime turu icin)
-- Sadece OKUMA; tablo/veri degismez. Eski bot_population_snapshot aynen duruyor (geri donus icin).
begin;

create or replace function public.bot_population_snapshot_lite()
returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
begin
  perform bot_population.require_service();
  return jsonb_build_object(
    'control', (select to_jsonb(c) from bot_population.control c where singleton),
    'chips', (select coalesce(jsonb_agg(jsonb_build_array(c.id, c.chips, c.enabled, c.last_refill_day) order by c.id), '[]'::jsonb)
              from bot_population.characters c),
    'leases', (select coalesce(jsonb_agg(to_jsonb(l) order by l.character_id), '[]'::jsonb) from bot_population.leases l)
  );
end;
$$;

create or replace function public.bot_population_control_state()
returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
begin
  perform bot_population.require_service();
  return (select to_jsonb(c) from bot_population.control c where singleton);
end;
$$;

revoke all on function public.bot_population_snapshot_lite() from public, anon, authenticated;
revoke all on function public.bot_population_control_state() from public, anon, authenticated;
grant execute on function public.bot_population_snapshot_lite() to service_role;
grant execute on function public.bot_population_control_state() to service_role;

commit;
