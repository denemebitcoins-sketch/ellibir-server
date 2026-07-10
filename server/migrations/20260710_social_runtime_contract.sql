-- Online Kahvem - active social runtime contract (2026-07-10)
-- Run after 20260710_profile_dm_authority_hardening.sql.

begin;
-- ─────────────────────────────────────────────────────────────────────
-- BÖLÜM 43) AKTİF SOSYAL RUNTIME SÖZLEŞMESİ (2026-07-10)
-- Unity'nin kullandığı tüm sosyal tablo/kolon/RLS/trigger tanımları.
-- ─────────────────────────────────────────────────────────────────────

alter table public.profiles add column if not exists name text not null default 'Oyuncu';
alter table public.profiles add column if not exists avatar int not null default 0;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists gender text;
alter table public.profiles add column if not exists invite_pref text not null default 'open';
alter table public.profiles add column if not exists allow_dm boolean not null default true;
alter table public.profiles add column if not exists allow_friend_req boolean not null default true;
alter table public.profiles add column if not exists gift_off boolean not null default false;
alter table public.profiles add column if not exists avatar_status text not null default 'visible';

alter table public.reports add column if not exists reported_user uuid;
alter table public.reports add column if not exists reported_name text;
alter table public.reports add column if not exists reported_text text;
alter table public.reports add column if not exists context text;

alter table public.presence add column if not exists gender text;
alter table public.presence add column if not exists role text not null default 'normal';
alter table public.presence add column if not exists chips bigint not null default 0;
alter table public.presence add column if not exists status text not null default 'lobi';
alter table public.presence add column if not exists table_no int not null default 0;
alter table public.presence add column if not exists table_mode text;
alter table public.presence add column if not exists table_info text;
alter table public.presence add column if not exists table_started boolean not null default false;
alter table public.presence add column if not exists table_seat int not null default -1;
alter table public.presence add column if not exists allow_dm boolean not null default true;
alter table public.presence add column if not exists allow_friend_req boolean not null default true;
alter table public.presence add column if not exists invite_pref text not null default 'open';
alter table public.presence add column if not exists gift_off boolean not null default false;
alter table public.presence add column if not exists avatar_url text;
alter table public.presence alter column last_seen set default now();

create or replace function public.presence_enforce_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare p record;
begin
  new.last_seen := now();
  select name, gender, role, chips, vip_until, avatar_url, avatar_status,
         allow_dm, allow_friend_req, invite_pref, gift_off
    into p
    from public.profiles
   where id::text = new.user_id::text;

  if found then
    new.name := coalesce(nullif(p.name, ''), 'Oyuncu');
    new.gender := p.gender;
    new.role := case
      when p.role = 'admin' then 'admin'
      when p.vip_until is not null and p.vip_until > now() then 'vip'
      else 'normal'
    end;
    new.chips := greatest(coalesce(p.chips, 0), 0);
    new.avatar_url := case
      when coalesce(p.avatar_status, 'visible') = 'visible' then p.avatar_url
      else null
    end;
    new.allow_dm := coalesce(p.allow_dm, true);
    new.allow_friend_req := coalesce(p.allow_friend_req, true);
    new.invite_pref := case when p.invite_pref in ('open','friends','closed')
                            then p.invite_pref else 'open' end;
    new.gift_off := coalesce(p.gift_off, false);
  end if;
  return new;
end;
$$;
revoke all on function public.presence_enforce_profile() from public;

drop trigger if exists trg_presence_touch on public.presence;
drop trigger if exists trg_presence_enforce_profile on public.presence;
create trigger trg_presence_enforce_profile
before insert or update on public.presence
for each row execute function public.presence_enforce_profile();

create or replace function public.can_write_social()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id::text = auth.uid()::text
       and (p.chat_banned_until is null or p.chat_banned_until <= now())
  );
$$;
revoke execute on function public.can_write_social() from public, anon;
grant execute on function public.can_write_social() to authenticated;

