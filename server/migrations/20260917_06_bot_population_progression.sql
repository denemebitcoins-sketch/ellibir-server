-- Human progression is a durable, retryable transaction separate from chip settlement.
begin;
create table if not exists bot_population.progression_outbox (
  match_key text not null references bot_population.matches(match_key),
  seat integer not null,
  processed_at timestamptz,
  attempts integer not null default 0,
  retry_at timestamptz not null default now(),
  primary key(match_key, seat),
  foreign key(match_key, seat) references bot_population.match_seats(match_key, seat)
);
alter table bot_population.progression_outbox enable row level security;
revoke all on bot_population.progression_outbox from public, anon, authenticated;
grant select on bot_population.progression_outbox to service_role;

create or replace function bot_population.enqueue_progression()
returns trigger language plpgsql security definer set search_path=pg_catalog,bot_population as $$
begin
  if new.state='settled' and old.state='active' then
    insert into bot_population.progression_outbox(match_key,seat)
      select match_key,seat from bot_population.match_seats where match_key=new.match_key and kind='human'
      on conflict do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists population_progression on bot_population.matches;
create trigger population_progression after update of state on bot_population.matches
  for each row execute function bot_population.enqueue_progression();
revoke all on function bot_population.enqueue_progression() from public,anon,authenticated;

create or replace function public.bot_population_process_progression()
returns jsonb language plpgsql security definer set search_path=pg_catalog,bot_population as $$
declare o record; m bot_population.matches; s bot_population.match_seats;
  won boolean; winnings bigint; xp integer; result jsonb; done integer:=0; failed integer:=0;
  game_name text; variant text;
begin
  perform bot_population.require_service();
  for o in select * from bot_population.progression_outbox
    where processed_at is null and retry_at<=clock_timestamp()
    order by retry_at,match_key,seat for update skip locked limit 32 loop
    begin
      select * into strict m from bot_population.matches where match_key=o.match_key and state='settled';
      select * into strict s from bot_population.match_seats where match_key=o.match_key and seat=o.seat and kind='human';
      won := s.seat=m.winner_seat or (m.team_mode and s.seat%2=m.winner_seat%2);
      select greatest(0,coalesce(sum(delta),0)) into winnings from bot_population.match_wallet_entries
        where match_key=o.match_key and seat=o.seat;
      xp := 25 + case when won then 35 else 0 end + case when m.team_mode then 5 else 0 end
        + case when m.game='tavla' then 5 else 0 end
        + case when (select count(*) from bot_population.match_seats where match_key=o.match_key and kind='human')>=2 then 5 else 0 end;
      game_name := case when m.game in ('duz','banko','yuzbir') then 'okey' else m.game end;
      variant := case when m.game in ('duz','banko','yuzbir') then m.game else null end;
      perform public.record_match_stats(s.participant_id,won,winnings);
      result := public.grant_account_xp(s.participant_id,'match','population:'||m.match_key,xp,game_name,
        jsonb_build_object('won',won,'bet',m.bet,'winnerSeat',m.winner_seat,'teamMode',m.team_mode,'variant',variant,'population',true));
      if result->>'ok' is distinct from 'true' then raise exception 'progression_rejected'; end if;
      update bot_population.progression_outbox set processed_at=clock_timestamp(),attempts=attempts+1
        where match_key=o.match_key and seat=o.seat;
      done:=done+1;
    exception when others then
      -- The subtransaction rolls stats and XP back together before scheduling retry.
      update bot_population.progression_outbox set attempts=attempts+1,retry_at=clock_timestamp()+interval '1 minute'
        where match_key=o.match_key and seat=o.seat;
      failed:=failed+1;
    end;
  end loop;
  return jsonb_build_object('processed',done,'failed',failed,'pending',
    (select count(*) from bot_population.progression_outbox where processed_at is null));
end;
$$;
revoke all on function public.bot_population_process_progression() from public,anon,authenticated;
grant execute on function public.bot_population_process_progression() to service_role;
commit;
