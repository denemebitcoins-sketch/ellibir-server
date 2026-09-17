-- Service-only reporting and runtime health. Does not activate bots.
begin;
create table if not exists bot_population.runtime_health (
  owner_id uuid primary key,
  updated_at timestamptz not null default clock_timestamp(),
  ready boolean not null,
  error text not null default '' check (char_length(error) <= 500),
  details jsonb not null default '{}'::jsonb
);
alter table bot_population.runtime_health enable row level security;
revoke all on bot_population.runtime_health from public, anon, authenticated;
grant select on bot_population.runtime_health to service_role;

-- First installation has room for 17 table bots and 3 rotating community bots.
-- Never overwrite a configured installation or an administrator's changed limit.
update bot_population.control set max_active=24 where mode='off' and revision=0 and max_active=16;

create or replace function public.bot_population_runtime_health(p_owner uuid, p_ready boolean, p_error text, p_details jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,bot_population as $$
begin
  perform bot_population.require_service();
  if jsonb_typeof(p_details) is distinct from 'object' or octet_length(p_details::text)>16000 then raise exception 'runtime_details_invalid'; end if;
  insert into bot_population.runtime_health(owner_id,ready,error,details)
    values(p_owner,p_ready,left(coalesce(p_error,''),500),p_details)
    on conflict(owner_id) do update set updated_at=clock_timestamp(),ready=excluded.ready,error=excluded.error,details=excluded.details;
  delete from bot_population.runtime_health where updated_at<clock_timestamp()-interval '7 days';
  return true;
end;
$$;

create or replace function public.bot_population_admin_report()
returns jsonb language plpgsql security definer set search_path=pg_catalog,bot_population as $$
declare result jsonb; v_since timestamptz:=clock_timestamp()-interval '24 hours';
begin
  perform bot_population.require_service();
  with completed as (
    select * from bot_population.matches where state<>'active' and completed_at>=v_since
  ), movement as (
    select s.kind,s.participant_id,w.delta from bot_population.match_wallet_entries w
      join bot_population.match_seats s using(match_key,seat) join completed m using(match_key)
  ), live as (
    select * from bot_population.leases where expires_at>clock_timestamp() or active_match is not null
  ) select jsonb_build_object(
    'ok',true,'generated_at',clock_timestamp(),'since',v_since,
    'control',(select to_jsonb(c) from bot_population.control c where singleton),
    'summary',jsonb_build_object(
      'pool',(select count(*) from bot_population.characters),'active',(select count(*) from live),
      'lobby',(select count(*) from live where room_key is null),
      'playing',(select count(*) from live where active_match is not null),
      'waiting',(select count(*) from live where room_key is not null and active_match is null),
      'stale',(select count(*) from live where expires_at<=clock_timestamp()),
      'bankroll',(select coalesce(sum(chips),0) from bot_population.characters),
      'matches',(select count(*) from completed where state='settled'),
      'refunds',(select count(*) from completed where state='refunded'),
      'active_matches',(select count(*) from bot_population.matches where state='active'),
      'bot_net',(select coalesce(sum(delta),0) from movement where kind='bot'),
      'human_net',(select coalesce(sum(delta),0) from movement where kind='human'),
      'house',(select coalesce(sum(house_amount),0) from completed),
      'refill',(select coalesce(sum(delta),0) from bot_population.ledger where reason='daily_refill' and created_at>=v_since)
    ),
    'tables',coalesce((select jsonb_agg(jsonb_build_object(
      'key',h.room_key,'game',h.game,'team',h.team_mode,'table',h.table_no,'bet',h.bet,
      'phase',case when h.expires_at<=clock_timestamp() then 'stale'
        when exists(select 1 from bot_population.matches m where m.room_key=h.room_key and m.state='active') then 'playing' else 'waiting' end,
      'bots',(select count(*) from live l where l.room_key=h.room_key),
      'humans',(select count(*) from bot_population.match_seats s join bot_population.matches m using(match_key)
        where m.room_key=h.room_key and m.state='active' and s.kind='human')
    ) order by h.game,h.table_no) from bot_population.room_hosts h),'[]'::jsonb),
    'characters',coalesce((select jsonb_agg(jsonb_build_object(
      'id',c.id,'name',c.name,'chips',c.chips,'vip',c.cosmetic_vip,
      'state',case when l.expires_at<=clock_timestamp() then 'stale' when l.active_match is not null then 'playing'
        when l.room_key is not null then 'waiting' when l.character_id is not null then 'lobby' else 'offline' end,
      'room',coalesce(l.room_key,''),'net',coalesce((select sum(delta) from movement where kind='bot' and participant_id=c.id::text),0)
    ) order by c.name) from bot_population.characters c left join live l on l.character_id=c.id),'[]'::jsonb),
    'health',coalesce((select jsonb_agg(jsonb_build_object('updated_at',h.updated_at,'ready',h.ready,
      'stale',h.updated_at<clock_timestamp()-interval '45 seconds','error',h.error,'details',h.details) order by h.updated_at desc)
      from bot_population.runtime_health h where updated_at>=clock_timestamp()-interval '24 hours'),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;
create or replace function public.bot_population_complete_drain()
returns boolean language plpgsql security definer set search_path=pg_catalog,bot_population as $$
declare c bot_population.control%rowtype;
begin
  perform bot_population.require_service();
  select * into c from bot_population.control where singleton for update;
  if c.mode<>'draining' then return false; end if;
  if exists(select 1 from bot_population.matches where state='active')
    or exists(select 1 from bot_population.leases where active_match is not null or expires_at>clock_timestamp())
    or exists(select 1 from bot_population.room_hosts where expires_at>clock_timestamp()) then return false; end if;
  perform public.bot_population_control(c.revision,'off',c.max_active,'system:drained');
  return true;
end;
$$;
revoke all on function public.bot_population_complete_drain() from public,anon,authenticated;
grant execute on function public.bot_population_complete_drain() to service_role;
create or replace function public.bot_population_recover_expired()
returns integer language plpgsql security definer set search_path=pg_catalog,bot_population as $$
declare h bot_population.room_hosts%rowtype; m bot_population.matches%rowtype; n integer:=0; v_mode text;
begin
  perform bot_population.require_service();
  select mode into v_mode from bot_population.control where singleton for update;
  if v_mode='running' then return 0; end if;
  for h in select * from bot_population.room_hosts where expires_at<=clock_timestamp() order by room_key for update loop
    -- An expired room cannot renew a character lease. Live character authority still fences recovery.
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
revoke all on function public.bot_population_runtime_health(uuid,boolean,text,jsonb) from public,anon,authenticated;
revoke all on function public.bot_population_admin_report() from public,anon,authenticated;
grant execute on function public.bot_population_runtime_health(uuid,boolean,text,jsonb) to service_role;
grant execute on function public.bot_population_admin_report() to service_role;
commit;
