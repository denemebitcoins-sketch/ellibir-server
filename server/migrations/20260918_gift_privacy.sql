create or replace function public.gift_recipients_allowed(p_users text[])
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select coalesce(auth.role(),'')='service_role' and p_users is not null and cardinality(p_users)<=4
    and not exists (select 1 from unnest(p_users) uid where not exists
      (select 1 from public.profiles p where p.id::text=uid and not coalesce(p.gift_off,false)));
$$;
revoke all on function public.gift_recipients_allowed(text[]) from public,anon,authenticated;
grant execute on function public.gift_recipients_allowed(text[]) to service_role;
