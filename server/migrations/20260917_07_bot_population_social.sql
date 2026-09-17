-- Separate bot feed. Never forge human profiles or relax lobby_chat policies.
begin;
create table if not exists bot_population.social_control (
  singleton boolean primary key default true check(singleton),
  next_event_at timestamptz not null default now(),
  next_chat_at timestamptz not null default now() + interval '8 minutes'
);
insert into bot_population.social_control(singleton) values(true) on conflict do nothing;
create table if not exists bot_population.social_seen (
  character_id uuid primary key references bot_population.characters(id),
  published_online boolean not null default false,
  changed_at timestamptz not null default now(),
  last_message_at timestamptz
);
create table if not exists bot_population.social_events (
  id bigint generated always as identity primary key,
  character_id uuid not null references bot_population.characters(id),
  event text not null check(event in ('joined','left','greeting')),
  name text not null,
  role text not null check(role in ('normal','vip')),
  text text not null check(char_length(text) between 1 and 150),
  created_at timestamptz not null default now()
);
alter table bot_population.social_control enable row level security;
alter table bot_population.social_seen enable row level security;
alter table bot_population.social_events enable row level security;
revoke all on bot_population.social_control,bot_population.social_seen,bot_population.social_events
  from public,anon,authenticated;
revoke all on sequence bot_population.social_events_id_seq from public,anon,authenticated;
grant select on bot_population.social_control,bot_population.social_seen,bot_population.social_events to service_role;

create or replace function public.bot_population_process_social()
returns jsonb language plpgsql security definer set search_path=pg_catalog,bot_population as $$
declare ctl bot_population.social_control; ids uuid[]; candidate record;
  stamp timestamptz; emitted integer := 0; message text;
begin
  perform bot_population.require_service();
  select * into ctl from bot_population.social_control where singleton for update;
  stamp := clock_timestamp();
  select coalesce(array_agg(substring(p->>'user_id' from 5)::uuid),'{}'::uuid[])
    into ids from public.bot_population_public_presence() p;
  insert into bot_population.social_seen(character_id)
    select id from bot_population.characters on conflict do nothing;
  if ctl.next_event_at <= stamp then
    select c.id,c.name,c.cosmetic_vip,s.published_online into candidate
      from bot_population.social_seen s join bot_population.characters c on c.id=s.character_id
      where s.published_online <> (c.id=any(ids))
      order by s.published_online desc,s.changed_at,c.id limit 1;
    if found then
      message := candidate.name || ' (Bot) ' || case when candidate.published_online
        then U&'lobiden ayr\0131ld\0131.' else U&'lobiye kat\0131ld\0131.' end;
      insert into bot_population.social_events(character_id,event,name,role,text,created_at)
        values(candidate.id,case when candidate.published_online then 'left' else 'joined' end,
          candidate.name,case when candidate.cosmetic_vip then 'vip' else 'normal' end,message,stamp);
      update bot_population.social_seen set published_online=not candidate.published_online,changed_at=stamp
        where character_id=candidate.id;
      update bot_population.social_control set next_event_at=stamp+interval '30 seconds' where singleton;
      emitted := emitted+1;
    end if;
  end if;
  if ctl.next_chat_at <= stamp
    and exists(select 1 from bot_population.control where mode='running')
    and exists(select 1 from public.presence where last_seen > stamp-interval '90 seconds'
      and coalesce(status,'offline') <> 'offline') then
    select c.id,c.name,s.last_message_at into candidate
      from bot_population.characters c join bot_population.social_seen s on s.character_id=c.id
      join bot_population.leases l on l.character_id=c.id
      where c.id=any(ids) and c.cosmetic_vip and s.published_online and l.room_key is null
      order by s.last_message_at nulls first,c.id limit 1;
    if found then
      message := case when candidate.last_message_at is null then 'Herkese iyi oyunlar.'
        else U&'Bol \015fans, keyifli oyunlar.' end;
      insert into bot_population.social_events(character_id,event,name,role,text,created_at)
        values(candidate.id,'greeting',candidate.name,'vip',message,stamp);
      update bot_population.social_seen set last_message_at=stamp where character_id=candidate.id;
      update bot_population.social_control set next_chat_at=stamp+interval '8 minutes' where singleton;
      emitted := emitted+1;
    end if;
  end if;
  delete from bot_population.social_events where created_at < stamp-interval '1 day'
    or id in (select id from bot_population.social_events order by id desc offset 200);
  return jsonb_build_object('emitted',emitted);
end;
$$;
revoke all on function public.bot_population_process_social() from public,anon,authenticated;
grant execute on function public.bot_population_process_social() to service_role;

create or replace function public.bot_population_public_social()
returns setof jsonb language plpgsql security definer set search_path=pg_catalog,bot_population as $$
begin
  if coalesce(auth.role(),'') not in ('authenticated','service_role') then raise exception 'auth_required'; end if;
  return query select jsonb_build_object('id',-e.id,'user_id','bot:'||e.character_id::text,
    'is_system_bot',true,'name',e.name,'role',e.role,'text',e.text,'created_at',e.created_at,
    'bot_chips',c.chips,'bot_gender',c.gender,
    'kind',case when e.event='greeting' then 'bot' else 'system' end)
    from bot_population.social_events e join bot_population.characters c on c.id=e.character_id
    where e.created_at > clock_timestamp()-interval '20 minutes'
    order by e.created_at desc,e.id desc limit 12;
end;
$$;
revoke all on function public.bot_population_public_social() from public,anon;
grant execute on function public.bot_population_public_social() to authenticated,service_role;

-- Extend the already-authorized clear operation without changing human chat RLS or RPC.
create or replace function bot_population.on_lobby_clear()
returns trigger language plpgsql security definer set search_path=pg_catalog,bot_population as $$
begin
  perform 1 from bot_population.social_control where singleton for update;
  delete from bot_population.social_events;
  update bot_population.social_control set next_event_at=clock_timestamp()+interval '30 seconds',
    next_chat_at=clock_timestamp()+interval '8 minutes' where singleton;
  return new;
end;
$$;
revoke all on function bot_population.on_lobby_clear() from public,anon,authenticated;
drop trigger if exists trg_bot_population_lobby_clear on public.lobby_chat_clear_audit;
create trigger trg_bot_population_lobby_clear after insert on public.lobby_chat_clear_audit
  for each row execute function bot_population.on_lobby_clear();
commit;
