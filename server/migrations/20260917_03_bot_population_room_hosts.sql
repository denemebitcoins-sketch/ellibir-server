-- Apply after 01 and 02. Service-only logical-table ownership and orphan escrow recovery.
-- Does not seed, start a scheduler or enable the population.
begin;

create table if not exists bot_population.room_hosts (
  room_key text primary key check (char_length(room_key) between 1 and 120),
  game text not null check (game in ('51','duz','banko','yuzbir','ihale','tavla')),
  team_mode boolean not null,
  table_no integer not null check (table_no > 0),
  bet integer not null check (bet between 500 and 5000 and bet % 500 = 0),
  owner_id uuid not null,
  token uuid not null unique,
  expires_at timestamptz not null,
  room_id text check (room_id is null or char_length(room_id) between 1 and 128),
  previous_room_id text,
  unique (game, team_mode, table_no),
  check (game <> 'tavla' or not team_mode)
);
create table if not exists bot_population.room_host_events (
  id bigint generated always as identity primary key,
  room_key text not null,
  owner_id uuid not null,
  action text not null check (action in ('claim','recover','publish','release')),
  previous_owner uuid,
  room_id text,
  refunded_matches integer not null default 0,
  created_at timestamptz not null default clock_timestamp()
);
alter table bot_population.room_hosts enable row level security;
alter table bot_population.room_host_events enable row level security;
revoke all on bot_population.room_hosts, bot_population.room_host_events from public, anon, authenticated;
grant select on bot_population.room_hosts, bot_population.room_host_events to service_role;

create or replace function public.bot_population_claim_room(
  p_room text, p_owner uuid, p_token uuid, p_game text, p_team boolean, p_table integer, p_bet integer
) returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
declare h bot_population.room_hosts; m bot_population.matches; v_mode text;
  v_now timestamptz := clock_timestamp(); v_previous uuid; v_room_id text; v_refunds integer := 0;
begin
  perform bot_population.require_service();
  select mode into v_mode from bot_population.control where singleton for update;
  if v_mode <> 'running' then raise exception 'population_not_running'; end if;
  if p_owner is null or p_token is null then raise exception 'room_identity_required'; end if;
  select * into h from bot_population.room_hosts where room_key = p_room for update;
  if found then
    if h.game is distinct from p_game or h.team_mode is distinct from p_team or h.table_no is distinct from p_table
      or h.bet is distinct from p_bet then raise exception 'room_payload_conflict'; end if;
    if h.owner_id = p_owner and h.token = p_token then
      if h.expires_at <= v_now then raise exception 'room_lease_lost'; end if;
      update bot_population.room_hosts set expires_at = v_now + interval '45 seconds' where room_key = p_room returning * into h;
      return to_jsonb(h);
    end if;
    if h.expires_at > v_now then raise exception 'room_host_busy'; end if;
    -- A living character lease can still be executing a turn. Never take it over early.
    if exists (select 1 from bot_population.leases where room_key = p_room and expires_at > v_now) then
      raise exception 'room_character_lease_alive';
    end if;
    v_previous := h.owner_id; v_room_id := h.room_id;
    for m in select * from bot_population.matches where room_key = p_room and state = 'active' order by match_key for update loop
      if m.owner_id <> h.owner_id then raise exception 'room_match_owner_inconsistent'; end if;
      -- Existing atomic refund validates every immutable bot token and human wallet.
      -- Any missing/corrupt participant aborts this ENTIRE takeover transaction.
      perform public.bot_population_finish_match(m.match_key, m.owner_id, null);
      v_refunds := v_refunds + 1;
    end loop;
    delete from bot_population.leases where room_key = p_room and active_match is null;
    update bot_population.room_hosts set owner_id = p_owner, token = p_token,
      expires_at = v_now + interval '45 seconds', previous_room_id = v_room_id, room_id = null
      where room_key = p_room returning * into h;
  else
    -- Old phase-01/02 records without a host are not silently adopted.
    if exists (select 1 from bot_population.leases where room_key = p_room)
      or exists (select 1 from bot_population.matches where room_key = p_room and state = 'active') then
      raise exception 'room_unowned_records';
    end if;
    insert into bot_population.room_hosts(room_key, game, team_mode, table_no, bet, owner_id, token, expires_at)
      values(p_room, p_game, p_team, p_table, p_bet, p_owner, p_token, v_now + interval '45 seconds') returning * into h;
  end if;
  insert into bot_population.room_host_events(room_key, owner_id, action, previous_owner, room_id, refunded_matches)
    values(p_room, p_owner, case when v_previous is null then 'claim' else 'recover' end, v_previous, v_room_id, v_refunds);
  return to_jsonb(h);
end;
$$;

