-- Hide bot arrivals/departures for every client; keep the existing VIP chat budget.
begin;
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
  update bot_population.social_seen set published_online=(character_id=any(ids)),changed_at=stamp
    where published_online <> (character_id=any(ids));
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

create or replace function public.bot_population_public_social()
returns setof jsonb language plpgsql security definer set search_path=pg_catalog,bot_population as $$
begin
  if coalesce(auth.role(),'') not in ('authenticated','service_role') then raise exception 'auth_required'; end if;
  return query select jsonb_build_object('id',-e.id,'user_id','bot:'||e.character_id::text,
    'is_system_bot',true,'name',e.name,'role',e.role,'text',e.text,'created_at',e.created_at,
    'bot_chips',c.chips,'bot_gender',c.gender,'kind','bot')
    from bot_population.social_events e join bot_population.characters c on c.id=e.character_id
    where e.event='greeting' and e.created_at > clock_timestamp()-interval '20 minutes'
    order by e.created_at desc,e.id desc limit 12;
end;
$$;
revoke all on function public.bot_population_process_social() from public,anon,authenticated;
grant execute on function public.bot_population_process_social() to service_role;
revoke all on function public.bot_population_public_social() from public,anon;
grant execute on function public.bot_population_public_social() to authenticated,service_role;
commit;
