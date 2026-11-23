-- 24.11: İhale her zaman EŞLİ oynanır; bot masası salon etiketi "TEK" (→ istemcide "tekli") yazıyordu.
-- bot_population_public_presence içindeki tek ifadeyi değiştirir (fonksiyonun geri kalanı aynı kalır; yetkiler korunur).
do $$
declare
  f text := pg_get_functiondef('public.bot_population_public_presence()'::regprocedure);
  a text := 'case when h.team_mode then ''ESLI'' else ''TEK'' end';
  b text := 'case when h.team_mode or h.game = ''ihale'' then ''ESLI'' else ''TEK'' end';
begin
  if position(b in f) > 0 then return; end if;          -- zaten uygulanmış
  if position(a in f) = 0 then raise exception 'beklenen ifade bulunamadı'; end if;
  execute replace(f, a, b);
end $$;
