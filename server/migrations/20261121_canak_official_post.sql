-- 21.11 ÇANAK PATLADI → Kahvehane'ye "Online Kahvem" resmi gönderisi (sunucu atar).
-- Masadakiler "Tebrik et" ile bu gönderiyi beğenir; beğeniler resmi gönderide birikir.
-- Yalnız service_role (oyun sunucusu) çağırabilir. Kahvehane bakımdaysa gönderi atılmaz (null döner).
-- Tekrar çalıştırmak güvenlidir.
begin;

-- Resmi gönderi kuralı (20.11 tanımı) + sunucunun çanak duyurusu için tek işlemlik izin bayrağı.
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
  end if;
  return new;
end;
$$;

create or replace function public.canak_official_post(p_text text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_author uuid; v_id bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service_only'; end if;
  if coalesce((select m.maintenance from public.game_maintenance m where m.game_key = 'kahvehane'), false) then
    return null;  -- Kahvehane bakımda: duyuru gönderisi atılmaz
  end if;
  -- Yazar: ilk resmi gönderinin (Online Kahvem) sahibi yönetici hesabı; görünen ad zaten "Online Kahvem".
  select p.user_id into v_author from public.posts p where p.is_official order by p.id limit 1;
  if v_author is null then
    select p.id into v_author from public.profiles p where p.role = 'admin' order by p.created_at nulls last limit 1;
  end if;
  if v_author is null then return null; end if;
  perform set_config('kv.official_ok', '1', true);
  insert into public.posts(user_id, kind, text, is_official, visibility)
  values (v_author, 'status', left(btrim(p_text), 280), true, 'public') returning id into v_id;
  perform set_config('kv.official_ok', '', true);
  return v_id;
end;
$$;
revoke all on function public.canak_official_post(text) from public, anon, authenticated;
grant execute on function public.canak_official_post(text) to service_role;

commit;