create or replace function public.can_write_lobby_chat()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id::text = auth.uid()::text
       and (p.chat_banned_until is null or p.chat_banned_until <= now())
       and (p.role = 'admin' or (p.vip_until is not null and p.vip_until > now()))
  );
$$;
revoke execute on function public.can_write_lobby_chat() from public, anon;
grant execute on function public.can_write_lobby_chat() to authenticated;

alter table public.lobby_chat add column if not exists kind text not null default 'msg';
alter table public.lobby_chat add column if not exists event text;

create or replace function public.lobby_chat_enforce_actor()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare p record;
begin
  -- Güvenilir SECURITY DEFINER sistem akışı kind='system' satırını korur.
  if current_user in ('postgres', 'service_role') and new.kind = 'system' then
    new.created_at := now();
    return new;
  end if;

  select name, role, vip_until into p
    from public.profiles where id::text = new.user_id::text;
  new.name := coalesce(nullif(p.name, ''), 'Oyuncu');
  new.role := case
    when p.role = 'admin' then 'admin'
    when p.vip_until is not null and p.vip_until > now() then 'vip'
    else 'normal'
  end;
  new.kind := 'msg';
  new.event := null;
  new.created_at := now();
  return new;
end;
$$;
revoke all on function public.lobby_chat_enforce_actor() from public;
drop trigger if exists trg_lobby_chat_enforce_actor on public.lobby_chat;
create trigger trg_lobby_chat_enforce_actor
before insert on public.lobby_chat
for each row execute function public.lobby_chat_enforce_actor();

drop policy if exists lobby_chat_insert on public.lobby_chat;
create policy lobby_chat_insert on public.lobby_chat
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and kind = 'msg'
    and public.can_write_lobby_chat()
  );

create or replace function public.reports_enforce_sender()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_name text;
begin
  select coalesce(nullif(p.name, ''), 'Oyuncu') into v_name
    from public.profiles p where p.id::text = new.from_user::text;
  new.name := coalesce(v_name, 'Oyuncu');
  return new;
end;
$$;
revoke all on function public.reports_enforce_sender() from public;
drop trigger if exists trg_reports_enforce_sender on public.reports;
create trigger trg_reports_enforce_sender
before insert on public.reports
for each row execute function public.reports_enforce_sender();

create table if not exists public.invites (
  id         bigint generated always as identity primary key,
  from_user  uuid not null references auth.users(id) on delete cascade,
  from_name  text,
  to_user    uuid not null references auth.users(id) on delete cascade,
  mode       text not null default 'solo',
  table_no   int not null default 1,
  bet        bigint not null default 0,
  created_at timestamptz not null default now(),
  seen       boolean not null default false,
  check (from_user <> to_user),
  check (char_length(mode) between 1 and 48),
  check (table_no between 1 and 10),
  check (bet >= 0)
);
create index if not exists invites_to_user_idx on public.invites (to_user, created_at desc);
create index if not exists invites_from_user_idx on public.invites (from_user, created_at desc);
alter table public.invites enable row level security;

create or replace function public.can_send_invite(p_to uuid)
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
       select 1 from public.blocks b
        where (b.blocker = auth.uid() and b.blocked = p_to)
           or (b.blocker = p_to and b.blocked = auth.uid())
     )
     and exists (
       select 1 from public.profiles p
        where p.id::text = p_to::text
          and (
            coalesce(p.invite_pref, 'open') = 'open'
            or (
              p.invite_pref = 'friends'
              and exists (
                select 1 from public.friendships f
                 where f.status = 'accepted'
                   and ((f.requester = auth.uid() and f.addressee = p_to)
                     or (f.requester = p_to and f.addressee = auth.uid()))
              )
            )
          )
     );
$$;
revoke execute on function public.can_send_invite(uuid) from public, anon;
grant execute on function public.can_send_invite(uuid) to authenticated;

