-- 20.11 (3): Kahvehane ETKİNLİK gönderisi — oyuncu her 5 seviyede bir (5, 10, 15, 20 …) akışa
-- "20. seviyeye ulaştı" kartı düşer; arkadaşları "Tebrik et" ile yorum yazar.
-- Profil güncellemesini asla bozmaz (hata yutulur). Görünürlük kv_can_see_post kuralına tabidir.
create or replace function public.kv_level_activity()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_old int := coalesce(old.account_level, 1); v_new int := coalesce(new.account_level, 1); v_lvl int;
begin
  if v_new <= v_old or v_new < 5 or (v_new / 5) = (v_old / 5) then return new; end if;
  v_lvl := (v_new / 5) * 5;
  begin
    if not exists (select 1 from public.posts where user_id = new.id and kind = 'activity'
                    and text = v_lvl || '. seviyeye ulaştı') then
      insert into public.posts(user_id, kind, text, visibility)
      values (new.id, 'activity', v_lvl || '. seviyeye ulaştı', 'public');
    end if;
  exception when others then null;
  end;
  return new;
end;
$$;
drop trigger if exists kv_level_activity_trg on public.profiles;
create trigger kv_level_activity_trg after update of account_level on public.profiles
  for each row execute function public.kv_level_activity();
revoke all on function public.kv_level_activity() from public, anon;
