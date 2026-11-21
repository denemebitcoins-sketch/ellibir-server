-- 21.11 KAHVEHANE ACİL KAPATMA ANAHTARI
-- Mevcut "oyun bakım modu"na 'kahvehane' satırı eklenir (panel > Oyun bakım modu > Kahvehane).
-- Açıkken (yöneticiler HARİÇ):
--   * akış/duvar/gönderi görünmez (kv_can_see_post false → feed, yorum, beğeni politikaları boş döner)
--   * yeni gönderi / yorum / beğeni / yorum beğenisi veritabanında REDDEDİLİR (eski sürümler dahil)
--   * beğeni/yorum olmadığı için bildirim ve push da oluşmaz
-- Seviye etkinlik gönderisi (profil tetikleyicisi) hatayı zaten yutar; profil güncellemesi bozulmaz.
-- Tekrar çalıştırmak güvenlidir.
begin;

alter table public.game_maintenance drop constraint if exists game_maintenance_game_key_check;
alter table public.game_maintenance add constraint game_maintenance_game_key_check
  check (game_key in ('101','klasik','bankolu','51','ihale','tavla','kahvehane'));
insert into public.game_maintenance(game_key) values ('kahvehane') on conflict (game_key) do nothing;

create or replace function public.kv_maintenance_on()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select m.maintenance from public.game_maintenance m where m.game_key = 'kahvehane'), false)
     and not coalesce(public.is_current_user_admin(), false);
$$;
revoke all on function public.kv_maintenance_on() from public, anon;
grant execute on function public.kv_maintenance_on() to authenticated;

create or replace function public.admin_set_game_maintenance(p_game text, p_on boolean, p_message text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_current_user_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  if p_game not in ('101','klasik','bankolu','51','ihale','tavla','kahvehane') then
    raise exception 'bad_game';
  end if;
  insert into public.game_maintenance(game_key, maintenance, message, updated_at, updated_by)
  values (p_game, coalesce(p_on, false), left(coalesce(trim(p_message), ''), 160), now(), auth.uid())
  on conflict (game_key) do update
    set maintenance = excluded.maintenance, message = excluded.message,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  return public.get_game_maintenance();
end;
$$;
revoke execute on function public.admin_set_game_maintenance(text, boolean, text) from public, anon;
grant execute on function public.admin_set_game_maintenance(text, boolean, text) to authenticated;

-- Görünürlük kuralı: bakımda yönetici olmayan hiçbir gönderiyi görmez (20.11 tanımı + bakım koşulu).
create or replace function public.kv_can_see_post(p_post bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select not public.kv_maintenance_on() and exists (
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

-- Yazma engeli: ayrı tetikleyici (mevcut tetikleyicilere dokunulmaz).
create or replace function public.kv_maintenance_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.kv_maintenance_on() then
    raise exception 'kahvehane_maintenance' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.kv_maintenance_guard() from public, anon, authenticated;

drop trigger if exists kv_maint_posts_trg on public.posts;
create trigger kv_maint_posts_trg before insert on public.posts
  for each row execute function public.kv_maintenance_guard();
drop trigger if exists kv_maint_comments_trg on public.post_comments;
create trigger kv_maint_comments_trg before insert on public.post_comments
  for each row execute function public.kv_maintenance_guard();
drop trigger if exists kv_maint_likes_trg on public.post_likes;
create trigger kv_maint_likes_trg before insert on public.post_likes
  for each row execute function public.kv_maintenance_guard();
drop trigger if exists kv_maint_comment_likes_trg on public.post_comment_likes;
create trigger kv_maint_comment_likes_trg before insert on public.post_comment_likes
  for each row execute function public.kv_maintenance_guard();

commit;
