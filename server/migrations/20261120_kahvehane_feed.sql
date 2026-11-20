-- 20.11 KAHVEHANE AKIŞI (ana sayfa timeline + profil duvarı v2)
--  * posts: görünürlük (public|friends), sabitleme, resmi (Online Kahvem) gönderi
--  * post_comments: iç içe yanıt (en fazla 2 seviye; daha derini "@isim" ile 2. seviyede kalır)
--  * post_comment_likes: yorum beğenisi · post_hides: "bu gönderiyi gizle"
--  * küfür filtresi (apply_chat_filter) gönderi ve yorumlara da uygulanır
--  * engellenen/engelleyen kişilerin içeriği akışta ve yorumlarda görünmez
--  * RPC: kahvehane_feed / kahvehane_comments / set_pin / set_visibility / hide_post / post_official
-- Eski istemciler (7.1 ve öncesi) aynı tabloları REST ile kullanmaya devam eder: yeni kolonların hepsi
-- varsayılanlı, eski uç noktalar bozulmaz.
begin;

-- ───────────────────────── 1) gönderi kolonları ─────────────────────────
alter table public.posts add column if not exists visibility text not null default 'public';
alter table public.posts drop constraint if exists posts_visibility_check;
alter table public.posts add constraint posts_visibility_check check (visibility in ('public','friends'));
alter table public.posts add column if not exists pinned_at timestamptz;
alter table public.posts add column if not exists is_official boolean not null default false;
create index if not exists posts_feed_idx on public.posts (created_at desc, id desc);
create unique index if not exists posts_one_pin_idx on public.posts (user_id) where pinned_at is not null;

-- ───────────────────────── 2) yorum kolonları ─────────────────────────
alter table public.post_comments add column if not exists parent_id bigint references public.post_comments(id) on delete cascade;
alter table public.post_comments add column if not exists depth smallint not null default 0;
alter table public.post_comments add column if not exists reply_to uuid;
create index if not exists post_comments_parent_idx on public.post_comments (parent_id);

