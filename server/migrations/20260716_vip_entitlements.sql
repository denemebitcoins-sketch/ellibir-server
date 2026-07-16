-- Online Kahvem - VIP entitlement authority (2026-07-16)
-- The storefront lists only benefits that are enforced here or by an existing RPC.

begin;

create or replace function public.is_current_user_vip()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.profiles p
     where p.id::text = auth.uid()::text
       and (
         p.role = 'admin'
         or (p.vip_until is not null and p.vip_until > now())
       )
  );
$$;

revoke execute on function public.is_current_user_vip() from public, anon;
grant execute on function public.is_current_user_vip() to authenticated;

-- Basic profile identity remains visible. This function controls the private/social
-- surface only: wall, posts, likes, comments and friend list RPCs/policies.
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

revoke execute on function public.can_view_profile_social(text) from public, anon;
grant execute on function public.can_view_profile_social(text) to authenticated;

-- Re-state the write policies so direct REST calls obey the same storefront contract.
drop policy if exists post_likes_insert on public.post_likes;
create policy post_likes_insert on public.post_likes
  for insert to authenticated
  with check (auth.uid() = user_id and public.can_view_post_social(post_id));

drop policy if exists post_comments_insert on public.post_comments;
create policy post_comments_insert on public.post_comments
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and public.can_write_social()
    and public.can_view_post_social(post_id)
  );

commit;
