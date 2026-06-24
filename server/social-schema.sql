-- =====================================================================
-- 51 (Elli Bir) — SOSYAL SİSTEM ŞEMASI
-- Supabase SQL Editör'de bir kez çalıştır. (Dashboard → SQL Editor → New query → Run)
-- İçerik: (1) presence (online liste), (2) direct_messages (DM) + RLS.
-- Not: Unity client anonim auth (auth.uid()) kullanır; auth.uid() = profiles.id.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- 1) PRESENCE — online oyuncu listesi
--    Her client ~20-30sn'de bir kendi satırını upsert eder (heartbeat).
--    last_seen > now()-60s olan satırlar "online" sayılır.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.presence (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  name       text        not null default 'Oyuncu',
  last_seen  timestamptz not null default now()
);

create index if not exists presence_last_seen_idx on public.presence (last_seen desc);

alter table public.presence enable row level security;

-- Herkes (giriş yapmış) online listeyi OKUYABİLİR.
drop policy if exists presence_select on public.presence;
create policy presence_select on public.presence
  for select to authenticated
  using (true);

-- Kişi YALNIZCA kendi presence satırını yazabilir/günceller.
drop policy if exists presence_insert on public.presence;
create policy presence_insert on public.presence
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists presence_update on public.presence;
create policy presence_update on public.presence
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────
-- 2) DIRECT_MESSAGES — oyun dışı özel mesajlaşma (DM)
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.direct_messages (
  id          bigint      generated always as identity primary key,
  from_user   uuid        not null references auth.users(id) on delete cascade,
  to_user     uuid        not null references auth.users(id) on delete cascade,
  text        text        not null check (char_length(text) between 1 and 500),
  created_at  timestamptz not null default now(),
  read        boolean     not null default false
);

-- Konuşma ve gelen-kutusu sorguları için indeksler.
create index if not exists dm_pair_idx    on public.direct_messages (from_user, to_user, created_at);
create index if not exists dm_inbox_idx   on public.direct_messages (to_user, created_at desc);

alter table public.direct_messages enable row level security;

-- Kişi YALNIZCA kendisinin taraf olduğu mesajları görür (gönderen ya da alıcı).
drop policy if exists dm_select on public.direct_messages;
create policy dm_select on public.direct_messages
  for select to authenticated
  using (auth.uid() = from_user or auth.uid() = to_user);

-- Kişi YALNIZCA kendi adına (from_user = ben) mesaj gönderebilir.
drop policy if exists dm_insert on public.direct_messages;
create policy dm_insert on public.direct_messages
  for insert to authenticated
  with check (auth.uid() = from_user);

-- Alıcı, kendisine gelen mesajı "okundu" işaretleyebilir (read güncellemesi).
drop policy if exists dm_update on public.direct_messages;
create policy dm_update on public.direct_messages
  for update to authenticated
  using (auth.uid() = to_user)
  with check (auth.uid() = to_user);

-- ─────────────────────────────────────────────────────────────────────
-- 3) PROFILES — cinsiyet + rol kolonları (sosyal renklendirme için)
--    gender: 'e'=erkek, 'k'=kadın, null=bilinmiyor (oyuncu kendi seçer).
--    role:   'admin' / 'vip' / 'normal'. ⚠ admin/vip YALNIZCA buradan
--            (Supabase'den) ELLE set edilir; uygulama rolü OKUR, ATAMAZ.
--    Not: profiles tablosu çip/istatistik için zaten mevcut olabilir →
--         sadece kolon ekliyoruz (varsa dokunmaz).
-- ─────────────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists gender text;
alter table public.profiles add column if not exists role   text not null default 'normal';

-- Rolü elle set etme örneği (Supabase SQL Editor'de çalıştır):
--   update public.profiles set role = 'admin' where id = '<user-uuid>';
--   update public.profiles set role = 'vip'   where id = '<user-uuid>';

-- ─────────────────────────────────────────────────────────────────────
-- 4) PRESENCE — gender + role kolonları (heartbeat'te client kendi
--    profilinden yazar; online liste tek sorguda renk/sıra bilgisini alır).
-- ─────────────────────────────────────────────────────────────────────
alter table public.presence add column if not exists gender text;
alter table public.presence add column if not exists role   text not null default 'normal';

-- ─────────────────────────────────────────────────────────────────────
-- 5) LOBBY_CHAT — genel lobi sohbeti (oyun dışı, herkese açık okuma).
--    Son ~50 mesaj gösterilir. Giriş yapan kendi adına yazar.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.lobby_chat (
  id          bigint      generated always as identity primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  name        text        not null default 'Oyuncu',
  role        text        not null default 'normal',
  text        text        not null check (char_length(text) between 1 and 300),
  created_at  timestamptz not null default now()
);

create index if not exists lobby_chat_created_idx on public.lobby_chat (created_at desc);

alter table public.lobby_chat enable row level security;

-- Herkes (giriş yapmış) lobi sohbetini OKUYABİLİR.
drop policy if exists lobby_chat_select on public.lobby_chat;
create policy lobby_chat_select on public.lobby_chat
  for select to authenticated
  using (true);

-- Kişi YALNIZCA kendi adına (user_id = ben) mesaj yazabilir.
drop policy if exists lobby_chat_insert on public.lobby_chat;
create policy lobby_chat_insert on public.lobby_chat
  for insert to authenticated
  with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────
-- 6) REPORTS — istek / şikayet / öneri (destek). Herkes kendi raporunu
--    EKLER; SELECT/UPDATE yalnızca admin (profiles.role='admin') görür.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.reports (
  id          bigint      generated always as identity primary key,
  from_user   uuid        not null references auth.users(id) on delete cascade,
  name        text        not null default 'Oyuncu',
  type        text        not null check (type in ('istek','sikayet','oneri')),
  text        text        not null check (char_length(text) between 1 and 1000),
  status      text        not null default 'open' check (status in ('open','closed')),
  created_at  timestamptz not null default now()
);

create index if not exists reports_status_idx  on public.reports (status, created_at desc);

alter table public.reports enable row level security;

-- Kişi YALNIZCA kendi adına (from_user = ben) rapor ekleyebilir.
drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports
  for insert to authenticated
  with check (auth.uid() = from_user);

-- Raporları YALNIZCA admin okur.
drop policy if exists reports_select on public.reports;
create policy reports_select on public.reports
  for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- Raporu (status) YALNIZCA admin günceller (ÇÖZÜLDÜ işaretleme).
drop policy if exists reports_update on public.reports;
create policy reports_update on public.reports
  for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ─────────────────────────────────────────────────────────────────────
-- 7) PROFILES.banned — ban bayrağı. Sunucu (service-role) onAuth'ta okur,
--    banlıysa Colyseus oda girişini reddeder. Admin elle/uygulamadan set eder.
--    banned güncellemesini admin yapabilsin diye RLS politikası eklenir.
-- ─────────────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists banned boolean not null default false;

-- Admin başka kullanıcının banned alanını güncelleyebilsin.
-- (profiles tablosunda zaten "kendi satırını güncelle" politikası olabilir;
--  bu EK politika admin'e tüm satırlarda UPDATE verir. İkisi OR ile birleşir.)
drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
  for update to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- Bir kullanıcıyı elle banlama/kaldırma (Supabase SQL Editor):
--   update public.profiles set banned = true  where id = '<user-uuid>';
--   update public.profiles set banned = false where id = '<user-uuid>';

-- =====================================================================
-- BİTTİ. presence + direct_messages + lobby_chat + reports tabloları,
-- profiles.gender/role/banned + presence.gender/role kolonları ve RLS hazır.
-- =====================================================================