-- ───────────────────────── 3) yorum beğenisi + gizleme ─────────────────────────
create table if not exists public.post_comment_likes (
  comment_id bigint not null references public.post_comments(id) on delete cascade,
  user_id    uuid   not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create index if not exists post_comment_likes_comment_idx on public.post_comment_likes (comment_id);
alter table public.post_comment_likes enable row level security;

create table if not exists public.post_hides (
  user_id    uuid   not null references auth.users(id) on delete cascade,
  post_id    bigint not null references public.posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
alter table public.post_hides enable row level security;
drop policy if exists post_hides_own on public.post_hides;
create policy post_hides_own on public.post_hides for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ───────────────────────── 4) yardımcılar ─────────────────────────
create or replace function public.kv_is_friend(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_a is not null and p_b is not null and exists (
    select 1 from public.friendships f
     where f.status = 'accepted'
       and ((f.requester::text = p_a::text and f.addressee::text = p_b::text)
         or (f.requester::text = p_b::text and f.addressee::text = p_a::text)));
$$;

create or replace function public.kv_blocked_between(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_a is not null and p_b is not null and p_a <> p_b and exists (
    select 1 from public.blocks b
     where (b.blocker::text = p_a::text and b.blocked::text = p_b::text)
        or (b.blocker::text = p_b::text and b.blocked::text = p_a::text));
$$;

-- Tek görünürlük kuralı (RLS, beğeni/yorum ve akış aynı kuralı kullanır).
create or replace function public.kv_can_see_post(p_post bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.posts p
     where p.id = p_post
       and (
         p.is_official
         or p.user_id = auth.uid()
         or public.is_current_user_admin()
         or (public.can_view_profile_social(p.user_id::text)
             and (p.visibility = 'public' or public.kv_is_friend(auth.uid(), p.user_id))
             and not public.kv_blocked_between(auth.uid(), p.user_id))
       ));
$$;

-- Eski fonksiyon yeni kurala bağlanır: post_likes / post_comments politikaları bunu kullanıyor.
create or replace function public.can_view_post_social(p_post bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select public.kv_can_see_post(p_post);
$$;

drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts for select to authenticated using (public.kv_can_see_post(id));

drop policy if exists post_comment_likes_select on public.post_comment_likes;
create policy post_comment_likes_select on public.post_comment_likes for select to authenticated
  using (exists (select 1 from public.post_comments c where c.id = comment_id and public.kv_can_see_post(c.post_id)));
drop policy if exists post_comment_likes_insert on public.post_comment_likes;
create policy post_comment_likes_insert on public.post_comment_likes for insert to authenticated
  with check (auth.uid() = user_id
    and exists (select 1 from public.post_comments c where c.id = comment_id and public.kv_can_see_post(c.post_id)));
drop policy if exists post_comment_likes_delete on public.post_comment_likes;
create policy post_comment_likes_delete on public.post_comment_likes for delete to authenticated using (auth.uid() = user_id);

-- ───────────────────────── 5) tetikleyiciler ─────────────────────────
create or replace function public.kv_posts_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.text := btrim(public.apply_chat_filter(new.text));
  if char_length(new.text) = 0 then raise exception 'post_empty'; end if;
  if tg_op = 'INSERT' then
    -- Resmi gönderiyi yalnız yönetici atabilir; sabitleme yalnız RPC ile.
    if new.is_official and not public.is_current_user_admin() then raise exception 'official_admin_only'; end if;
    new.pinned_at := null;
    if new.is_official then new.visibility := 'public'; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists kv_posts_before_write_trg on public.posts;
create trigger kv_posts_before_write_trg before insert on public.posts
  for each row execute function public.kv_posts_before_write();

create or replace function public.kv_comments_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_parent public.post_comments%rowtype;
begin
  new.text := btrim(public.apply_chat_filter(new.text));
  if char_length(new.text) = 0 then raise exception 'comment_empty'; end if;
  new.depth := 0; new.reply_to := null;
  if new.parent_id is not null then
    select * into v_parent from public.post_comments where id = new.parent_id;
    if not found or v_parent.post_id <> new.post_id then raise exception 'comment_parent_invalid'; end if;
    new.reply_to := v_parent.user_id;
    if v_parent.depth >= 2 then
      -- 3. seviye yok: aynı (2.) seviyeye düşer, kime yanıt verildiği reply_to'da kalır.
      new.parent_id := v_parent.parent_id;
      new.depth := 2;
    else
      new.depth := v_parent.depth + 1;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists kv_comments_before_insert_trg on public.post_comments;
create trigger kv_comments_before_insert_trg before insert on public.post_comments
  for each row execute function public.kv_comments_before_insert();

-- Bildirim: gönderi sahibine (mevcut) + yanıt verilen kişiye (yeni). İkisi aynıysa tek bildirim.
create or replace function public.notify_on_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  select user_id into v_owner from public.posts where id = new.post_id;
  if v_owner is not null and v_owner <> new.user_id then
    insert into public.notifications (user_id, actor_id, type, post_id, preview)
    values (v_owner, new.user_id, 'comment', new.post_id, left(new.text, 80));
  end if;
  if new.reply_to is not null and new.reply_to <> new.user_id and new.reply_to is distinct from v_owner then
    insert into public.notifications (user_id, actor_id, type, post_id, preview)
    values (new.reply_to, new.user_id, 'comment', new.post_id, left(new.text, 80));
  end if;
  return new;
end;
$$;

-- ───────────────────────── 6) okuma RPC'leri ─────────────────────────
create or replace function public.kv_author_json(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object(
      'name', coalesce(nullif(p.name, ''), 'Oyuncu'), 'avatar_url', p.avatar_url, 'role', coalesce(p.role, 'normal'),
      'gender', p.gender, 'vip', (p.vip_until is not null and p.vip_until > now()), 'level', coalesce(p.account_level, 1),
      'frame', p.equipped_profile_frame, 'name_style', p.equipped_name_style)
    from public.profiles p where p.id::text = p_user::text),
    jsonb_build_object('name', 'Oyuncu', 'role', 'normal', 'vip', false, 'level', 1));
$$;

create or replace function public.kv_post_json(p public.posts, p_me uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'user_id', p.user_id, 'kind', p.kind, 'text', p.text, 'created_at', p.created_at,
    'visibility', p.visibility, 'pinned', p.pinned_at is not null, 'official', p.is_official,
    'mine', p.user_id = p_me,
    'author', public.kv_author_json(p.user_id),
    'likes', (select count(*) from public.post_likes l where l.post_id = p.id),
    'liked', exists (select 1 from public.post_likes l where l.post_id = p.id and l.user_id = p_me),
    'comments', (select count(*) from public.post_comments c where c.post_id = p.id
                  and not public.kv_blocked_between(p_me, c.user_id)),
    'top_comment', (
      select jsonb_build_object('id', c.id, 'user_id', c.user_id, 'text', c.text,
               'name', coalesce(nullif(pr.name, ''), 'Oyuncu'), 'likes', c.lc)
        from (select c0.*, (select count(*) from public.post_comment_likes cl where cl.comment_id = c0.id) lc
                from public.post_comments c0
               where c0.post_id = p.id and c0.parent_id is null
                 and not public.kv_blocked_between(p_me, c0.user_id)) c
        left join public.profiles pr on pr.id::text = c.user_id::text
       order by c.lc desc, c.created_at desc limit 1));
$$;

-- p_scope: 'mixed' (Karışık) | 'friends' (Arkadaşlar) | 'user' (bir kişinin duvarı, p_user)
-- Sayfalama: bir önceki sayfanın son öğesinin (created_at, id) değeri p_before_ts/p_before_id ile verilir.
create or replace function public.kahvehane_feed(p_scope text, p_user uuid default null,
  p_before_ts timestamptz default null, p_before_id bigint default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_lim int := least(greatest(coalesce(p_limit, 20), 1), 40);
  v_items jsonb; v_pinned jsonb := null; v_last record;
begin
  if v_me is null then raise exception 'not_authenticated'; end if;
  if p_scope not in ('mixed', 'friends', 'user') then raise exception 'scope_invalid'; end if;
  if p_scope = 'user' and p_user is null then p_user := v_me; end if;

  if p_scope = 'user' and p_before_ts is null then
    select public.kv_post_json(p, v_me) into v_pinned from public.posts p
     where p.user_id = p_user and p.pinned_at is not null and public.kv_can_see_post(p.id) limit 1;
  end if;

  with cand as (
    select p.*,
           -- Karışık akışta aynı kişinin aynı gündeki otomatik etkinliklerinden yalnız sonuncusu
           row_number() over (partition by p.user_id, p.kind, (p.created_at at time zone 'Europe/Istanbul')::date
                              order by p.created_at desc, p.id desc) as act_rn
      from public.posts p
     where (p_before_ts is null or (p.created_at, p.id) < (p_before_ts, coalesce(p_before_id, 9223372036854775807)))
       and (p_scope <> 'user' or p.user_id = p_user)
       and (p_scope <> 'friends' or p.user_id = v_me or public.kv_is_friend(v_me, p.user_id))
       and not (p_scope = 'user' and p.pinned_at is not null and p_before_ts is null)
       and not exists (select 1 from public.post_hides h where h.user_id = v_me and h.post_id = p.id)
       and public.kv_can_see_post(p.id)
  ), page as (
    select * from cand
     where p_scope <> 'mixed' or kind <> 'activity' or act_rn = 1
     order by created_at desc, id desc limit v_lim
  )
  select coalesce(jsonb_agg(public.kv_post_json(p, v_me) order by p.created_at desc, p.id desc), '[]'::jsonb)
    into v_items from page pg join public.posts p on p.id = pg.id;

  select (x->>'created_at')::timestamptz as ts, (x->>'id')::bigint as id into v_last
    from jsonb_array_elements(v_items) x order by (x->>'created_at')::timestamptz asc, (x->>'id')::bigint asc limit 1;

  return jsonb_build_object('items', v_items, 'pinned', v_pinned,
    'next', case when jsonb_array_length(v_items) >= v_lim then jsonb_build_object('ts', v_last.ts, 'id', v_last.id) else null end);
end;
$$;

create or replace function public.kahvehane_comments(p_post bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'not_authenticated'; end if;
  if not public.kv_can_see_post(p_post) then return jsonb_build_object('items', '[]'::jsonb); end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'parent_id', c.parent_id, 'depth', c.depth, 'user_id', c.user_id, 'text', c.text,
             'created_at', c.created_at, 'mine', c.user_id = v_me,
             'author', public.kv_author_json(c.user_id),
             'reply_to', c.reply_to,
             'reply_to_name', (select coalesce(nullif(pr.name, ''), 'Oyuncu') from public.profiles pr where pr.id::text = c.reply_to::text),
             'likes', (select count(*) from public.post_comment_likes l where l.comment_id = c.id),
             'liked', exists (select 1 from public.post_comment_likes l where l.comment_id = c.id and l.user_id = v_me))
           order by c.created_at asc, c.id asc)
      from (select * from public.post_comments c0
             where c0.post_id = p_post and not public.kv_blocked_between(v_me, c0.user_id)
             order by c0.created_at asc, c0.id asc limit 300) c), '[]'::jsonb));
