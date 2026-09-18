-- Recovery is lease-fenced, not tied to the operator's running/draining switch.
create or replace function public.bot_population_recover_expired()
returns integer language plpgsql security definer set search_path=pg_catalog,bot_population as $$
declare h bot_population.room_hosts%rowtype; m bot_population.matches%rowtype; n integer:=0;
begin
  perform bot_population.require_service();
  perform 1 from bot_population.control where singleton for update;
  for h in select * from bot_population.room_hosts where expires_at<=clock_timestamp() order by room_key for update loop
    if exists(select 1 from bot_population.leases where room_key=h.room_key and expires_at>clock_timestamp()) then continue; end if;
    for m in select * from bot_population.matches where room_key=h.room_key and state='active' order by match_key loop
      if m.owner_id<>h.owner_id then raise exception 'orphan_owner_conflict'; end if;
      perform public.bot_population_finish_match(m.match_key,m.owner_id,null);
    end loop;
    delete from bot_population.leases where room_key=h.room_key and active_match is null;
    delete from bot_population.room_hosts where room_key=h.room_key;
    n:=n+1;
  end loop;
  delete from bot_population.leases where room_key is null and active_match is null and expires_at<=clock_timestamp();
  return n;
end;
$$;
revoke all on function public.bot_population_recover_expired() from public,anon,authenticated;
grant execute on function public.bot_population_recover_expired() to service_role;
