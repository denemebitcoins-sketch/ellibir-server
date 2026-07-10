-- Online Kahvem - profile/DM authority hardening (2026-07-10)
-- Supabase SQL Editor'da bir kez calistirin. Idempotenttir.

begin;

create or replace function public.is_current_user_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id::text = auth.uid()::text
       and p.role = 'admin'
  );
$$;
revoke execute on function public.is_current_user_admin() from public, anon;
grant execute on function public.is_current_user_admin() to authenticated;

drop policy if exists reports_delete on public.reports;
create policy reports_delete on public.reports
  for delete to authenticated
  using (public.is_current_user_admin());

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
  for update to authenticated
  using (public.is_current_user_admin())
  with check (public.is_current_user_admin());

alter table public.profiles
  add column if not exists message_banned_until timestamptz;

alter table public.bans add column if not exists created_by_name text;

alter table public.bans drop constraint if exists bans_type_check;
alter table public.bans add constraint bans_type_check
  check (type in ('chat','message','game')) not valid;

create table if not exists public.blocks (
  id         bigint generated always as identity primary key,
  blocker    uuid not null references auth.users(id) on delete cascade,
  blocked    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (blocker, blocked),
  check (blocker <> blocked)
);
create index if not exists blocks_blocker_idx on public.blocks (blocker, created_at desc);
create index if not exists blocks_blocked_idx on public.blocks (blocked, created_at desc);
alter table public.blocks enable row level security;
drop policy if exists blocks_select on public.blocks;
create policy blocks_select on public.blocks
  for select to authenticated
  using (auth.uid() = blocker or auth.uid() = blocked);
drop policy if exists blocks_insert on public.blocks;
create policy blocks_insert on public.blocks
  for insert to authenticated
  with check (auth.uid() = blocker and blocker <> blocked);
drop policy if exists blocks_delete on public.blocks;
create policy blocks_delete on public.blocks
  for delete to authenticated
  using (auth.uid() = blocker);

create or replace function public.profiles_guard_client_sensitive()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  jwt_role text := coalesce(auth.role(), '');
  is_admin boolean := false;
begin
  if jwt_role = 'service_role' or current_user in ('postgres', 'service_role') then
    return new;
  end if;
  if auth.uid() is not null then
    is_admin := public.is_current_user_admin();
  end if;
  if is_admin then return new; end if;

  if TG_OP = 'INSERT' then
    new.chips := 5000;
    new.diamonds := 5;
    new.matches := 0;
    new.wins := 0;
    new.best_streak := 0;
    new.cur_streak := 0;
    new.total_won := 0;
    new.vip_until := null;
    new.last_daily := null;
    new.daily_day := 0;
    new.vip_daily_day := 0;
    new.vip_last_daily := null;
    new.role := 'normal';
    new.banned := false;
    new.chat_banned_until := null;
    new.message_banned_until := null;
    new.game_banned_until := null;
    new.avatar_status := 'visible';
  elsif TG_OP = 'UPDATE' then
    new.chips := old.chips;
    new.diamonds := old.diamonds;
    new.matches := old.matches;
    new.wins := old.wins;
    new.best_streak := old.best_streak;
    new.cur_streak := old.cur_streak;
    new.total_won := old.total_won;
    new.vip_until := old.vip_until;
    new.last_daily := old.last_daily;
    new.daily_day := old.daily_day;
    new.vip_daily_day := old.vip_daily_day;
    new.vip_last_daily := old.vip_last_daily;
    new.role := old.role;
    new.banned := old.banned;
    new.chat_banned_until := old.chat_banned_until;
    new.message_banned_until := old.message_banned_until;
    new.game_banned_until := old.game_banned_until;
    new.avatar_status := case when new.avatar_status = 'pending' then 'pending' else old.avatar_status end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_guard_client_sensitive on public.profiles;
create trigger trg_profiles_guard_client_sensitive
before insert or update on public.profiles
for each row execute function public.profiles_guard_client_sensitive();

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
     );
$$;
revoke execute on function public.can_send_direct_message(uuid) from public, anon;
grant execute on function public.can_send_direct_message(uuid) to authenticated;

drop policy if exists dm_insert on public.direct_messages;
create policy dm_insert on public.direct_messages
  for insert to authenticated
  with check (
    auth.uid() = from_user
    and public.can_send_direct_message(to_user)
  );

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
     and exists (
       select 1 from public.profiles p
        where p.id::text = p_to::text
          and coalesce(p.allow_friend_req, true)
     )
     and not exists (
       select 1 from public.blocks b
        where (b.blocker = auth.uid() and b.blocked = p_to)
           or (b.blocker = p_to and b.blocked = auth.uid())
     );
$$;
revoke execute on function public.can_send_friend_request(uuid) from public, anon;
grant execute on function public.can_send_friend_request(uuid) to authenticated;

drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships
  for insert to authenticated
  with check (
    auth.uid() = requester
    and public.can_send_friend_request(addressee)
  );

commit;
