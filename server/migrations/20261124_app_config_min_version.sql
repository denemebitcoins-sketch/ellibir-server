-- 24.11: Uygulama ayarları (herkese açık OKUMA, yazma yalnız yönetim/SQL).
-- android_min_version_code: bu sürüm kodundan ESKİ istemciler TAM EKRAN güncelleme ister (kritik hata anahtarı).
--   0 = kapalı (normal: esnek güncelleme, sürüm başına bir kez sorulur).
--   Kritik durumda: update public.app_config set value = '<yeni versionCode>' where key = 'android_min_version_code';
create table if not exists public.app_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;
drop policy if exists app_config_read on public.app_config;
create policy app_config_read on public.app_config for select to anon, authenticated using (true);
grant select on public.app_config to anon, authenticated;
insert into public.app_config (key, value) values ('android_min_version_code', '0') on conflict (key) do nothing;
