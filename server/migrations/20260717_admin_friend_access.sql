-- Online Kahvem - accepted administrator friendship access (2026-07-17)
-- Run after 20260716_admin_social_access.sql and 20260716_vip_entitlements.sql.

begin;

create or replace function public.can_view_profile_social(p_target text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and p_target is not null
     and (
       p_target = auth.uid()::text
       or public.is_current_user_admin()
       or (
         exists (
           select 1 from public.profiles admin_target
            where admin_target.id::text = p_target
              and admin_target.role = 'admin'
         )
         and exists (
           select 1 from public.friendships f
            where f.status = 'accepted'
              and ((f.requester::text = auth.uid()::text and f.addressee::text = p_target)
                or (f.addressee::text = auth.uid()::text and f.requester::text = p_target))
         )
       )
       or (
         public.is_current_user_vip()
         and not exists (
           select 1 from public.profiles admin_target
            where admin_target.id::text = p_target
              and admin_target.role = 'admin'
         )
         and (
           exists (
             select 1 from public.profiles p
              where p.id::text = p_target
                and coalesce(p.profile_visibility, 'open') = 'open'
           )
           or (
             exists (
               select 1 from public.profiles p
                where p.id::text = p_target
                  and p.profile_visibility = 'friends'
             )
             and exists (
               select 1 from public.friendships f
                where f.status = 'accepted'
                  and ((f.requester::text = auth.uid()::text and f.addressee::text = p_target)
                    or (f.addressee::text = auth.uid()::text and f.requester::text = p_target))
             )
           )
         )
       )
     );
$$;

create or replace function public.can_send_direct_message(p_to uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and p_to is not null
     and p_to <> auth.uid()
     and not exists (
       select 1 from public.profiles p
        where p.id::text = auth.uid()::text
          and p.message_banned_until is not null
          and p.message_banned_until > now()
     )
     and (
       public.is_current_user_admin()
       or (
         exists (
           select 1 from public.profiles p
            where p.id::text = p_to::text
              and coalesce(p.allow_dm, true)
         )
         and exists (
           select 1 from public.friendships f
            where f.status = 'accepted'
              and ((f.requester = auth.uid() and f.addressee = p_to)
                or (f.requester = p_to and f.addressee = auth.uid()))
         )
         and not exists (
           select 1 from public.blocks b
            where (b.blocker = auth.uid() and b.blocked = p_to)
               or (b.blocker = p_to and b.blocked = auth.uid())
         )
       )
     );
$$;

revoke execute on function public.can_view_profile_social(text) from public, anon;
revoke execute on function public.can_send_direct_message(uuid) from public, anon;
grant execute on function public.can_view_profile_social(text) to authenticated;
grant execute on function public.can_send_direct_message(uuid) to authenticated;

commit;
