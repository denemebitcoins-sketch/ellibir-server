-- 19.11 (canlıya uygulandı): eski "rozet verildi" modalı kapatıldı.
-- Öncülük artık otomatik (claim_pioneer_welcome) ve yeni karşılama modalıyla geliyor; unvan değişince
-- oluşan eski bildirim de birkaç dakika sonra ikinci kez modal açıyordu. İstemci id=0 görünce modal açmaz.
create or replace function public.my_member_award_notice() returns jsonb
language sql security definer set search_path to 'pg_catalog','public' as $f$
  select jsonb_build_object('ok', auth.uid() is not null, 'id', 0,
    'honorary_title', coalesce((select p.honorary_title from public.profiles p where p.id::text = auth.uid()::text), ''));
$f$;
update public.member_award_notices set seen_at = now() where seen_at is null;
