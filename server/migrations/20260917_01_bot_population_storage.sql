-- First population migration. Applying this migration does NOT enable it.
-- No auth.users/profiles are created for characters; human wallets remain separate.
begin;

create schema if not exists bot_population;
revoke all on schema bot_population from public, anon, authenticated;
grant usage on schema bot_population to service_role;

create table if not exists bot_population.control (
  singleton boolean primary key default true check (singleton),
  mode text not null default 'off' check (mode in ('off', 'running', 'draining')),
  max_active integer not null default 16 check (max_active between 1 and 100),
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into bot_population.control(singleton) values (true) on conflict do nothing;

create table if not exists bot_population.characters (
  id uuid primary key,
  name text not null check (char_length(name) between 2 and 24 and name !~* '^b_'),
  gender text not null check (gender in ('e', 'k')),
  cosmetic_vip boolean not null default false,
  avatar_key text check (avatar_key is null or avatar_key ~ '^[a-z0-9_-]{1,80}$'),
  chips bigint not null check (chips between 0 and 9007199254740991),
  initial_chips bigint not null check (initial_chips between 100000 and 300000),
  last_refill_day date,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists characters_name_idx on bot_population.characters(lower(name));

create table if not exists bot_population.leases (
  character_id uuid primary key references bot_population.characters(id),
  owner_id uuid not null,
  token uuid not null unique,
  expires_at timestamptz not null,
  room_key text,
  seat integer,
  game text,
  bet integer,
  active_match text,
  entered_at timestamptz not null default now(),
  check ((room_key is null and seat is null and game is null and bet is null and active_match is null)
    or (room_key is not null and char_length(room_key) between 1 and 120
      and seat is not null and game is not null and bet is not null
      and game in ('51', 'duz', 'banko', 'yuzbir', 'ihale', 'tavla')
      and seat between 0 and case when game = 'tavla' then 1 else 3 end
      and bet between 500 and 5000 and bet % 500 = 0))
);
create unique index if not exists leases_room_seat_idx on bot_population.leases(room_key, seat)
  where room_key is not null;

create table if not exists bot_population.ledger (
  id bigint generated always as identity primary key,
  character_id uuid not null references bot_population.characters(id),
  event_key text not null check (char_length(event_key) between 1 and 200),
  reason text not null check (reason in ('initial', 'daily_refill', 'entry', 'prize', 'refund')),
  delta bigint not null,
  balance_after bigint not null check (balance_after between 0 and 9007199254740991),
  created_at timestamptz not null default now(),
  unique(character_id, event_key)
);

create table if not exists bot_population.control_events (
  revision bigint primary key,
  actor text not null,
  mode text not null,
  max_active integer not null,
  created_at timestamptz not null default now()
);

alter table bot_population.control enable row level security;
alter table bot_population.characters enable row level security;
alter table bot_population.leases enable row level security;
alter table bot_population.ledger enable row level security;
alter table bot_population.control_events enable row level security;
revoke all on all tables in schema bot_population from public, anon, authenticated;
revoke all on all sequences in schema bot_population from public, anon, authenticated;
grant select on all tables in schema bot_population to service_role;

create or replace function bot_population.require_service()
returns void language plpgsql security definer set search_path = pg_catalog as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service_required'; end if;
end;
$$;
revoke all on function bot_population.require_service() from public, anon, authenticated;

create or replace function public.bot_population_seed(p_characters jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
declare v jsonb; v_id uuid; v_chips bigint; v_added integer := 0;
begin
  perform bot_population.require_service();
  perform 1 from bot_population.control where singleton for update;
  if jsonb_typeof(p_characters) is distinct from 'array' or jsonb_array_length(p_characters) <> 100 then
    raise exception 'pool_requires_100_characters';
  end if;
  if (select count(distinct x->>'id') from jsonb_array_elements(p_characters) x) <> 100 then
    raise exception 'duplicate_character';
  end if;
  for v in select value from jsonb_array_elements(p_characters) loop
    v_id := (v->>'id')::uuid;
    v_chips := (v->>'initial_chips')::bigint;
    insert into bot_population.characters(id, name, gender, cosmetic_vip, avatar_key, chips, initial_chips)
      values (v_id, btrim(v->>'name'), v->>'gender', coalesce((v->>'cosmetic_vip')::boolean, false),
        v->>'avatar_key', v_chips, v_chips) on conflict (id) do nothing;
    if found then
      v_added := v_added + 1;
      insert into bot_population.ledger(character_id, event_key, reason, delta, balance_after)
        values (v_id, 'initial', 'initial', v_chips, v_chips);
    end if;
  end loop;
  if (select count(*) from bot_population.characters) <> 100 then raise exception 'pool_identity_mismatch'; end if;
  return jsonb_build_object('ok', true, 'added', v_added);
end;
$$;

create or replace function public.bot_population_snapshot()
returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
begin
  perform bot_population.require_service();
  return jsonb_build_object(
    'control', (select to_jsonb(c) from bot_population.control c where singleton),
    'characters', (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]'::jsonb) from bot_population.characters c),
    'leases', (select coalesce(jsonb_agg(to_jsonb(l) order by l.character_id), '[]'::jsonb) from bot_population.leases l)
  );
end;
$$;

create or replace function public.bot_population_control(p_expected_revision bigint, p_mode text, p_max_active integer, p_actor text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
declare c bot_population.control;
begin
  perform bot_population.require_service();
  select * into c from bot_population.control where singleton for update;
  if p_expected_revision is distinct from c.revision then raise exception 'control_revision_conflict'; end if;
  if p_actor is null or char_length(btrim(p_actor)) not between 1 and 120 then raise exception 'actor_required'; end if;
  update bot_population.control set mode = p_mode, max_active = p_max_active,
    revision = revision + 1, updated_at = clock_timestamp() where singleton returning * into c;
  insert into bot_population.control_events(revision, actor, mode, max_active)
    values (c.revision, p_actor, c.mode, c.max_active);
  -- Existing matches are NOT evicted. The room owner drains them after normal completion.
  return to_jsonb(c);
end;
$$;

create or replace function public.bot_population_claim(
  p_character uuid, p_owner uuid, p_token uuid,
  p_room text default null, p_seat integer default null, p_game text default null, p_bet integer default null
)
returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
declare c bot_population.control; l bot_population.leases; v_now timestamptz := clock_timestamp(); v_balance bigint;
begin
  perform bot_population.require_service();
  -- One control lock serializes capacity/expiry/claim changes, then per-character locks.
  select * into c from bot_population.control where singleton for update;
  if c.mode <> 'running' then raise exception 'population_not_running'; end if;
  if p_owner is null or p_token is null then raise exception 'lease_identity_required'; end if;
  select chips into v_balance from bot_population.characters where id = p_character and enabled for update;
  if not found then raise exception 'character_unavailable'; end if;
  if p_bet is not null and v_balance < p_bet then raise exception 'insufficient_chips'; end if;
  -- Expired active matches stay fenced until recovery/refund, never get stolen by a new worker.
  delete from bot_population.leases where expires_at <= v_now and active_match is null;
  select * into l from bot_population.leases where character_id = p_character;
  if found then
    if l.owner_id <> p_owner or l.token <> p_token then raise exception 'character_busy'; end if;
    if l.expires_at <= v_now then raise exception 'lease_lost'; end if;
    if l.room_key is distinct from p_room or l.seat is distinct from p_seat
      or l.game is distinct from p_game or l.bet is distinct from p_bet then raise exception 'lease_payload_conflict'; end if;
    update bot_population.leases set expires_at = v_now + interval '45 seconds'
      where character_id = p_character returning * into l;
    return to_jsonb(l);
  end if;
  if (select count(*) from bot_population.leases) >= c.max_active then raise exception 'population_capacity'; end if;
  insert into bot_population.leases(character_id, owner_id, token, expires_at, room_key, seat, game, bet)
    values (p_character, p_owner, p_token, v_now + interval '45 seconds', p_room, p_seat, p_game, p_bet)
    returning * into l;
  return to_jsonb(l);
end;
$$;

create or replace function public.bot_population_heartbeat(p_character uuid, p_owner uuid, p_token uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
declare l bot_population.leases; v_mode text; v_now timestamptz := clock_timestamp();
begin
  perform bot_population.require_service();
  select mode into v_mode from bot_population.control where singleton for update;
  select * into l from bot_population.leases where character_id = p_character for update;
  if not found or l.owner_id is distinct from p_owner or l.token is distinct from p_token or l.expires_at <= v_now then
    raise exception 'lease_lost';
  end if;
  if v_mode <> 'running' and l.active_match is null then raise exception 'population_draining'; end if;
  update bot_population.leases set expires_at = v_now + interval '45 seconds'
    where character_id = p_character returning * into l;
  return to_jsonb(l);
end;
$$;

create or replace function public.bot_population_release(p_character uuid, p_owner uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, bot_population as $$
declare l bot_population.leases;
begin
  perform bot_population.require_service();
  perform 1 from bot_population.control where singleton for update;
  select * into l from bot_population.leases where character_id = p_character for update;
  if not found then return true; end if;
  if l.owner_id is distinct from p_owner or l.token is distinct from p_token then raise exception 'lease_lost'; end if;
  if l.active_match is not null then raise exception 'match_in_progress'; end if;
  delete from bot_population.leases where character_id = p_character;
  return true;
end;
$$;

create or replace function public.bot_population_refill(p_character uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
declare c bot_population.characters; l bot_population.leases;
  v_day date := (clock_timestamp() at time zone 'Europe/Istanbul')::date; v_target bigint;
begin
  perform bot_population.require_service();
  perform 1 from bot_population.control where singleton for update;
  select * into c from bot_population.characters where id = p_character for update;
  if not found then raise exception 'character_missing'; end if;
  select * into l from bot_population.leases where character_id = p_character;
  if found and (l.active_match is not null or (l.room_key is not null and l.expires_at > clock_timestamp())) then
    raise exception 'character_not_idle';
  end if;
  if c.chips >= 100000 or c.last_refill_day >= v_day then
    return jsonb_build_object('ok', true, 'refilled', false, 'chips', c.chips);
  end if;
  v_target := 100000 + floor(random() * 200001)::bigint;
  insert into bot_population.ledger(character_id, event_key, reason, delta, balance_after)
    values (c.id, 'daily_refill:' || v_day::text, 'daily_refill', v_target - c.chips, v_target);
  update bot_population.characters set chips = v_target, last_refill_day = v_day where id = c.id;
  return jsonb_build_object('ok', true, 'refilled', true, 'chips', v_target);
end;
$$;

revoke all on function public.bot_population_seed(jsonb) from public, anon, authenticated;
revoke all on function public.bot_population_snapshot() from public, anon, authenticated;
revoke all on function public.bot_population_control(bigint, text, integer, text) from public, anon, authenticated;
revoke all on function public.bot_population_claim(uuid, uuid, uuid, text, integer, text, integer) from public, anon, authenticated;
revoke all on function public.bot_population_heartbeat(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.bot_population_release(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.bot_population_refill(uuid) from public, anon, authenticated;
grant execute on function public.bot_population_seed(jsonb) to service_role;
grant execute on function public.bot_population_snapshot() to service_role;
grant execute on function public.bot_population_control(bigint, text, integer, text) to service_role;
grant execute on function public.bot_population_claim(uuid, uuid, uuid, text, integer, text, integer) to service_role;
grant execute on function public.bot_population_heartbeat(uuid, uuid, uuid) to service_role;
grant execute on function public.bot_population_release(uuid, uuid, uuid) to service_role;
grant execute on function public.bot_population_refill(uuid) to service_role;

commit;
