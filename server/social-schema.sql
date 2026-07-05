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

-- ─────────────────────────────────────────────────────────────────────
-- BÖLÜM 32) GIFTS OKUMA İZNİ — hediyeler server (service-role) ile yazılır
--   ama CLIENT'lar okuyamıyordu (SELECT policy yoktu → sorgu SESSİZCE boş
--   dönüyordu = "okeyde ısmarladım, 51'de çikolata yok" kökü).
--   Masadaki herkesin süreli hediyesi herkese görünür → select serbest.
-- ─────────────────────────────────────────────────────────────────────
alter table public.gifts enable row level security;
drop policy if exists gifts_select on public.gifts;
create policy gifts_select on public.gifts
  for select to authenticated
  using (true);

-- BÖLÜM 32 doğrulama:
--   select policyname from pg_policies where tablename = 'gifts';

-- ─────────────────────────────────────────────────────────────────────
-- BÖLÜM 33) ÇANAK (ilerleyen jackpot) — oyun başına 1 çanak: '51' / 'okey' / 'tavla'.
--   Her maçta kesilen komisyonun %50'si ilgili çanağa birikir (kalan %50 yakılır).
--   PATLATMA (el/oyun bitiren İNSAN, şansla): okey atarak %3 · çift %5 · çift+okey %8
--   (51 ve okey düz/banko ortak tetikler) · tavlada MARS %3. Patlayan çanağın TAMAMI
--   bitirene gider; çanak 0'dan yeniden birikir.
--   Yazma YALNIZ service-role RPC'lerle (atomik); client yalnız OKUR (lobi göstergesi).
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.canak (
  game       text primary key,            -- '51' | 'okey' | 'tavla'
  amount     bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.canak (game, amount) values ('51',0), ('okey',0), ('tavla',0)
  on conflict (game) do nothing;

alter table public.canak enable row level security;
drop policy if exists canak_select on public.canak;
create policy canak_select on public.canak
  for select to authenticated using (true);
-- (insert/update policy YOK → client yazamaz; service-role RLS'i zaten geçer)

-- Çanağa ekle (atomik) — yeni toplamı döner.
create or replace function public.canak_add(p_game text, p_amount bigint)
returns bigint
language plpgsql
security definer
as $$
declare v bigint;
begin
  update public.canak
     set amount = amount + greatest(0, p_amount), updated_at = now()
   where game = p_game
   returning amount into v;
  return coalesce(v, 0);
end;
$$;

-- Çanağı patlat (atomik): mevcut tutarı döner ve sıfırlar. Boşsa 0.
create or replace function public.canak_take(p_game text)
returns bigint
language plpgsql
security definer
as $$
declare v bigint;
begin
  select amount into v from public.canak where game = p_game for update;
  if v is null or v <= 0 then return 0; end if;
  update public.canak set amount = 0, updated_at = now() where game = p_game;
  return v;
end;
$$;

-- GÜVENLİK: security definer RPC'ler varsayılan PUBLIC execute alır → client çağıramasın.
revoke execute on function public.canak_add(text, bigint) from public, anon, authenticated;
revoke execute on function public.canak_take(text) from public, anon, authenticated;

-- BÖLÜM 33 doğrulama:
--   select * from public.canak;
--   select proname from pg_proc where proname in ('canak_add','canak_take');

-- ─────────────────────────────────────────────────────────────────────
-- BÖLÜM 34) ÇANAK GEÇMİŞİ — her patlama kalıcı kayıt (kim, hangi oyun,
--   ne zaman, kaç çip). ÇANAK ekranı (ana menü 🏺) geçmiş sekmesi +
--   kartlarda "son patlatma" bilgisi + patlama sıklığı analizi buradan.
--   Yazma yalnız server (service-role); client OKUR.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.canak_events (
  id         bigint generated always as identity primary key,
  game       text   not null,             -- '51' | 'okey' | 'tavla'
  user_id    text   not null,
  name       text   not null default '',
  amount     bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists canak_events_game_idx on public.canak_events (game, created_at desc);
create index if not exists canak_events_created_idx on public.canak_events (created_at desc);

alter table public.canak_events enable row level security;
drop policy if exists canak_events_select on public.canak_events;
create policy canak_events_select on public.canak_events
  for select to authenticated using (true);
-- (insert policy YOK → yalnız service-role yazar)

-- BÖLÜM 34 doğrulama:
--   select * from public.canak_events order by id desc limit 5;

-- ─────────────────────────────────────────────────────────────────────
-- BÖLÜM 35) ADMİN ÖDÜLLERİ + ARKADAŞ SAYISI
--   Admin, kullanıcıya mesaj + çip/elmas ödülü gönderir ("güzel bildirim için
--   teşekkürler, 10.000 çip"). Kullanıcı oyuna girince modal görür, AL deyince
--   claim_admin_reward RPC'si ATOMİK olarak hesaba işler (ikinci kez alınamaz).
--   friend_count: profillerde "Arkadaşlar (N)" — RLS'e takılmadan sayı döner.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.admin_rewards (
  id         bigint generated always as identity primary key,
  user_id    text   not null,
  message    text   not null default '',
  chips      bigint not null default 0,
  diamonds   int    not null default 0,
  admin_name text   not null default '',
  claimed    boolean not null default false,
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);
create index if not exists admin_rewards_user_idx on public.admin_rewards (user_id, claimed);

alter table public.admin_rewards enable row level security;
drop policy if exists admin_rewards_select on public.admin_rewards;
create policy admin_rewards_select on public.admin_rewards
  for select to authenticated
  using (user_id = auth.uid()::text
     or exists (select 1 from public.profiles pr where pr.id = auth.uid()::text and pr.role = 'admin'));
drop policy if exists admin_rewards_insert on public.admin_rewards;
create policy admin_rewards_insert on public.admin_rewards
  for insert to authenticated
  with check (exists (select 1 from public.profiles pr where pr.id = auth.uid()::text and pr.role = 'admin'));

-- Ödülü AL (atomik; yalnız sahibi, yalnız bir kez). Ödenen çip miktarını döner (-1 = geçersiz).
create or replace function public.claim_admin_reward(p_id bigint)
returns bigint
language plpgsql
security definer
as $$
declare r record;
begin
  select * into r from public.admin_rewards
   where id = p_id and user_id = auth.uid()::text and claimed = false
   for update;
  if r is null then return -1; end if;
  update public.admin_rewards set claimed = true, claimed_at = now() where id = p_id;
  update public.profiles
     set chips = coalesce(chips,0) + r.chips,
         diamonds = coalesce(diamonds,0) + r.diamonds
   where id = r.user_id;
  return r.chips;
end;
$$;

-- Arkadaş sayısı (profil rozeti) — herkes herkesinkini SAYI olarak görebilir.
-- NOT: friendships.requester/addressee UUID, p_user TEXT → ::uuid cast ŞART
--   (profiles.id text / auth.uid() uuid ikiliğinin aynısı — BÖLÜM 8 dersi).
create or replace function public.friend_count(p_user text)
returns integer
language sql
security definer
as $$
  select count(*)::int from public.friendships
   where status = 'accepted'
     and (requester = p_user::uuid or addressee = p_user::uuid);
$$;

-- ─────────────────────────────────────────────────────────────────────
-- BÖLÜM 36) FOTOĞRAF ONAY SİSTEMİ — yeni yüklenen profil fotoğrafı admin
--   onayına düşer: pending → visible / rejected. Mevcut fotolar 'visible'
--   (kırılma yok); YENİ yüklemede client 'pending' yazar ve foto onaylanana
--   dek presence'a YAYINLANMAZ (heartbeat client tarafı).
-- ─────────────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists avatar_status text not null default 'visible';

