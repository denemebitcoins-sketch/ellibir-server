-- 20.11 (2): Kahvehane YÖNETİCİ SABİTİ — Karışık akışın en üstünde tek gönderi.
-- Oyuncunun kendi profil sabiti (pinned_at) aynen sürer.
alter table public.posts add column if not exists feed_pinned_at timestamptz;
create unique index if not exists posts_one_feed_pin_idx on public.posts ((true)) where feed_pinned_at is not null;

-- feed_pinned_at yalnız yönetici RPC'siyle değişir (doğrudan UPDATE ile oynanamaz)
create or replace function public.kv_posts_guard_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then new.feed_pinned_at := null; return new; end if;
  if new.feed_pinned_at is distinct from old.feed_pinned_at and not public.is_current_user_admin() then
    raise exception 'feed_pin_admin_only';
  end if;
  return new;
end;
$$;
drop trigger if exists kv_posts_guard_update_trg on public.posts;
create trigger kv_posts_guard_update_trg before insert or update on public.posts
  for each row execute function public.kv_posts_guard_update();

create or replace function public.kv_post_json(p public.posts, p_me uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'user_id', p.user_id, 'kind', p.kind, 'text', p.text, 'created_at', p.created_at,
    'visibility', p.visibility, 'pinned', p.pinned_at is not null, 'feed_pinned', p.feed_pinned_at is not null, 'official', p.is_official,
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
  elsif p_scope = 'mixed' and p_before_ts is null then
    -- Yönetici sabiti: Karışık akışın en üstünde (gizleyen kullanıcıya gösterilmez)
    select public.kv_post_json(p, v_me) into v_pinned from public.posts p
     where p.feed_pinned_at is not null and public.kv_can_see_post(p.id)
       and not exists (select 1 from public.post_hides h where h.user_id = v_me and h.post_id = p.id)
     order by p.feed_pinned_at desc limit 1;
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
       and not (p_scope = 'mixed' and v_pinned is not null and p.id = (v_pinned->>'id')::bigint)
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

create or replace function public.kahvehane_set_feed_pin(p_post bigint, p_pin boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_current_user_admin() then raise exception 'admin_only'; end if;
  update public.posts set feed_pinned_at = null where feed_pinned_at is not null and (not p_pin or id <> p_post);
  if p_pin then
    if not exists (select 1 from public.posts where id = p_post and visibility = 'public') then raise exception 'not_public'; end if;
    update public.posts set feed_pinned_at = now() where id = p_post;
  end if;
  return true;
end;
$$;

revoke all on function public.kv_posts_guard_update(), public.kahvehane_set_feed_pin(bigint, boolean) from public, anon;
grant execute on function public.kahvehane_set_feed_pin(bigint, boolean) to authenticated;