end;
$$;

-- ───────────────────────── 7) yazma RPC'leri ─────────────────────────
create or replace function public.kahvehane_set_pin(p_post bigint, p_pin boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null or not exists (select 1 from public.posts where id = p_post and user_id = v_me) then return false; end if;
  update public.posts set pinned_at = null where user_id = v_me and pinned_at is not null and (not p_pin or id <> p_post);
  if p_pin then update public.posts set pinned_at = now() where id = p_post and user_id = v_me; end if;
  return true;
end;
$$;

create or replace function public.kahvehane_set_visibility(p_post bigint, p_visibility text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_visibility not in ('public', 'friends') then return false; end if;
  update public.posts set visibility = p_visibility where id = p_post and user_id = auth.uid() and not is_official;
  return found;
end;
$$;

create or replace function public.kahvehane_hide_post(p_post bigint, p_hide boolean default true)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  if p_hide then
    insert into public.post_hides(user_id, post_id) values (auth.uid(), p_post) on conflict do nothing;
  else
    delete from public.post_hides where user_id = auth.uid() and post_id = p_post;
  end if;
  return true;
end;
$$;

-- Yönetici: "Online Kahvem" adına resmi gönderi (yazar yönetici hesabı, görünen ad Online Kahvem).
create or replace function public.kahvehane_post_official(p_text text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if not public.is_current_user_admin() then raise exception 'official_admin_only'; end if;
  insert into public.posts(user_id, kind, text, is_official, visibility)
  values (auth.uid(), 'status', left(btrim(p_text), 280), true, 'public') returning id into v_id;
  return v_id;
end;
$$;

-- Yönetici: herhangi bir gönderi/yorumu kaldırma (şikayet sonrası).
create or replace function public.kahvehane_admin_delete(p_post bigint default null, p_comment bigint default null)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_current_user_admin() then raise exception 'admin_only'; end if;
  if p_post is not null then delete from public.posts where id = p_post; end if;
  if p_comment is not null then delete from public.post_comments where id = p_comment; end if;
  return true;
end;
$$;

revoke all on function public.kv_is_friend(uuid, uuid), public.kv_blocked_between(uuid, uuid),
  public.kv_author_json(uuid), public.kv_post_json(public.posts, uuid),
  public.kv_posts_before_write(), public.kv_comments_before_insert() from public, anon;
revoke all on function public.kv_can_see_post(bigint), public.kahvehane_feed(text, uuid, timestamptz, bigint, int),
  public.kahvehane_comments(bigint), public.kahvehane_set_pin(bigint, boolean), public.kahvehane_set_visibility(bigint, text),
  public.kahvehane_hide_post(bigint, boolean), public.kahvehane_post_official(text),
  public.kahvehane_admin_delete(bigint, bigint) from public, anon;
grant execute on function public.kv_can_see_post(bigint), public.kahvehane_feed(text, uuid, timestamptz, bigint, int),
  public.kahvehane_comments(bigint), public.kahvehane_set_pin(bigint, boolean), public.kahvehane_set_visibility(bigint, text),
  public.kahvehane_hide_post(bigint, boolean), public.kahvehane_post_official(text),
  public.kahvehane_admin_delete(bigint, bigint) to authenticated;
grant execute on function public.kv_is_friend(uuid, uuid), public.kv_blocked_between(uuid, uuid) to authenticated;

commit;
