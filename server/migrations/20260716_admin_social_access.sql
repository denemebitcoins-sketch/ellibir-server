-- Online Kahvem - administrator social access matrix (2026-07-16)
-- Normal/VIP users cannot inspect, friend or DM an administrator.
-- Administrators can inspect and DM every player without privacy/friend/block gates.

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
         not exists (
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
         not exists (
           select 1 from public.profiles admin_target
            where admin_target.id::text = p_to::text
              and admin_target.role = 'admin'
         )
         and exists (
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

create or replace function public.can_send_friend_request(p_to uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and p_to is not null
     and p_to <> auth.uid()
     and (
       public.is_current_user_admin()
       or (
         not exists (
           select 1 from public.profiles admin_target
            where admin_target.id::text = p_to::text
              and admin_target.role = 'admin'
         )
         and exists (
           select 1 from public.profiles p
            where p.id::text = p_to::text
              and coalesce(p.allow_friend_req, true)
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
revoke execute on function public.can_send_friend_request(uuid) from public, anon;
grant execute on function public.can_view_profile_social(text) to authenticated;
grant execute on function public.can_send_direct_message(uuid) to authenticated;
grant execute on function public.can_send_friend_request(uuid) to authenticated;

drop policy if exists dm_insert on public.direct_messages;
create policy dm_insert on public.direct_messages
  for insert to authenticated
  with check (
    auth.uid() = from_user
    and public.can_send_direct_message(to_user)
  );

drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships
  for insert to authenticated
  with check (
    auth.uid() = requester
    and public.can_send_friend_request(addressee)
  );

commit;
