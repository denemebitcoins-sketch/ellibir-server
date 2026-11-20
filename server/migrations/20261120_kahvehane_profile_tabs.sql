-- 20.11 (4): Profil sekmeleri — Duvar (durumlar) · Etkinlikler · Beğendikleri (yalnız kendi profilinde).
create or replace function public.kahvehane_feed(p_scope text, p_user uuid default null,
  p_before_ts timestamptz default null, p_before_id bigint default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_lim int := least(greatest(coalesce(p_limit, 20), 1), 40);
  v_items jsonb; v_pinned jsonb := null; v_last record;
begin
  if v_me is null then raise exception 'not_authenticated'; end if;
  if p_scope not in ('mixed', 'friends', 'user', 'user_activity', 'user_liked') then raise exception 'scope_invalid'; end if;
  if p_scope like 'user%' and p_user is null then p_user := v_me; end if;
  -- Beğendikleri yalnız kendi profilinde
  if p_scope = 'user_liked' and p_user <> v_me then return jsonb_build_object('items', '[]'::jsonb, 'pinned', null, 'next', null); end if;

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
       and (p_scope not in ('user', 'user_activity') or p.user_id = p_user)
       -- Duvar: kişinin kendi durumları (resmi duyurular ve etkinlikler hariç) · Etkinlikler: yalnız etkinlik kartları
       and (p_scope <> 'user' or (p.kind <> 'activity' and not p.is_official))
       and (p_scope <> 'user_activity' or p.kind = 'activity')
       and (p_scope <> 'user_liked' or exists (select 1 from public.post_likes l where l.post_id = p.id and l.user_id = p_user))
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