create or replace function public.bot_population_publish_room(p_room text, p_owner uuid, p_token uuid, p_room_id text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
declare h bot_population.room_hosts;
begin
  perform bot_population.require_service();
  perform 1 from bot_population.control where singleton for update;
  select * into h from bot_population.room_hosts where room_key = p_room for update;
  if not found or h.owner_id is distinct from p_owner or h.token is distinct from p_token or h.expires_at <= clock_timestamp()
    then raise exception 'room_lease_lost'; end if;
  if p_room_id is null or char_length(p_room_id) not between 1 and 128 then raise exception 'room_id_invalid'; end if;
  if h.room_id is not null then
    if h.room_id <> p_room_id then raise exception 'room_publish_conflict'; end if;
    return to_jsonb(h);
  end if;
  update bot_population.room_hosts set room_id = p_room_id where room_key = p_room returning * into h;
  insert into bot_population.room_host_events(room_key, owner_id, action, room_id) values(p_room, p_owner, 'publish', p_room_id);
  return to_jsonb(h);
end;
$$;

create or replace function public.bot_population_heartbeat_room(p_room text, p_owner uuid, p_token uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
declare h bot_population.room_hosts;
begin
  perform bot_population.require_service();
  perform 1 from bot_population.control where singleton for update;
  select * into h from bot_population.room_hosts where room_key = p_room for update;
  if not found or h.owner_id is distinct from p_owner or h.token is distinct from p_token or h.expires_at <= clock_timestamp()
    then raise exception 'room_lease_lost'; end if;
  -- Off/drain still permits existing authority to finish/refund and release safely.
  update bot_population.room_hosts set expires_at = clock_timestamp() + interval '45 seconds'
    where room_key = p_room returning * into h;
  return to_jsonb(h);
end;
$$;

create or replace function public.bot_population_release_room(p_room text, p_owner uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, bot_population as $$
declare h bot_population.room_hosts;
begin
  perform bot_population.require_service();
  perform 1 from bot_population.control where singleton for update;
  select * into h from bot_population.room_hosts where room_key = p_room for update;
  if not found then return true; end if;
  if h.owner_id is distinct from p_owner or h.token is distinct from p_token then raise exception 'room_lease_lost'; end if;
  if exists (select 1 from bot_population.leases where room_key = p_room)
    or exists (select 1 from bot_population.matches where room_key = p_room and state = 'active') then
    raise exception 'room_still_occupied';
  end if;
  delete from bot_population.room_hosts where room_key = p_room;
  insert into bot_population.room_host_events(room_key, owner_id, action, room_id) values(p_room, p_owner, 'release', h.room_id);
  return true;
end;
$$;

create or replace function public.bot_population_get_rooms()
returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
begin
  perform bot_population.require_service();
  return coalesce((select jsonb_agg(to_jsonb(h) order by room_key) from bot_population.room_hosts h), '[]'::jsonb);
end;
$$;

create or replace function bot_population.enforce_room_host()
returns trigger language plpgsql security definer set search_path = pg_catalog, bot_population as $$
declare h bot_population.room_hosts; m bot_population.matches;
begin
  if new.room_key is null then return new; end if;
  -- Settlement/refund must be able to clear a fence even AFTER host expiry.
  if tg_op = 'UPDATE' and new.owner_id = old.owner_id and new.token = old.token
    and new.room_key = old.room_key and new.expires_at = old.expires_at
    and old.active_match is not null and new.active_match is null then return new; end if;
  select * into h from bot_population.room_hosts where room_key = new.room_key;
  if not found or h.owner_id <> new.owner_id or h.expires_at <= clock_timestamp()
    or h.game <> new.game or h.bet <> new.bet then raise exception 'room_lease_lost'; end if;
  if new.active_match is not null then
    select * into m from bot_population.matches where match_key = new.active_match;
    if not found or m.owner_id <> h.owner_id or m.room_key <> h.room_key or m.game <> h.game
      or m.bet <> h.bet or m.team_mode <> h.team_mode then raise exception 'room_match_conflict'; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists population_lease_room_host on bot_population.leases;
create trigger population_lease_room_host before insert or update on bot_population.leases
  for each row execute function bot_population.enforce_room_host();
revoke all on function bot_population.enforce_room_host() from public, anon, authenticated;

revoke all on function public.bot_population_claim_room(text,uuid,uuid,text,boolean,integer,integer) from public,anon,authenticated;
revoke all on function public.bot_population_publish_room(text,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.bot_population_heartbeat_room(text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.bot_population_release_room(text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.bot_population_get_rooms() from public,anon,authenticated;
grant execute on function public.bot_population_claim_room(text,uuid,uuid,text,boolean,integer,integer) to service_role;
grant execute on function public.bot_population_publish_room(text,uuid,uuid,text) to service_role;
grant execute on function public.bot_population_heartbeat_room(text,uuid,uuid) to service_role;
grant execute on function public.bot_population_release_room(text,uuid,uuid) to service_role;
grant execute on function public.bot_population_get_rooms() to service_role;
commit;
