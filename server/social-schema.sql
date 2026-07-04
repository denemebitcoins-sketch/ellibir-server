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

-- SALON MASA EŞLEME (zorunlu): heartbeat artık masadayken masanın MODUNU da yazar
--   (solo→1 insan+3 bot, duo→2 insan+2 bot). Salon koltuk/bot dağılımını bundan türetir.
--   Bu kolon YOKSA heartbeat POST'u tümden reddedilir (PostgREST bilinmeyen kolon) → presence çöker.
--   NOT: status/table_no/chips/avatar_url kolonları da heartbeat tarafından yazılır; bu projede
--   elle eklenmişti — eksikse aşağıdaki satırlara benzer şekilde ekleyin.
alter table public.presence add column if not exists table_mode text;   -- "solo" | "duo" | null

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

-- ─────────────────────────────────────────────────────────────────────
-- 8) GİZLİLİK — profiles.allow_dm / allow_friend_req bayrakları.
--    Oyuncu kendi gizlilik tercihini ayarlar. Varsayılan: açık (true).
--    allow_dm=false      → kimse DM gönderemez.
--    allow_friend_req=false → kimse arkadaşlık isteği gönderemez.
-- ─────────────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists allow_dm         boolean not null default true;
alter table public.profiles add column if not exists allow_friend_req boolean not null default true;

-- Online listede/profil modalında gizlilik bilgisini de çekebilmek için
-- presence'a da aynı bayrakları koy (heartbeat'te client kendi profilinden yazar).
alter table public.presence add column if not exists allow_dm         boolean not null default true;
alter table public.presence add column if not exists allow_friend_req boolean not null default true;

-- ─────────────────────────────────────────────────────────────────────
-- 9) FRIENDSHIPS — arkadaşlık ilişkileri.
--    status: 'pending' (istek gönderildi, bekliyor) | 'accepted' (arkadaş).
--    requester istek gönderir; addressee kabul/ret eder.
--    UNIQUE(requester,addressee): aynı yönde tek istek.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.friendships (
  id          bigint      generated always as identity primary key,
  requester   uuid        not null references auth.users(id) on delete cascade,
  addressee   uuid        not null references auth.users(id) on delete cascade,
  status      text        not null default 'pending' check (status in ('pending','accepted')),
  created_at  timestamptz not null default now(),
  unique (requester, addressee)
);

create index if not exists friendships_requester_idx on public.friendships (requester, status);
create index if not exists friendships_addressee_idx on public.friendships (addressee, status);

alter table public.friendships enable row level security;

-- Taraf olanlar (requester ya da addressee) ilişkiyi GÖRÜR.
drop policy if exists friendships_select on public.friendships;
create policy friendships_select on public.friendships
  for select to authenticated
  using (auth.uid() = requester or auth.uid() = addressee);

-- Kişi YALNIZCA kendi adına (requester = ben) istek gönderebilir;
-- ayrıca hedefin allow_friend_req=true olmalı (kapalıysa istek engellenir).
drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships
  for insert to authenticated
  with check (
    auth.uid() = requester
    and exists (select 1 from public.profiles p where p.id = addressee and p.allow_friend_req = true)
  );

-- Addressee isteği kabul/ret edebilir (update status). requester de durumunu yönetebilir.
drop policy if exists friendships_update on public.friendships;
create policy friendships_update on public.friendships
  for update to authenticated
  using (auth.uid() = addressee or auth.uid() = requester)
  with check (auth.uid() = addressee or auth.uid() = requester);

-- Taraf olan (her iki yön) arkadaşlığı/isteği silebilir (reddet / arkadaşlıktan çıkar).
drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships
  for delete to authenticated
  using (auth.uid() = requester or auth.uid() = addressee);

