-- Explicit bot identities; never insert simulated humans into auth/profiles/presence.
begin;
create or replace function public.bot_population_public_presence()
returns setof jsonb language plpgsql security definer set search_path=pg_catalog,bot_population as $$
begin
  if coalesce(auth.role(),'') not in ('authenticated','service_role') then raise exception 'auth_required'; end if;
  return query select jsonb_build_object(
    'user_id','bot:'||c.id::text,'is_system_bot',true,'name',c.name,'gender',c.gender,
    'role',case when c.cosmetic_vip then 'vip' else 'normal' end,'chips',c.chips,
    'status',case when l.room_key is null then 'lobi' else 'masada' end,
    'table_no',coalesce(h.table_no,0),'table_seat',coalesce(l.seat,-1),
    'table_mode',case when h.room_key is null then '' else
      (case when h.game in ('duz','banko','yuzbir') then 'okey-' when h.game='ihale' then 'ihale-'
        when h.game='tavla' then 'tavla-' else '' end)||case when h.team_mode then 'duo' else 'solo' end end,
    'table_info',case when h.room_key is null then '' else
      (case h.game when 'yuzbir' then '101' when 'banko' then 'BANKO' when 'duz' then 'KLASIK' when 'ihale' then 'IHALE' when 'tavla' then 'TAVLA' else '51' end)
      ||' · '||case when h.team_mode then 'ESLI' else 'TEK' end||' · '||h.bet||' çip' end,
    'table_started',l.active_match is not null,'allow_dm',false,'allow_friend_req',false,'gift_off',true,
    'invite_pref',case when l.room_key is null and ctl.mode='running' then 'open' else 'closed' end,
    'avatar_url',case when c.avatar_key in ('arzu-v1','mithat-v1') then 'population:'||c.avatar_key else '' end,
    'last_seen',clock_timestamp(),'account_level',1
  ) from bot_population.leases l join bot_population.characters c on c.id=l.character_id
    cross join bot_population.control ctl left join bot_population.room_hosts h on h.room_key=l.room_key
    where c.enabled and l.expires_at>clock_timestamp()
      and (l.room_key is null or (h.expires_at>clock_timestamp() and h.owner_id=l.owner_id))
    order by c.name limit 100;
end;
$$;
revoke all on function public.bot_population_public_presence() from public,anon;
grant execute on function public.bot_population_public_presence() to authenticated,service_role;
commit;
