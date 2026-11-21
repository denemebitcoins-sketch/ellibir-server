-- 21.11: Foto onayı çalışmıyordu — koruma tetikleyicisi oyuncunun avatar_status='pending' yazmasını
-- sessizce eski değere ('visible') geri çeviriyordu → her yeni foto otomatik onaylı oluyordu.
-- Yeni kural (admin olmayan istemci): yalnız 'pending'e ÇEKEBİLİR; foto adresi değişirse otomatik 'pending'.
-- 'visible'/'hidden' yapma yetkisi yine sadece admin (admin_set_avatar_status) ve sunucuda.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.profiles_guard_client_sensitive'::regproc);
  if position('new.avatar_status := old.avatar_status;' in d) = 0 then raise exception 'beklenen satir yok'; end if;
  d := replace(d, 'new.avatar_status := old.avatar_status;',
    'new.avatar_status := case when new.avatar_url is not null and (new.avatar_status = ''pending'' or new.avatar_url is distinct from old.avatar_url) then ''pending'' else old.avatar_status end;');
  execute d;
end $$;
select position('then ''pending'' else old.avatar_status' in pg_get_functiondef('public.profiles_guard_client_sensitive'::regproc)) > 0 as ok;