create or replace function public.invites_enforce_sender()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_name text;
begin
  delete from public.invites where created_at < now() - interval '1 day';
  select coalesce(nullif(p.name, ''), 'Oyuncu') into v_name
    from public.profiles p where p.id::text = new.from_user::text;
  new.from_name := coalesce(v_name, 'Oyuncu');
  new.created_at := now();
  return new;
end;
$$;
revoke all on function public.invites_enforce_sender() from public;
drop trigger if exists trg_invites_enforce_sender on public.invites;
create trigger trg_invites_enforce_sender
before insert on public.invites
for each row execute function public.invites_enforce_sender();

drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites
  for insert to authenticated
  with check (auth.uid() = from_user and public.can_send_invite(to_user));
drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites
  for select to authenticated
  using (auth.uid() = from_user or auth.uid() = to_user);
drop policy if exists invites_update on public.invites;
create policy invites_update on public.invites
  for update to authenticated
  using (auth.uid() = to_user)
  with check (auth.uid() = to_user);
drop policy if exists invites_delete on public.invites;
create policy invites_delete on public.invites
  for delete to authenticated
  using (auth.uid() = from_user or auth.uid() = to_user);

create table if not exists public.posts (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null default 'status' check (kind in ('status','activity')),
  text       text not null check (char_length(text) between 1 and 280),
  created_at timestamptz not null default now()
);
create index if not exists posts_user_idx on public.posts (user_id, created_at desc);
alter table public.posts enable row level security;
drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts
  for select to authenticated using (true);
drop policy if exists posts_insert on public.posts;
create policy posts_insert on public.posts
  for insert to authenticated
  with check (auth.uid() = user_id and public.can_write_social());
drop policy if exists posts_delete on public.posts;
create policy posts_delete on public.posts
  for delete to authenticated using (auth.uid() = user_id);

