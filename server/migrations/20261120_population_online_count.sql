-- 20.11 ESNEK NÜFUS: control_state artık online gerçek oyuncu sayısını da döndürür (son 90 sn presence).
-- Bot yöneticisi lobi botlarını buna göre büyütür. Sadece OKUMA.
begin;
create or replace function public.bot_population_control_state()
returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
begin
  perform bot_population.require_service();
  return (select to_jsonb(c) from bot_population.control c where singleton)
    || jsonb_build_object('online', (select count(*) from public.presence p where p.last_seen > now() - interval '90 seconds'));
end;
$$;
revoke all on function public.bot_population_control_state() from public, anon, authenticated;
grant execute on function public.bot_population_control_state() to service_role;
commit;
