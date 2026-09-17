-- Native multi-connection regression: expiry must use time AFTER acquiring locks.
-- Keep applied migrations immutable. Does not enable or seed the population.
begin;
create or replace function public.bot_population_claim(
  p_character uuid,p_owner uuid,p_token uuid,
  p_room text default null,p_seat integer default null,p_game text default null,p_bet integer default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog,bot_population as $$
declare c bot_population.control;l bot_population.leases;v_now timestamptz;v_balance bigint;
begin
  perform bot_population.require_service();
  select * into c from bot_population.control where singleton for update;
  if c.mode <> 'running' then raise exception 'population_not_running';end if;
  if p_owner is null or p_token is null then raise exception 'lease_identity_required';end if;
  select chips into v_balance from bot_population.characters where id=p_character and enabled for update;
  if not found then raise exception 'character_unavailable';end if;
  if p_bet is not null and v_balance < p_bet then raise exception 'insufficient_chips';end if;
  v_now := clock_timestamp();
  delete from bot_population.leases where expires_at<=v_now and active_match is null;
  select * into l from bot_population.leases where character_id=p_character;
  if found then
    if l.owner_id<>p_owner or l.token<>p_token then raise exception 'character_busy';end if;
    if l.expires_at<=v_now then raise exception 'lease_lost';end if;
    if l.room_key is distinct from p_room or l.seat is distinct from p_seat
      or l.game is distinct from p_game or l.bet is distinct from p_bet then raise exception 'lease_payload_conflict';end if;
    update bot_population.leases set expires_at=clock_timestamp()+interval '45 seconds'
      where character_id=p_character returning * into l;
    return to_jsonb(l);
  end if;
  if (select count(*) from bot_population.leases)>=c.max_active then raise exception 'population_capacity';end if;
  insert into bot_population.leases(character_id,owner_id,token,expires_at,room_key,seat,game,bet)
    values(p_character,p_owner,p_token,clock_timestamp()+interval '45 seconds',p_room,p_seat,p_game,p_bet)
    returning * into l;
  return to_jsonb(l);
end;
$$;
create or replace function public.bot_population_refill(p_character uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,bot_population as $$
declare c bot_population.characters;l bot_population.leases;v_day date;v_target bigint;
begin
  perform bot_population.require_service();
  perform 1 from bot_population.control where singleton for update;
  select * into c from bot_population.characters where id=p_character for update;
  if not found then raise exception 'character_missing';end if;
  v_day := (clock_timestamp() at time zone 'Europe/Istanbul')::date;
  select * into l from bot_population.leases where character_id=p_character;
  if found and (l.active_match is not null or (l.room_key is not null and l.expires_at>clock_timestamp())) then
    raise exception 'character_not_idle';
  end if;
  if c.chips>=100000 or c.last_refill_day>=v_day then
    return jsonb_build_object('ok',true,'refilled',false,'chips',c.chips);
  end if;
  v_target:=100000+floor(random()*200001)::bigint;
  insert into bot_population.ledger(character_id,event_key,reason,delta,balance_after)
    values(c.id,'daily_refill:'||v_day::text,'daily_refill',v_target-c.chips,v_target);
  update bot_population.characters set chips=v_target,last_refill_day=v_day where id=c.id;
  return jsonb_build_object('ok',true,'refilled',true,'chips',v_target);
end;
$$;
create or replace function public.bot_population_heartbeat(p_character uuid,p_owner uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,bot_population as $$
declare l bot_population.leases;v_mode text;v_now timestamptz;
begin
  perform bot_population.require_service();
  select mode into v_mode from bot_population.control where singleton for update;
  select * into l from bot_population.leases where character_id=p_character for update;
  v_now := clock_timestamp();
  if not found or l.owner_id is distinct from p_owner or l.token is distinct from p_token or l.expires_at<=v_now then
    raise exception 'lease_lost';
  end if;
  if v_mode<>'running' and l.active_match is null then raise exception 'population_draining';end if;
  update bot_population.leases set expires_at=clock_timestamp()+interval '45 seconds'
    where character_id=p_character returning * into l;
  return to_jsonb(l);
end;
$$;
create or replace function public.bot_population_claim_room(
  p_room text,p_owner uuid,p_token uuid,p_game text,p_team boolean,p_table integer,p_bet integer
) returns jsonb language plpgsql security definer set search_path=pg_catalog,bot_population as $$
declare h bot_population.room_hosts;m bot_population.matches;v_mode text;
  v_now timestamptz;v_previous uuid;v_room_id text;v_refunds integer:=0;
begin
  perform bot_population.require_service();
  select mode into v_mode from bot_population.control where singleton for update;
  if v_mode<>'running' then raise exception 'population_not_running';end if;
  if p_owner is null or p_token is null then raise exception 'room_identity_required';end if;
  select * into h from bot_population.room_hosts where room_key=p_room for update;
  v_now := clock_timestamp();
  if found then
    if h.game is distinct from p_game or h.team_mode is distinct from p_team or h.table_no is distinct from p_table
      or h.bet is distinct from p_bet then raise exception 'room_payload_conflict';end if;
    if h.owner_id=p_owner and h.token=p_token then
      if h.expires_at<=v_now then raise exception 'room_lease_lost';end if;
      update bot_population.room_hosts set expires_at=clock_timestamp()+interval '45 seconds'
        where room_key=p_room returning * into h;
      return to_jsonb(h);
    end if;
    if h.expires_at>v_now then raise exception 'room_host_busy';end if;
    if exists(select 1 from bot_population.leases where room_key=p_room and expires_at>v_now) then
      raise exception 'room_character_lease_alive';
    end if;
    v_previous:=h.owner_id;v_room_id:=h.room_id;
    for m in select * from bot_population.matches where room_key=p_room and state='active' order by match_key for update loop
      if m.owner_id<>h.owner_id then raise exception 'room_match_owner_inconsistent';end if;
      perform public.bot_population_finish_match(m.match_key,m.owner_id,null);
      v_refunds:=v_refunds+1;
    end loop;
    delete from bot_population.leases where room_key=p_room and active_match is null;
    update bot_population.room_hosts set owner_id=p_owner,token=p_token,
      expires_at=clock_timestamp()+interval '45 seconds',previous_room_id=v_room_id,room_id=null
      where room_key=p_room returning * into h;
  else
    if exists(select 1 from bot_population.leases where room_key=p_room)
      or exists(select 1 from bot_population.matches where room_key=p_room and state='active') then
      raise exception 'room_unowned_records';
    end if;
    insert into bot_population.room_hosts(room_key,game,team_mode,table_no,bet,owner_id,token,expires_at)
      values(p_room,p_game,p_team,p_table,p_bet,p_owner,p_token,clock_timestamp()+interval '45 seconds') returning * into h;
  end if;
  insert into bot_population.room_host_events(room_key,owner_id,action,previous_owner,room_id,refunded_matches)
    values(p_room,p_owner,case when v_previous is null then 'claim' else 'recover' end,v_previous,v_room_id,v_refunds);
  return to_jsonb(h);
end;
$$;
revoke all on function public.bot_population_claim(uuid,uuid,uuid,text,integer,text,integer) from public,anon,authenticated;
revoke all on function public.bot_population_refill(uuid) from public,anon,authenticated;
revoke all on function public.bot_population_heartbeat(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.bot_population_claim_room(text,uuid,uuid,text,boolean,integer,integer) from public,anon,authenticated;
grant execute on function public.bot_population_claim(uuid,uuid,uuid,text,integer,text,integer) to service_role;
grant execute on function public.bot_population_refill(uuid) to service_role;
grant execute on function public.bot_population_heartbeat(uuid,uuid,uuid) to service_role;
grant execute on function public.bot_population_claim_room(text,uuid,uuid,text,boolean,integer,integer) to service_role;
commit;