-- Admin foto kararı (visible/rejected) — içeride admin kontrolü.
create or replace function public.admin_set_avatar_status(p_user text, p_status text)
returns boolean
language plpgsql
security definer
as $$
begin
  if not exists (select 1 from public.profiles pr where pr.id = auth.uid()::text and pr.role = 'admin') then
    return false;
  end if;
  if p_status not in ('visible','rejected','pending','invisible') then return false; end if;
  update public.profiles set avatar_status = p_status where id = p_user;
  return true;
end;
$$;

-- BÖLÜM 35/36 doğrulama:
--   select proname from pg_proc where proname in ('claim_admin_reward','friend_count','admin_set_avatar_status');
--   select column_name from information_schema.columns where table_name='profiles' and column_name='avatar_status';

-- ─────────────────────────────────────────────────────────────────────
-- BÖLÜM 37) DESTEK/ŞİKAYET: 'bug' kategorisi + SPAM KORUMASI
--   1) SupportScreen'e Bug kategorisi eklendi — eski CHECK ('istek','sikayet','oneri')
--      bug'ı REDDEDİYORDU; kısıt genişletildi.
--   2) Makro/flood koruması: 10 dakikada en çok 3, günde en çok 20 rapor.
--      TUZAK: reports SELECT'i admin-only → policy içindeki normal count()
--      kullanıcı için HEP 0 dönerdi; sayaç SECURITY DEFINER fonksiyonla alınır.
-- ─────────────────────────────────────────────────────────────────────
alter table public.reports drop constraint if exists reports_type_check;
alter table public.reports add constraint reports_type_check
  check (type in ('istek','sikayet','oneri','bug'));