-- ─────────────────────────────────────────────────────────────────────
-- 10) GELİŞMİŞ BAN SİSTEMİ — süreli (expires_at) + türlü (chat/game) +
--     sebep + opsiyonel not + geçmiş kayıt (artan ceza için).
--     bans tablosu: her ban bir satır (geçmiş kalıcı; revoked ile kaldırılır).
--     profiles.{chat,game}_banned_until: ASIL kontrol noktası (now()'dan
--     büyükse aktif ban). null = ban yok. Çok ileri tarih = kalıcı.
--     Mevcut profiles.banned (basit bayrak) GERİYE-DÖNÜK kalır; dokunulmaz.
--     RLS: bans select/insert/update YALNIZCA admin (profiles.role='admin').
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.bans (
  id           bigint      generated always as identity primary key,
  target_user  uuid        not null references auth.users(id) on delete cascade,
  type         text        not null check (type in ('chat','game')),
  reason       text        not null default '',
  note         text        not null default '',
  expires_at   timestamptz,                 -- null = kalıcı
  revoked      boolean     not null default false,
  created_by   uuid        references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists bans_target_idx on public.bans (target_user, type, created_at desc);

alter table public.bans enable row level security;

-- bans: YALNIZCA admin okur.
drop policy if exists bans_select on public.bans;
create policy bans_select on public.bans
  for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- bans: YALNIZCA admin ekler.
drop policy if exists bans_insert on public.bans;
create policy bans_insert on public.bans
  for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- bans: YALNIZCA admin günceller (revoked işaretleme).
drop policy if exists bans_update on public.bans;
create policy bans_update on public.bans
  for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- profiles: süreli/türlü ban "aktif until" kolonları.
alter table public.profiles add column if not exists chat_banned_until timestamptz;
alter table public.profiles add column if not exists game_banned_until timestamptz;

-- (profiles_admin_update politikası — bölüm 7 — admin'e tüm satırlarda UPDATE
--  verdiği için chat/game_banned_until güncellemeleri de bu politikayla geçer.)

-- Herkes (giriş yapan) KENDİ chat_banned_until / game_banned_until alanını OKUYABİLSİN
-- (client kendi durumunu bilmeli). profiles_select politikası zaten herkese açık
-- değilse ek bir SELECT politikası gerekebilir; çoğu kurulumda profiles select
-- "kendi satırını oku" zaten vardır. Yoksa Supabase'de ekleyin:
--   create policy profiles_self_select on public.profiles
--     for select to authenticated using (auth.uid() = id);

-- ─────────────────────────────────────────────────────────────────────
-- 11) MAÇ İSTATİSTİĞİ — record_match_stats RPC (MADDE 4)
--     Online Colyseus maç-sonu settle akışı her gerçek oyuncu için bu RPC'yi
--     çağırır: matches +1 (HER oyuncu), wins +1 (yalnız kazanan), kazanan serisi
--     (cur_streak/best_streak) ve total_won güncellenir. Bot koltukları sunucuda
--     seatUsers'ta olmadığından sayılmaz → winrate = wins/matches DOĞRU hesaplanır.
--     Service-role ile çağrılır (SECURITY DEFINER). Profil yoksa sessiz atlanır.
--     NOT: cur_streak/total_won kolonları yoksa önce eklenir (idempotent).
-- ─────────────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists matches     integer not null default 0;
alter table public.profiles add column if not exists wins        integer not null default 0;
alter table public.profiles add column if not exists best_streak integer not null default 0;
alter table public.profiles add column if not exists cur_streak  integer not null default 0;
alter table public.profiles add column if not exists total_won   bigint  not null default 0;

create or replace function public.record_match_stats(
  p_user_id  text,
  p_won      boolean,
  p_winnings bigint default 0
)
returns void
language plpgsql
security definer
as $$
begin
  update public.profiles
  set
    matches     = coalesce(matches, 0) + 1,
    wins        = coalesce(wins, 0) + (case when p_won then 1 else 0 end),
    cur_streak  = case when p_won then coalesce(cur_streak, 0) + 1 else 0 end,
    best_streak = greatest(
                    coalesce(best_streak, 0),
                    case when p_won then coalesce(cur_streak, 0) + 1 else 0 end
                  ),
    total_won   = coalesce(total_won, 0) + (case when p_won then greatest(p_winnings, 0) else 0 end)
  where id = p_user_id;
  -- profil yoksa NOT FOUND → sessiz geç (anon kullanıcı kaydı eksikse maç akışını bozma).
end;
$$;

-- =====================================================================
-- BİTTİ. presence + direct_messages + lobby_chat + reports + friendships
-- + bans tabloları; profiles.gender/role/banned/allow_dm/allow_friend_req/
-- chat_banned_until/game_banned_until + presence.* kolonları ve RLS hazır.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- BÖLÜM 30) HEDİYE KABUL TERCİHİ — gift_off = true → hediye ALMAK istemiyor.
--   Hediye gönderim listesinde bu kişi GRİ görünür (tıklanamaz).
--   Default false = kabul ediyor (mevcut davranış değişmez).
--   (2026-07-04; client bağlaması ayarlar toggle'ı ile sonraki turda)
-- ─────────────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists gift_off boolean not null default false;
alter table public.presence add column if not exists gift_off boolean not null default false;

-- ─────────────────────────────────────────────────────────────────────
-- BÖLÜM 31) MASA DAVETİ SÜPÜRGESİ — client 10dk TTL uygular (listede
--   gizler + siler); bu cron hiç giriş yapmayan hesapların davetleri
--   için sunucu sigortası. (pg_cron lobby retention ile aynı desen)
-- ─────────────────────────────────────────────────────────────────────
select cron.schedule(
  'invites-temizlik',
  '17 * * * *',   -- her saat :17'de
  $q$ delete from public.invites where created_at < now() - interval '10 minutes' $q$
);

-- BÖLÜM 30/31 doğrulama:
--   select column_name from information_schema.columns
--    where table_name in ('profiles','presence') and column_name = 'gift_off';
--   select jobname, schedule from cron.job where jobname = 'invites-temizlik';
