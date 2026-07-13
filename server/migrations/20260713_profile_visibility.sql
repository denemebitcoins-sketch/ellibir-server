-- Online Kahvem - profile social visibility (2026-07-13)
-- Supabase SQL Editor'da bir kez calistirin. Idempotenttir.

begin;

alter table public.profiles
  add column if not exists profile_visibility text not null default 'open';

alter table public.profiles drop constraint if exists profiles_profile_visibility_check;
alter table public.profiles add constraint profiles_profile_visibility_check
  check (profile_visibility in ('open', 'friends', 'hidden')) not valid;

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
       or exists (
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
     );
$$;
revoke execute on function public.can_view_profile_social(text) from public, anon;
grant execute on function public.can_view_profile_social(text) to authenticated;

create or replace function public.profile_social_access(p_user text)
returns table(visibility text, can_view_social boolean)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
           select p.profile_visibility from public.profiles p where p.id::text = p_user
         ), 'hidden') as visibility,
         public.can_view_profile_social(p_user) as can_view_social;
$$;
revoke execute on function public.profile_social_access(text) from public, anon;
grant execute on function public.profile_social_access(text) to authenticated;

create or replace function public.friend_count(p_user text)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_view_profile_social(p_user) then return -1; end if;
  return (
    select count(*)::integer from public.friendships f
     where f.status = 'accepted'
       and (f.requester::text = p_user or f.addressee::text = p_user)
  );
end;
$$;
revoke execute on function public.friend_count(text) from public, anon;
grant execute on function public.friend_count(text) to authenticated;

create or replace function public.profile_friends(p_user text)
returns table(
  id text,
  name text,
  gender text,
  role text,
  chips bigint,
  avatar_url text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_view_profile_social(p_user) then return; end if;

  return query
  select p.id::text,
         coalesce(nullif(p.name, ''), 'Oyuncu'),
         p.gender,
         case
           when p.role = 'admin' then 'admin'
           when p.vip_until is not null and p.vip_until > now() then 'vip'
           else 'normal'
         end,
         greatest(coalesce(p.chips, 0), 0),
         case when coalesce(p.avatar_status, 'visible') = 'visible' then p.avatar_url else null end
    from public.friendships f
    join public.profiles p
      on p.id::text = case
           when f.requester::text = p_user then f.addressee::text
           else f.requester::text
         end
   where f.status = 'accepted'
     and (f.requester::text = p_user or f.addressee::text = p_user)
   order by lower(coalesce(nullif(p.name, ''), 'Oyuncu'));
end;
$$;
revoke execute on function public.profile_friends(text) from public, anon;
grant execute on function public.profile_friends(text) to authenticated;

create or replace function public.can_view_post_social(p_post bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.posts p
     where p.id = p_post
       and public.can_view_profile_social(p.user_id::text)
  );
$$;
revoke execute on function public.can_view_post_social(bigint) from public, anon;
grant execute on function public.can_view_post_social(bigint) to authenticated;

drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts
  for select to authenticated
  using (public.can_view_profile_social(user_id::text));

drop policy if exists post_likes_select on public.post_likes;
create policy post_likes_select on public.post_likes
  for select to authenticated
  using (public.can_view_post_social(post_id));
drop policy if exists post_likes_insert on public.post_likes;
create policy post_likes_insert on public.post_likes
  for insert to authenticated
  with check (auth.uid() = user_id and public.can_view_post_social(post_id));

drop policy if exists post_comments_select on public.post_comments;
create policy post_comments_select on public.post_comments
  for select to authenticated
  using (public.can_view_post_social(post_id));
drop policy if exists post_comments_insert on public.post_comments;
create policy post_comments_insert on public.post_comments
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and public.can_write_social()
    and public.can_view_post_social(post_id)
  );

commit;