create index if not exists reports_from_idx on public.reports (from_user, created_at desc);

create or replace function public.my_report_count(p_minutes int)
returns integer
language sql
security definer
as $$
  select count(*)::int from public.reports
   where from_user = auth.uid()
     and created_at > now() - make_interval(mins => p_minutes);
$$;

drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports
  for insert to authenticated
  with check (
    auth.uid() = from_user
    and public.my_report_count(10)   < 3    -- 10 dakikada en çok 3 rapor
    and public.my_report_count(1440) < 20   -- 24 saatte en çok 20 rapor
  );

-- BÖLÜM 37 doğrulama:
--   select conname from pg_constraint where conname='reports_type_check';
--   select proname from pg_proc where proname='my_report_count';

-- ─────────────────────────────────────────────────────────────────────
-- BÖLÜM 38) deduct_diamonds — HEDİYE ELMAS KESİNTİSİ (kayıp fonksiyon!)
--   Odalar (Okey/Tavla/51) hediyede rpc/deduct_diamonds çağırıyordu ama
--   fonksiyon HİÇ TANIMLANMAMIŞTI → RPC 404 → false → bakiye ne olursa olsun
--   "Yetersiz elmas". ("1050 elmasım var, yetersiz diyor" kökü buydu.)
--   Atomik: FOR UPDATE kilidi ile bakiye kontrol + düşüm tek adımda.
--   Yalnız sunucu (service-role) çağırır — client'a EXECUTE yok.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.deduct_diamonds(p_user_id text, p_amount int)
returns boolean
language plpgsql
security definer
as $$
declare cur int;
begin
  if p_amount is null or p_amount <= 0 then return false; end if;
  select coalesce(diamonds, 0) into cur
    from public.profiles where id = p_user_id for update;
  if not found or cur < p_amount then return false; end if;
  update public.profiles set diamonds = cur - p_amount where id = p_user_id;
  return true;
end;
$$;
revoke execute on function public.deduct_diamonds(text, int) from public, anon, authenticated;

-- BÖLÜM 38 doğrulama:
--   select proname from pg_proc where proname='deduct_diamonds';
--   (test) select public.deduct_diamonds('<kendi-uid>', 1);  -- service rolüyle true dönmeli
