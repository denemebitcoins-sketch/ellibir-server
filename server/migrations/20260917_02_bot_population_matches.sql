-- Apply after 20260917_01_bot_population_storage. Atomic escrow and settlement.
-- Service only. Ordinary all-human rooms retain their existing economy path.
begin;

create table if not exists bot_population.matches (
  match_key text primary key check (char_length(match_key) between 1 and 128),
  owner_id uuid not null,
  room_key text not null check (char_length(room_key) between 1 and 120),
  game text not null check (game in ('51', 'duz', 'banko', 'yuzbir', 'ihale', 'tavla')),
  bet integer not null check (bet between 500 and 5000 and bet % 500 = 0),
  team_mode boolean not null,
  roster jsonb not null,
  state text not null default 'active' check (state in ('active', 'settled', 'refunded')),
  winner_seat integer,
  house_amount bigint not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (game <> 'tavla' or not team_mode)
);
create table if not exists bot_population.match_seats (
  match_key text not null references bot_population.matches(match_key),
  seat integer not null check (seat between 0 and 3),
  kind text not null check (kind in ('bot', 'human')),
  participant_id text not null,
  lease_token uuid,
  released_at timestamptz,
  primary key(match_key, seat),
  unique(match_key, participant_id),
  check ((kind = 'bot' and lease_token is not null) or (kind = 'human' and lease_token is null))
);
create unique index if not exists match_seats_active_identity_idx
  on bot_population.match_seats(kind, participant_id) where released_at is null;

create table if not exists bot_population.match_wallet_entries (
  match_key text not null,
  seat integer not null,
  phase text not null check (phase in ('entry', 'prize', 'refund')),
  delta bigint not null,
  balance_after bigint not null,
  created_at timestamptz not null default now(),
  primary key(match_key, seat, phase),
  foreign key(match_key, seat) references bot_population.match_seats(match_key, seat)
);
alter table bot_population.matches enable row level security;
alter table bot_population.match_seats enable row level security;
alter table bot_population.match_wallet_entries enable row level security;
revoke all on bot_population.matches, bot_population.match_seats, bot_population.match_wallet_entries from public, anon, authenticated;
grant select on bot_population.matches, bot_population.match_seats, bot_population.match_wallet_entries to service_role;

create or replace function public.bot_population_begin_match(
  p_match text, p_owner uuid, p_room text, p_game text, p_bet integer, p_team boolean, p_roster jsonb
)
returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
declare m bot_population.matches; v jsonb; l bot_population.leases; v_roster jsonb;
  v_count integer; v_balance bigint; v_mode text; v_id text; v_seat integer;
begin
  perform bot_population.require_service();
  select mode into v_mode from bot_population.control where singleton for update;
  v_count := case when p_game = 'tavla' then 2 else 4 end;
  if jsonb_typeof(p_roster) is distinct from 'array' or jsonb_array_length(p_roster) <> v_count then
    raise exception 'roster_size';
  end if;
  select jsonb_agg(x order by (x->>'seat')::integer) into v_roster from jsonb_array_elements(p_roster) x;
  if (select count(distinct x->>'id') from jsonb_array_elements(v_roster) x) <> v_count
    or (select count(distinct (x->>'seat')::integer) from jsonb_array_elements(v_roster) x
        where (x->>'seat')::integer between 0 and v_count - 1) <> v_count then raise exception 'roster_identity'; end if;
  if not exists (select 1 from jsonb_array_elements(v_roster) x where x->>'kind' = 'bot') then
    raise exception 'population_match_requires_bot';
  end if;
  select * into m from bot_population.matches where match_key = p_match for update;
  if found then
    if m.owner_id is distinct from p_owner or m.room_key is distinct from p_room or m.game is distinct from p_game
      or m.bet is distinct from p_bet or m.team_mode is distinct from p_team or m.roster is distinct from v_roster then
      raise exception 'match_payload_conflict';
    end if;
    return to_jsonb(m);
  end if;
  if v_mode <> 'running' then raise exception 'population_not_running'; end if;
  insert into bot_population.matches(match_key, owner_id, room_key, game, bet, team_mode, roster)
    values (p_match, p_owner, p_room, p_game, p_bet, p_team, v_roster) returning * into m;
  -- Deterministic account lock order plus one transaction: no partial human/bot entry charge.
  for v in select value from jsonb_array_elements(v_roster) order by value->>'kind', value->>'id' loop
    v_id := v->>'id'; v_seat := (v->>'seat')::integer;
    if v_id is null or btrim(v_id) = '' then raise exception 'roster_identity'; end if;
    if v->>'kind' = 'bot' then
      select chips into v_balance from bot_population.characters where id = v_id::uuid and enabled for update;
      if not found then raise exception 'character_unavailable'; end if;
      select * into l from bot_population.leases where character_id = v_id::uuid for update;
      if not found or l.owner_id is distinct from p_owner or l.token is distinct from (v->>'token')::uuid
        or l.room_key is distinct from p_room or l.seat is distinct from v_seat or l.game is distinct from p_game
        or l.bet is distinct from p_bet or l.active_match is not null or l.expires_at <= clock_timestamp() then
        raise exception 'match_lease_lost';
      end if;
      if v_balance < p_bet then raise exception 'insufficient_chips'; end if;
      update bot_population.characters set chips = chips - p_bet where id = v_id::uuid;
      update bot_population.leases set active_match = p_match where character_id = v_id::uuid;
      insert into bot_population.ledger(character_id, event_key, reason, delta, balance_after)
        values (v_id::uuid, 'entry:' || p_match, 'entry', -p_bet, v_balance - p_bet);
    elsif v->>'kind' = 'human' then
      if v->>'token' is not null or exists (select 1 from bot_population.characters where id::text = v_id) then
        raise exception 'human_identity_invalid';
      end if;
      select chips into v_balance from public.profiles where id::text = v_id for update;
      if not found then raise exception 'human_profile_missing'; end if;
      if coalesce(v_balance, 0) < p_bet then raise exception 'insufficient_chips'; end if;
      update public.profiles set chips = chips - p_bet where id::text = v_id;
    else raise exception 'participant_kind_invalid';
    end if;
    insert into bot_population.match_seats(match_key, seat, kind, participant_id, lease_token)
      values (p_match, v_seat, v->>'kind', v_id, (v->>'token')::uuid);
    insert into bot_population.match_wallet_entries(match_key, seat, phase, delta, balance_after)
      values (p_match, v_seat, 'entry', -p_bet, v_balance - p_bet);
  end loop;
  return to_jsonb(m);