create table if not exists public.post_likes (
  post_id    bigint not null references public.posts(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists post_likes_post_idx on public.post_likes (post_id);
alter table public.post_likes enable row level security;
drop policy if exists post_likes_select on public.post_likes;
create policy post_likes_select on public.post_likes
  for select to authenticated using (true);
drop policy if exists post_likes_insert on public.post_likes;
create policy post_likes_insert on public.post_likes
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists post_likes_delete on public.post_likes;
create policy post_likes_delete on public.post_likes
  for delete to authenticated using (auth.uid() = user_id);

create table if not exists public.post_comments (
  id         bigint generated always as identity primary key,
  post_id    bigint not null references public.posts(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  text       text not null check (char_length(text) between 1 and 280),
  created_at timestamptz not null default now()
);
create index if not exists post_comments_post_idx on public.post_comments (post_id, created_at);
alter table public.post_comments enable row level security;
drop policy if exists post_comments_select on public.post_comments;
create policy post_comments_select on public.post_comments
  for select to authenticated using (true);
drop policy if exists post_comments_insert on public.post_comments;
create policy post_comments_insert on public.post_comments
  for insert to authenticated
  with check (auth.uid() = user_id and public.can_write_social());
drop policy if exists post_comments_delete on public.post_comments;
create policy post_comments_delete on public.post_comments
  for delete to authenticated using (auth.uid() = user_id);

create table if not exists public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  actor_id   uuid not null references auth.users(id) on delete cascade,
  type       text not null,
  post_id    bigint references public.posts(id) on delete cascade,
  preview    text,
  seen       boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('like','comment','visit')) not valid;
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unseen_idx on public.notifications (user_id) where not seen;
alter table public.notifications enable row level security;
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications
  for delete to authenticated using (auth.uid() = user_id);
drop policy if exists notifications_insert on public.notifications;

create or replace function public.notify_on_like()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_owner uuid;
begin
  select user_id into v_owner from public.posts where id = new.post_id;
  if v_owner is not null and v_owner <> new.user_id then
    insert into public.notifications (user_id, actor_id, type, post_id)
    values (v_owner, new.user_id, 'like', new.post_id);
  end if;
  return new;
end;
$$;
revoke all on function public.notify_on_like() from public;
drop trigger if exists notify_like_trg on public.post_likes;
create trigger notify_like_trg
after insert on public.post_likes
for each row execute function public.notify_on_like();

create or replace function public.notify_on_comment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_owner uuid;
begin
  select user_id into v_owner from public.posts where id = new.post_id;
  if v_owner is not null and v_owner <> new.user_id then
    insert into public.notifications (user_id, actor_id, type, post_id, preview)
    values (v_owner, new.user_id, 'comment', new.post_id, left(new.text, 80));
  end if;
  return new;
end;
$$;
revoke all on function public.notify_on_comment() from public;
drop trigger if exists notify_comment_trg on public.post_comments;
create trigger notify_comment_trg
after insert on public.post_comments
for each row execute function public.notify_on_comment();

create table if not exists public.profile_views (
  id         bigint generated always as identity primary key,
  viewer_id  uuid not null references auth.users(id) on delete cascade,
  target_id  uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (viewer_id <> target_id)
);
create index if not exists profile_views_pair_idx
  on public.profile_views (viewer_id, target_id, created_at desc);
create index if not exists profile_views_target_idx
  on public.profile_views (target_id, created_at desc);
create index if not exists profile_views_created_idx
  on public.profile_views (created_at);
alter table public.profile_views enable row level security;
drop policy if exists profile_views_select on public.profile_views;
create policy profile_views_select on public.profile_views
  for select to authenticated
  using (auth.uid() = viewer_id or auth.uid() = target_id);
drop policy if exists profile_views_insert on public.profile_views;
create policy profile_views_insert on public.profile_views
  for insert to authenticated
  with check (auth.uid() = viewer_id and viewer_id <> target_id);

create or replace function public.profile_view_dedupe()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.profile_views where created_at < now() - interval '30 days';
  if exists (
    select 1 from public.profile_views pv
     where pv.viewer_id = new.viewer_id
       and pv.target_id = new.target_id
       and pv.created_at > now() - interval '1 hour'
  ) then
    return null;
  end if;
  new.created_at := now();
  return new;
end;
$$;
revoke all on function public.profile_view_dedupe() from public;
drop trigger if exists trg_profile_view_dedupe on public.profile_views;
create trigger trg_profile_view_dedupe
before insert on public.profile_views
for each row execute function public.profile_view_dedupe();

create or replace function public.notify_on_profile_view()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (user_id, actor_id, type)
  values (new.target_id, new.viewer_id, 'visit');
  return new;
end;
$$;
revoke all on function public.notify_on_profile_view() from public;
drop trigger if exists notify_profile_view_trg on public.profile_views;
create trigger notify_profile_view_trg
after insert on public.profile_views
for each row execute function public.notify_on_profile_view();

create table if not exists public.gifts (
  id         bigint generated always as identity primary key,
  from_user  uuid not null references auth.users(id) on delete cascade,
  to_user    uuid not null references auth.users(id) on delete cascade,
  gift_type  int not null check (gift_type between 1 and 12),
  scope      text not null default 'partner' check (scope in ('self','partner','all')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists gifts_to_active_idx on public.gifts (to_user, expires_at desc);
alter table public.gifts enable row level security;
drop policy if exists gifts_select on public.gifts;
create policy gifts_select on public.gifts
  for select to authenticated using (true);
drop policy if exists gifts_insert on public.gifts;
drop policy if exists gifts_update on public.gifts;
drop policy if exists gifts_delete on public.gifts;

create or replace function public.gifts_prune()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.gifts where expires_at < now() - interval '1 day';
  new.created_at := now();
  return new;
end;
$$;
revoke all on function public.gifts_prune() from public;
drop trigger if exists trg_gifts_prune on public.gifts;
create trigger trg_gifts_prune
before insert on public.gifts
for each row execute function public.gifts_prune();
commit;
