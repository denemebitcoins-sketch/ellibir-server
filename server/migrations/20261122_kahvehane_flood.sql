-- 22.11 KAHVEHANE FLOOD KORUMASI (yönetici ve sunucu/resmi gönderiler muaf).
-- Durum (posts): 60 sn'de 1, 24 saatte en çok 10, aynı metin 1 saat içinde tekrar edilemez.
-- Yorum (post_comments): 5 sn'de 1, 10 dakikada en çok 30, aynı gönderiye aynı metin 10 dk içinde tekrar edilemez.
-- Hata kodları istemcide Türkçe uyarıya çevrilir: post_too_fast, post_daily_limit, post_duplicate,
-- comment_too_fast, comment_duplicate. Tekrar çalıştırmak güvenlidir.
begin;

create or replace function public.kv_posts_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.text := btrim(public.apply_chat_filter(new.text));
  if char_length(new.text) = 0 then raise exception 'post_empty'; end if;
  if tg_op = 'INSERT' then
    -- Resmi gönderiyi yalnız yönetici (ya da çanak duyurusu için sunucu) atabilir; sabitleme yalnız RPC ile.
    if new.is_official and not public.is_current_user_admin()
       and coalesce(current_setting('kv.official_ok', true), '') <> '1' then
      raise exception 'official_admin_only';
    end if;
    new.pinned_at := null;
    if new.is_official then new.visibility := 'public'; end if;
    -- FLOOD: oyuncu durumları (resmi/yönetici/sunucu muaf)
    if not new.is_official and not public.is_current_user_admin()
       and coalesce(auth.role(), '') <> 'service_role' then
      if exists (select 1 from public.posts p where p.user_id = new.user_id
                  and p.created_at > now() - interval '60 seconds') then
        raise exception 'post_too_fast';
      end if;
      if (select count(*) from public.posts p where p.user_id = new.user_id
           and p.created_at > now() - interval '24 hours') >= 10 then
        raise exception 'post_daily_limit';
      end if;
      if exists (select 1 from public.posts p where p.user_id = new.user_id
                  and p.created_at > now() - interval '1 hour'
                  and lower(p.text) = lower(new.text)) then
        raise exception 'post_duplicate';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.kv_comments_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_parent public.post_comments%rowtype;
begin
  new.text := btrim(public.apply_chat_filter(new.text));
  if char_length(new.text) = 0 then raise exception 'comment_empty'; end if;
  -- FLOOD: yorumlar (yönetici/sunucu muaf)
  if not public.is_current_user_admin() and coalesce(auth.role(), '') <> 'service_role' then
    if exists (select 1 from public.post_comments c where c.user_id = new.user_id
                and c.created_at > now() - interval '5 seconds') then
      raise exception 'comment_too_fast';
    end if;
    if (select count(*) from public.post_comments c where c.user_id = new.user_id
         and c.created_at > now() - interval '10 minutes') >= 30 then
      raise exception 'comment_too_fast';
    end if;
    if exists (select 1 from public.post_comments c where c.user_id = new.user_id and c.post_id = new.post_id
                and c.created_at > now() - interval '10 minutes' and lower(c.text) = lower(new.text)) then
      raise exception 'comment_duplicate';
    end if;
  end if;
  new.depth := 0; new.reply_to := null;
  if new.parent_id is not null then
    select * into v_parent from public.post_comments where id = new.parent_id;
    if not found or v_parent.post_id <> new.post_id then raise exception 'comment_parent_invalid'; end if;
    new.reply_to := v_parent.user_id;
    if v_parent.depth >= 2 then
      new.parent_id := v_parent.parent_id;
      new.depth := 2;
    else
      new.depth := v_parent.depth + 1;
    end if;
  end if;
  return new;
end;
$$;

-- Sayımlar hızlı olsun
create index if not exists posts_user_created_idx on public.posts (user_id, created_at desc);
create index if not exists post_comments_user_created_idx on public.post_comments (user_id, created_at desc);

commit;