end;
$$;

create or replace function public.bot_population_get_match(p_match text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
begin
  perform bot_population.require_service();
  return (select to_jsonb(m) from bot_population.matches m where match_key = p_match);
end;
$$;

create or replace function public.bot_population_finish_match(p_match text, p_owner uuid, p_winner integer)
returns jsonb language plpgsql security definer set search_path = pg_catalog, bot_population as $$
declare m bot_population.matches; s bot_population.match_seats; l bot_population.leases;
  v_count integer; v_credit bigint; v_balance bigint; v_house bigint; v_phase text;
begin
  perform bot_population.require_service();
  perform 1 from bot_population.control where singleton for update;
  select * into m from bot_population.matches where match_key = p_match for update;
  if not found then raise exception 'match_missing'; end if;
  if m.owner_id is distinct from p_owner then raise exception 'match_owner_lost'; end if;
  v_count := jsonb_array_length(m.roster);
  if p_winner is not null and (p_winner < 0 or p_winner >= v_count) then raise exception 'winner_invalid'; end if;
  if m.state <> 'active' then
    if m.winner_seat is distinct from p_winner then raise exception 'settlement_payload_conflict'; end if;
    return to_jsonb(m);
  end if;
  v_phase := case when p_winner is null then 'refund' else 'prize' end;
  v_house := case when p_winner is null then 0 else v_count * m.bet / 10 end;
  for s in select * from bot_population.match_seats where match_key = p_match order by kind, participant_id loop
    v_credit := case when p_winner is null then m.bet
      when s.seat = p_winner or (m.team_mode and s.seat % 2 = p_winner % 2)
        then (v_count * m.bet - v_house) / case when m.team_mode then 2 else 1 end
      else 0 end;
    if s.kind = 'bot' then
      select chips into v_balance from bot_population.characters where id = s.participant_id::uuid for update;
      if not found then raise exception 'character_missing'; end if;
      select * into l from bot_population.leases where character_id = s.participant_id::uuid for update;
      if not found or l.owner_id is distinct from p_owner or l.token is distinct from s.lease_token
        or l.active_match is distinct from p_match then raise exception 'match_lease_lost'; end if;
      if v_credit > 0 then
        update bot_population.characters set chips = chips + v_credit where id = s.participant_id::uuid;
        insert into bot_population.ledger(character_id, event_key, reason, delta, balance_after)
          values (s.participant_id::uuid, v_phase || ':' || p_match, v_phase, v_credit, v_balance + v_credit);
      end if;
      update bot_population.leases set active_match = null where character_id = s.participant_id::uuid;
    else
      select chips into v_balance from public.profiles where id::text = s.participant_id for update;
      if not found then raise exception 'human_profile_missing'; end if;
      if v_credit > 0 then update public.profiles set chips = chips + v_credit where id::text = s.participant_id; end if;
    end if;
    if v_credit > 0 then
      insert into bot_population.match_wallet_entries(match_key, seat, phase, delta, balance_after)
        values (p_match, s.seat, v_phase, v_credit, v_balance + v_credit);
    end if;
  end loop;
  update bot_population.match_seats set released_at = clock_timestamp() where match_key = p_match;
  update bot_population.matches set state = case when p_winner is null then 'refunded' else 'settled' end,
    winner_seat = p_winner, house_amount = v_house, completed_at = clock_timestamp()
    where match_key = p_match returning * into m;
  -- No jackpot or quest-event RPCs: every match in this table started with a bot.
  return to_jsonb(m);
end;
$$;

revoke all on function public.bot_population_begin_match(text, uuid, text, text, integer, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.bot_population_finish_match(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.bot_population_get_match(text) from public, anon, authenticated;
grant execute on function public.bot_population_begin_match(text, uuid, text, text, integer, boolean, jsonb) to service_role;
grant execute on function public.bot_population_finish_match(text, uuid, integer) to service_role;
grant execute on function public.bot_population_get_match(text) to service_role;
commit;
