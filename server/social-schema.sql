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
drop policy if exists reports_delete on public.reports;
create policy reports_delete on public.reports
  for delete to authenticated
  using (public.is_current_user_admin());

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
set search_path = public
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

revoke execute on function public.record_match_stats(text, boolean, bigint) from public, anon, authenticated;
grant  execute on function public.record_match_stats(text, boolean, bigint) to service_role;

-- ---------------------------------------------------------------------
-- 11B) CHIP ECONOMY RPCs -- service-role only
--      Colyseus rooms charge entry fees, refund seats, pay canak/match
--      winnings through these RPCs. Keep them in schema/migrations so a
--      restored Supabase project cannot boot without the economy contract.
-- ---------------------------------------------------------------------
create or replace function public.add_chips(p_user_id text, p_amount bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null or btrim(p_user_id) = '' or p_amount is null or p_amount <= 0 then
    return false;
  end if;

  update public.profiles
     set chips = coalesce(chips, 0) + p_amount
   where id = p_user_id;

  return found;
end;
$$;

create or replace function public.deduct_chips(p_user_id text, p_amount bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_chips bigint;
begin
  if p_user_id is null or btrim(p_user_id) = '' or p_amount is null or p_amount <= 0 then
    return false;
  end if;

  select coalesce(chips, 0)
    into current_chips
    from public.profiles
   where id = p_user_id
   for update;

  if not found or current_chips < p_amount then
    return false;
  end if;

  update public.profiles
     set chips = current_chips - p_amount
   where id = p_user_id;

  return true;
end;
$$;

revoke execute on function public.add_chips(text, bigint) from public, anon, authenticated;
revoke execute on function public.deduct_chips(text, bigint) from public, anon, authenticated;
grant  execute on function public.add_chips(text, bigint) to service_role;
grant  execute on function public.deduct_chips(text, bigint) to service_role;

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
-- pg_cron opsiyoneldir; extension yoksa ana şema yine eksiksiz kurulmalıdır.
do $$
declare v_job bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    for v_job in select jobid from cron.job where jobname = 'invites-temizlik' loop
      perform cron.unschedule(v_job);
    end loop;
    perform cron.schedule(
      'invites-temizlik',
      '17 * * * *',
      $q$ delete from public.invites where created_at < now() - interval '10 minutes' $q$
    );
  end if;
end $$;

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
create table if not exists public.gifts (
  id          bigint generated always as identity primary key,
  from_user   uuid not null references auth.users(id) on delete cascade,
  to_user     uuid not null references auth.users(id) on delete cascade,
  gift_type   int not null check (gift_type between 1 and 12),
  scope       text not null default 'partner' check (scope in ('self','partner','all')),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists gifts_to_active_idx on public.gifts (to_user, expires_at desc);
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
set search_path = public
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
set search_path = public
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
grant  execute on function public.canak_add(text, bigint) to service_role;
grant  execute on function public.canak_take(text) to service_role;

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

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'admin_rewards_nonnegative_amounts'
       and conrelid = 'public.admin_rewards'::regclass
  ) then
    alter table public.admin_rewards
      add constraint admin_rewards_nonnegative_amounts
      check (chips >= 0 and diamonds >= 0 and (chips > 0 or diamonds > 0)) not valid;
  end if;
end $$;

alter table public.admin_rewards enable row level security;
drop policy if exists admin_rewards_select on public.admin_rewards;
create policy admin_rewards_select on public.admin_rewards
  for select to authenticated
  using (user_id = auth.uid()::text
     or exists (select 1 from public.profiles pr where pr.id = auth.uid()::text and pr.role = 'admin'));
drop policy if exists admin_rewards_insert on public.admin_rewards;
create policy admin_rewards_insert on public.admin_rewards
  for insert to authenticated
  with check (
    exists (select 1 from public.profiles pr where pr.id = auth.uid()::text and pr.role = 'admin')
    and chips >= 0
    and diamonds >= 0
    and (chips > 0 or diamonds > 0)
  );

-- Ödülü AL (atomik; yalnız sahibi, yalnız bir kez). Ödenen çip miktarını döner (-1 = geçersiz).
create or replace function public.claim_admin_reward(p_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
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
revoke execute on function public.claim_admin_reward(bigint) from public, anon;
grant  execute on function public.claim_admin_reward(bigint) to authenticated;

-- Arkadaş sayısı (profil rozeti) — herkes herkesinkini SAYI olarak görebilir.
-- NOT: friendships.requester/addressee UUID, p_user TEXT → ::uuid cast ŞART
--   (profiles.id text / auth.uid() uuid ikiliğinin aynısı — BÖLÜM 8 dersi).
create or replace function public.friend_count(p_user text)
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::int from public.friendships
   where status = 'accepted'
     and (requester = p_user::uuid or addressee = p_user::uuid);
$$;
revoke execute on function public.friend_count(text) from public, anon;
grant  execute on function public.friend_count(text) to authenticated;

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
set search_path = public
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
revoke execute on function public.admin_set_avatar_status(text, text) from public, anon;
grant  execute on function public.admin_set_avatar_status(text, text) to authenticated;

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
set search_path = public
as $$
  select count(*)::int from public.reports
   where from_user = auth.uid()
     and created_at > now() - make_interval(mins => p_minutes);
$$;
revoke execute on function public.my_report_count(int) from public, anon;
grant  execute on function public.my_report_count(int) to authenticated;

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
set search_path = public
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

-- ─────────────────────────────────────────────────────────────────────
-- BÖLÜM 39) deduct_diamonds ONARIM — BÖLÜM 38 ÇAKIŞMA DÜZELTMESİ
--   deduct_diamonds Supabase'te 2026-07-01'den beri VARDI (şema dosyasına
--   yazılmamıştı). BÖLÜM 38'in create'i farklı imzanın yanına İKİNCİ bir
--   kopya yarattı → PostgREST aday seçemedi (ambiguous) → her hediye
--   "Yetersiz elmas". Bu bölüm İSİMLE EŞLEŞEN TÜM kopyaları düşürüp tek
--   kanonik (text,int) fonksiyonu bırakır + service_role'e açık EXECUTE.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'deduct_diamonds'
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;

create function public.deduct_diamonds(p_user_id text, p_amount int)
returns boolean
language plpgsql
security definer
set search_path = public
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
grant  execute on function public.deduct_diamonds(text, int) to service_role;

-- Doğrulama (TEK satır dönmeli):
--   select p.oid::regprocedure from pg_proc p
--     join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='public' and p.proname='deduct_diamonds';

-- ─────────────────────────────────────────────────────────────────────
-- BÖLÜM 40) PROFILES EKONOMİ KALKANI — CLIENT HASSAS ALAN YAZAMAZ
--   Unity profil push'u artık yalnız sosyal/profil alanlarını gönderir. Bu DB kalkanı da
--   kötü niyetli veya eski client chips/diamonds/role/vip/stat yazmaya kalkarsa değeri
--   INSERT'te güvenli başlangıca, UPDATE'te eski haline sabitler.
--   Service-role ve admin akışları serbesttir; ekonomi RPC'leri bu yüzden etkilenmez.
-- ─────────────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists chips bigint not null default 5000;
alter table public.profiles add column if not exists diamonds int not null default 5;
alter table public.profiles add column if not exists matches integer not null default 0;
alter table public.profiles add column if not exists wins integer not null default 0;
alter table public.profiles add column if not exists best_streak integer not null default 0;
alter table public.profiles add column if not exists cur_streak integer not null default 0;
alter table public.profiles add column if not exists total_won bigint not null default 0;
alter table public.profiles add column if not exists vip_until timestamptz;
alter table public.profiles add column if not exists last_daily date;
alter table public.profiles add column if not exists daily_day integer not null default 0;
alter table public.profiles add column if not exists vip_daily_day integer not null default 0;
alter table public.profiles add column if not exists vip_last_daily date;
alter table public.profiles add column if not exists role text not null default 'normal';
alter table public.profiles add column if not exists banned boolean not null default false;
alter table public.profiles add column if not exists chat_banned_until timestamptz;
alter table public.profiles add column if not exists game_banned_until timestamptz;
alter table public.profiles add column if not exists avatar_status text not null default 'visible';

create or replace function public.profiles_guard_client_sensitive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  jwt_role text := coalesce(auth.role(), '');
  is_admin boolean := false;
begin
  if jwt_role = 'service_role' or current_user in ('postgres', 'service_role') then
    return new;
  end if;

  if auth.uid() is not null then
    select exists(
      select 1 from public.profiles p
       where p.id::text = auth.uid()::text and p.role = 'admin'
    ) into is_admin;
  end if;

  if is_admin then
    return new;
  end if;

  if TG_OP = 'INSERT' then
    new.chips := 5000;
    new.diamonds := 5;
    new.matches := 0;
    new.wins := 0;
    new.best_streak := 0;
    new.cur_streak := 0;
    new.total_won := 0;
    new.vip_until := null;
    new.last_daily := null;
    new.daily_day := 0;
    new.vip_daily_day := 0;
    new.vip_last_daily := null;
    new.role := 'normal';
    new.banned := false;
    new.chat_banned_until := null;
    new.game_banned_until := null;
    new.avatar_status := 'visible';
  elsif TG_OP = 'UPDATE' then
    new.chips := old.chips;
    new.diamonds := old.diamonds;
    new.matches := old.matches;
    new.wins := old.wins;
    new.best_streak := old.best_streak;
    new.cur_streak := old.cur_streak;
    new.total_won := old.total_won;
    new.vip_until := old.vip_until;
    new.last_daily := old.last_daily;
    new.daily_day := old.daily_day;
    new.vip_daily_day := old.vip_daily_day;
    new.vip_last_daily := old.vip_last_daily;
    new.role := old.role;
    new.banned := old.banned;
    new.chat_banned_until := old.chat_banned_until;
    new.game_banned_until := old.game_banned_until;
    new.avatar_status := case when new.avatar_status = 'pending' then 'pending' else old.avatar_status end;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_profiles_guard_client_sensitive on public.profiles;
create trigger trg_profiles_guard_client_sensitive
before insert or update on public.profiles
for each row execute function public.profiles_guard_client_sensitive();

-- BÖLÜM 40 doğrulama:
--   select tgname from pg_trigger where tgname='trg_profiles_guard_client_sensitive';
--   authenticated client update chips/diamonds denemesi eski değerde kalmalı;
--   service_role RPC add_chips/deduct_chips çalışmaya devam etmeli.

-- ─────────────────────────────────────────────────────────────────────
-- BÖLÜM 41) GÜNLÜK ÖDÜL + VIP SONRADAN AÇILMA ONARIMI
--   Normal günlük ödül ile VIP günlük bonusu ayrı takip edilir. Oyuncu aynı gün
--   normal ödülü aldıktan sonra VIP alırsa claim_daily aynı gün yalnız VIP bonusunu
--   (+10.000 çip, +5 elmas) tekrar açar. Mock VIP RPC production IAP/receipt
--   doğrulaması gelene kadar client mağaza akışıyla aynı prototip davranışı sağlar.
-- ─────────────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists vip_last_daily date;

-- Mevcut kurulumlarda bu RPC'ler farkli return type ile tanimli olabilir.
-- PostgreSQL `create or replace function` ile return type degisimine izin vermez;
-- bu yuzden once dusurup asagida kanonik imzayla yeniden kuruyoruz.
drop function if exists public.buy_vip_mock(integer);
drop function if exists public.get_daily_state();
drop function if exists public.claim_daily(integer);

create or replace function public.buy_vip_mock(p_months int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := auth.uid()::text;
  v_months int := greatest(1, least(coalesce(p_months, 1), 12));
  r record;
  v_base timestamptz;
  v_until timestamptz;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false);
  end if;

  select * into r from public.profiles where id::text = v_uid for update;
  if not found then
    return jsonb_build_object('ok', false);
  end if;

  v_base := case when r.vip_until is not null and r.vip_until > now() then r.vip_until else now() end;
  v_until := v_base + make_interval(months => v_months);

  update public.profiles
     set vip_until = v_until
   where id::text = v_uid
   returning chips, diamonds, vip_until into r;

  return jsonb_build_object(
    'ok', true,
    'vip_until', r.vip_until,
    'chips', coalesce(r.chips, 0),
    'diamonds', coalesce(r.diamonds, 0)
  );
end;
$$;

create or replace function public.get_daily_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := auth.uid()::text;
  r record;
  v_today date := (now() at time zone 'Europe/Istanbul')::date;
  v_dow int := extract(isodow from (now() at time zone 'Europe/Istanbul'))::int;
  v_week text := to_char((now() at time zone 'Europe/Istanbul')::date, 'IYYY-IW');
  v_mask int := 0;
  v_vip_active boolean := false;
  v_vip_claimed boolean := false;
  v_vip_claimable boolean := false;
begin
  if auth.uid() is null then
    return jsonb_build_object('dow', v_dow, 'week', v_week, 'mask', 0, 'chips', 0, 'diamonds', 0,
      'vip_until', null, 'vip_claimed_today', false, 'vip_claimable_today', false);
  end if;

  select * into r from public.profiles where id::text = v_uid;
  if not found then
    return jsonb_build_object('dow', v_dow, 'week', v_week, 'mask', 0, 'chips', 0, 'diamonds', 0,
      'vip_until', null, 'vip_claimed_today', false, 'vip_claimable_today', false);
  end if;

  if r.last_daily is not null
     and to_char(r.last_daily, 'IYYY-IW') = v_week
     and coalesce(r.daily_day, 0) between 1 and 7 then
    v_mask := power(2, r.daily_day - 1)::int;
  end if;

  v_vip_active := coalesce(r.role, 'normal') = 'admin' or (r.vip_until is not null and r.vip_until > now());
  v_vip_claimed := r.vip_last_daily = v_today and coalesce(r.vip_daily_day, 0) = v_dow;
  v_vip_claimable := v_vip_active
    and r.last_daily = v_today
    and coalesce(r.daily_day, 0) = v_dow
    and not v_vip_claimed;

  return jsonb_build_object(
    'dow', v_dow,
    'week', v_week,
    'mask', v_mask,
    'chips', coalesce(r.chips, 0),
    'diamonds', coalesce(r.diamonds, 0),
    'vip_until', r.vip_until,
    'vip_claimed_today', v_vip_claimed,
    'vip_claimable_today', v_vip_claimable
  );
end;
$$;

create or replace function public.claim_daily(p_day int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := auth.uid()::text;
  r record;
  v_today date := (now() at time zone 'Europe/Istanbul')::date;
  v_dow int := extract(isodow from (now() at time zone 'Europe/Istanbul'))::int;
  v_normal_chips bigint[] := array[250, 400, 600, 900, 1300, 1800, 2500];
  v_chips_delta bigint := 0;
  v_diamonds_delta int := 0;
  v_vip_active boolean := false;
  v_normal_claimed boolean := false;
  v_vip_claimed boolean := false;
  v_vip_only boolean := false;
begin
  if auth.uid() is null or p_day is null or p_day <> v_dow then
    return jsonb_build_object('ok', false);
  end if;

  select * into r from public.profiles where id::text = v_uid for update;
  if not found then
    return jsonb_build_object('ok', false);
  end if;

  v_vip_active := coalesce(r.role, 'normal') = 'admin' or (r.vip_until is not null and r.vip_until > now());
  v_normal_claimed := r.last_daily = v_today and coalesce(r.daily_day, 0) = v_dow;
  v_vip_claimed := r.vip_last_daily = v_today and coalesce(r.vip_daily_day, 0) = v_dow;

  if v_normal_claimed then
    if v_vip_active and not v_vip_claimed then
      v_chips_delta := 10000;
      v_diamonds_delta := 5;
      v_vip_only := true;
      update public.profiles
         set chips = coalesce(chips, 0) + v_chips_delta,
             diamonds = coalesce(diamonds, 0) + v_diamonds_delta,
             vip_daily_day = v_dow,
             vip_last_daily = v_today
       where id::text = v_uid
       returning chips, diamonds into r;
    else
      return jsonb_build_object('ok', false, 'chips', coalesce(r.chips, 0), 'diamonds', coalesce(r.diamonds, 0));
    end if;
  else
    v_chips_delta := v_normal_chips[v_dow];
    v_diamonds_delta := case when v_dow = 7 then 2 else 0 end;
    if v_vip_active and not v_vip_claimed then
      v_chips_delta := v_chips_delta + 10000;
      v_diamonds_delta := v_diamonds_delta + 5;
    end if;

    update public.profiles
       set chips = coalesce(chips, 0) + v_chips_delta,
           diamonds = coalesce(diamonds, 0) + v_diamonds_delta,
           last_daily = v_today,
           daily_day = v_dow,
           vip_daily_day = case when v_vip_active and not v_vip_claimed then v_dow else vip_daily_day end,
           vip_last_daily = case when v_vip_active and not v_vip_claimed then v_today else vip_last_daily end
     where id::text = v_uid
     returning chips, diamonds into r;
  end if;

  return jsonb_build_object(
    'ok', true,
    'chips_delta', v_chips_delta,
    'diamonds_delta', v_diamonds_delta,
    'chips', coalesce(r.chips, 0),
    'diamonds', coalesce(r.diamonds, 0),
    'vip_only', v_vip_only
  );
end;
$$;

-- Production guvenligi: gercek Play Billing receipt dogrulayan RPC gelene kadar
-- mock VIP satin alma client tarafindan dogrudan cagrilamaz.
revoke execute on function public.buy_vip_mock(int) from public, anon, authenticated;
grant execute on function public.get_daily_state() to authenticated;
grant execute on function public.claim_daily(int) to authenticated;

-- BÖLÜM 41 doğrulama:
--   select proname from pg_proc where proname in ('buy_vip_mock','get_daily_state','claim_daily');


-- ─────────────────────────────────────────────────────────────────────
-- BÖLÜM 42) PROFİL + DM OTORİTE SERTLEŞTİRMESİ (2026-07-10)
-- Bu son bölüm önceki kurulumları güvenli nihai sözleşmeyle yeniden kurar.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.is_current_user_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id::text = auth.uid()::text
       and p.role = 'admin'
  );
$$;
revoke execute on function public.is_current_user_admin() from public, anon;
grant execute on function public.is_current_user_admin() to authenticated;

drop policy if exists reports_delete on public.reports;
create policy reports_delete on public.reports
  for delete to authenticated
  using (public.is_current_user_admin());

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
  for update to authenticated
  using (public.is_current_user_admin())
  with check (public.is_current_user_admin());

alter table public.profiles
  add column if not exists message_banned_until timestamptz;

alter table public.bans add column if not exists created_by_name text;

alter table public.bans drop constraint if exists bans_type_check;
alter table public.bans add constraint bans_type_check
  check (type in ('chat','message','game')) not valid;

create table if not exists public.blocks (
  id         bigint generated always as identity primary key,
  blocker    uuid not null references auth.users(id) on delete cascade,
  blocked    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (blocker, blocked),
  check (blocker <> blocked)
);
create index if not exists blocks_blocker_idx on public.blocks (blocker, created_at desc);
create index if not exists blocks_blocked_idx on public.blocks (blocked, created_at desc);
alter table public.blocks enable row level security;
drop policy if exists blocks_select on public.blocks;
create policy blocks_select on public.blocks
  for select to authenticated
  using (auth.uid() = blocker or auth.uid() = blocked);
drop policy if exists blocks_insert on public.blocks;
create policy blocks_insert on public.blocks
  for insert to authenticated
  with check (auth.uid() = blocker and blocker <> blocked);
drop policy if exists blocks_delete on public.blocks;
create policy blocks_delete on public.blocks
  for delete to authenticated
  using (auth.uid() = blocker);

create or replace function public.profiles_guard_client_sensitive()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  jwt_role text := coalesce(auth.role(), '');
  is_admin boolean := false;
begin
  -- SECURITY INVOKER önemlidir: doğrudan authenticated yazımda current_user
  -- authenticated kalır; onaylı SECURITY DEFINER RPC içinde owner/postgres olur.
  if jwt_role = 'service_role' or current_user in ('postgres', 'service_role') then
    return new;
  end if;

  if auth.uid() is not null then
    is_admin := public.is_current_user_admin();
  end if;
  if is_admin then return new; end if;

  if TG_OP = 'INSERT' then
    new.chips := 5000;
    new.diamonds := 5;
    new.matches := 0;
    new.wins := 0;
    new.best_streak := 0;
    new.cur_streak := 0;
    new.total_won := 0;
    new.vip_until := null;
    new.last_daily := null;
    new.daily_day := 0;
    new.vip_daily_day := 0;
    new.vip_last_daily := null;
    new.role := 'normal';
    new.banned := false;
    new.chat_banned_until := null;
    new.message_banned_until := null;
    new.game_banned_until := null;
    new.avatar_status := 'visible';
  elsif TG_OP = 'UPDATE' then
    new.chips := old.chips;
    new.diamonds := old.diamonds;
    new.matches := old.matches;
    new.wins := old.wins;
    new.best_streak := old.best_streak;
    new.cur_streak := old.cur_streak;
    new.total_won := old.total_won;
    new.vip_until := old.vip_until;
    new.last_daily := old.last_daily;
    new.daily_day := old.daily_day;
    new.vip_daily_day := old.vip_daily_day;
    new.vip_last_daily := old.vip_last_daily;
    new.role := old.role;
    new.banned := old.banned;
    new.chat_banned_until := old.chat_banned_until;
    new.message_banned_until := old.message_banned_until;
    new.game_banned_until := old.game_banned_until;
    new.avatar_status := case when new.avatar_status = 'pending' then 'pending' else old.avatar_status end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_guard_client_sensitive on public.profiles;
create trigger trg_profiles_guard_client_sensitive
before insert or update on public.profiles
for each row execute function public.profiles_guard_client_sensitive();

create or replace function public.can_send_direct_message(p_to uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and p_to is not null
     and p_to <> auth.uid()
     and not exists (
       select 1 from public.profiles p
        where p.id::text = auth.uid()::text
          and p.message_banned_until is not null
          and p.message_banned_until > now()
     )
     and exists (
       select 1 from public.profiles p
        where p.id::text = p_to::text
          and coalesce(p.allow_dm, true)
     )
     and exists (
       select 1 from public.friendships f
        where f.status = 'accepted'
          and ((f.requester = auth.uid() and f.addressee = p_to)
            or (f.requester = p_to and f.addressee = auth.uid()))
     )
     and not exists (
       select 1 from public.blocks b
        where (b.blocker = auth.uid() and b.blocked = p_to)
           or (b.blocker = p_to and b.blocked = auth.uid())
     );
$$;
revoke execute on function public.can_send_direct_message(uuid) from public, anon;
grant execute on function public.can_send_direct_message(uuid) to authenticated;

drop policy if exists dm_insert on public.direct_messages;
create policy dm_insert on public.direct_messages
  for insert to authenticated
  with check (
    auth.uid() = from_user
    and public.can_send_direct_message(to_user)
  );

create or replace function public.can_send_friend_request(p_to uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and p_to is not null
     and p_to <> auth.uid()
     and exists (
       select 1 from public.profiles p
        where p.id::text = p_to::text
          and coalesce(p.allow_friend_req, true)
     )
     and not exists (
       select 1 from public.blocks b
        where (b.blocker = auth.uid() and b.blocked = p_to)
           or (b.blocker = p_to and b.blocked = auth.uid())
     );
$$;
revoke execute on function public.can_send_friend_request(uuid) from public, anon;
grant execute on function public.can_send_friend_request(uuid) to authenticated;

drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships
  for insert to authenticated
  with check (
    auth.uid() = requester
    and public.can_send_friend_request(addressee)
  );
-- ─────────────────────────────────────────────────────────────────────
-- BÖLÜM 43) AKTİF SOSYAL RUNTIME SÖZLEŞMESİ (2026-07-10)
-- Unity'nin kullandığı tüm sosyal tablo/kolon/RLS/trigger tanımları.
-- ─────────────────────────────────────────────────────────────────────

alter table public.profiles add column if not exists name text not null default 'Oyuncu';
alter table public.profiles add column if not exists avatar int not null default 0;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists gender text;
alter table public.profiles add column if not exists invite_pref text not null default 'open';
alter table public.profiles add column if not exists allow_dm boolean not null default true;
alter table public.profiles add column if not exists allow_friend_req boolean not null default true;
alter table public.profiles add column if not exists gift_off boolean not null default false;
alter table public.profiles add column if not exists avatar_status text not null default 'visible';

alter table public.reports add column if not exists reported_user uuid;
alter table public.reports add column if not exists reported_name text;
alter table public.reports add column if not exists reported_text text;
alter table public.reports add column if not exists context text;

alter table public.presence add column if not exists gender text;
alter table public.presence add column if not exists role text not null default 'normal';
alter table public.presence add column if not exists chips bigint not null default 0;
alter table public.presence add column if not exists status text not null default 'lobi';
alter table public.presence add column if not exists table_no int not null default 0;
alter table public.presence add column if not exists table_mode text;
alter table public.presence add column if not exists table_info text;
alter table public.presence add column if not exists table_started boolean not null default false;
alter table public.presence add column if not exists table_seat int not null default -1;
alter table public.presence add column if not exists allow_dm boolean not null default true;
alter table public.presence add column if not exists allow_friend_req boolean not null default true;
alter table public.presence add column if not exists invite_pref text not null default 'open';
alter table public.presence add column if not exists gift_off boolean not null default false;
alter table public.presence add column if not exists avatar_url text;
alter table public.presence alter column last_seen set default now();

create or replace function public.presence_enforce_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare p record;
begin
  new.last_seen := now();
  select name, gender, role, chips, vip_until, avatar_url, avatar_status,
         allow_dm, allow_friend_req, invite_pref, gift_off
    into p
    from public.profiles
   where id::text = new.user_id::text;

  if found then
    new.name := coalesce(nullif(p.name, ''), 'Oyuncu');
    new.gender := p.gender;
    new.role := case
      when p.role = 'admin' then 'admin'
      when p.vip_until is not null and p.vip_until > now() then 'vip'
      else 'normal'
    end;
    new.chips := greatest(coalesce(p.chips, 0), 0);
    new.avatar_url := case
      when coalesce(p.avatar_status, 'visible') = 'visible' then p.avatar_url
      else null
    end;
    new.allow_dm := coalesce(p.allow_dm, true);
    new.allow_friend_req := coalesce(p.allow_friend_req, true);
    new.invite_pref := case when p.invite_pref in ('open','friends','closed')
                            then p.invite_pref else 'open' end;
    new.gift_off := coalesce(p.gift_off, false);
  end if;
  return new;
end;
$$;
revoke all on function public.presence_enforce_profile() from public;

drop trigger if exists trg_presence_touch on public.presence;
drop trigger if exists trg_presence_enforce_profile on public.presence;
create trigger trg_presence_enforce_profile
before insert or update on public.presence
for each row execute function public.presence_enforce_profile();

create or replace function public.can_write_social()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id::text = auth.uid()::text
       and (p.chat_banned_until is null or p.chat_banned_until <= now())
  );
$$;
revoke execute on function public.can_write_social() from public, anon;
grant execute on function public.can_write_social() to authenticated;

create or replace function public.can_write_lobby_chat()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id::text = auth.uid()::text
       and (p.chat_banned_until is null or p.chat_banned_until <= now())
       and (p.role = 'admin' or (p.vip_until is not null and p.vip_until > now()))
  );
$$;
revoke execute on function public.can_write_lobby_chat() from public, anon;
grant execute on function public.can_write_lobby_chat() to authenticated;

alter table public.lobby_chat add column if not exists kind text not null default 'msg';
alter table public.lobby_chat add column if not exists event text;

create or replace function public.lobby_chat_enforce_actor()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare p record;
begin
  -- Güvenilir SECURITY DEFINER sistem akışı kind='system' satırını korur.
  if current_user in ('postgres', 'service_role') and new.kind = 'system' then
    new.created_at := now();
    return new;
  end if;

  select name, role, vip_until into p
    from public.profiles where id::text = new.user_id::text;
  new.name := coalesce(nullif(p.name, ''), 'Oyuncu');
  new.role := case
    when p.role = 'admin' then 'admin'
    when p.vip_until is not null and p.vip_until > now() then 'vip'
    else 'normal'
  end;
  new.kind := 'msg';
  new.event := null;
  new.created_at := now();
  return new;
end;
$$;
revoke all on function public.lobby_chat_enforce_actor() from public;
drop trigger if exists trg_lobby_chat_enforce_actor on public.lobby_chat;
create trigger trg_lobby_chat_enforce_actor
before insert on public.lobby_chat
for each row execute function public.lobby_chat_enforce_actor();

drop policy if exists lobby_chat_insert on public.lobby_chat;
create policy lobby_chat_insert on public.lobby_chat
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and kind = 'msg'
    and public.can_write_lobby_chat()
  );

create or replace function public.reports_enforce_sender()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_name text;
begin
  select coalesce(nullif(p.name, ''), 'Oyuncu') into v_name
    from public.profiles p where p.id::text = new.from_user::text;
  new.name := coalesce(v_name, 'Oyuncu');
  return new;
end;
$$;
revoke all on function public.reports_enforce_sender() from public;
drop trigger if exists trg_reports_enforce_sender on public.reports;
create trigger trg_reports_enforce_sender
before insert on public.reports
for each row execute function public.reports_enforce_sender();

create table if not exists public.invites (
  id         bigint generated always as identity primary key,
  from_user  uuid not null references auth.users(id) on delete cascade,
  from_name  text,
  to_user    uuid not null references auth.users(id) on delete cascade,
  mode       text not null default 'solo',
  table_no   int not null default 1,
  bet        bigint not null default 0,
  created_at timestamptz not null default now(),
  seen       boolean not null default false,
  check (from_user <> to_user),
  check (char_length(mode) between 1 and 48),
  check (table_no between 1 and 10),
  check (bet >= 0)
);
create index if not exists invites_to_user_idx on public.invites (to_user, created_at desc);
create index if not exists invites_from_user_idx on public.invites (from_user, created_at desc);
alter table public.invites enable row level security;

create or replace function public.can_send_invite(p_to uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and p_to is not null
     and p_to <> auth.uid()
     and not exists (
       select 1 from public.blocks b
        where (b.blocker = auth.uid() and b.blocked = p_to)
           or (b.blocker = p_to and b.blocked = auth.uid())
     )
     and exists (
       select 1 from public.profiles p
        where p.id::text = p_to::text
          and (
            coalesce(p.invite_pref, 'open') = 'open'
            or (
              p.invite_pref = 'friends'
              and exists (
                select 1 from public.friendships f
                 where f.status = 'accepted'
                   and ((f.requester = auth.uid() and f.addressee = p_to)
                     or (f.requester = p_to and f.addressee = auth.uid()))
              )
            )
          )
     );
$$;
revoke execute on function public.can_send_invite(uuid) from public, anon;
grant execute on function public.can_send_invite(uuid) to authenticated;

create or replace function public.invites_enforce_sender()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_name text;
begin
  delete from public.invites where created_at < now() - interval '1 day';
  select coalesce(nullif(p.name, ''), 'Oyuncu') into v_name
    from public.profiles p where p.id::text = new.from_user::text;
  new.from_name := coalesce(v_name, 'Oyuncu');
  new.created_at := now();
  return new;
end;
$$;
revoke all on function public.invites_enforce_sender() from public;
drop trigger if exists trg_invites_enforce_sender on public.invites;
create trigger trg_invites_enforce_sender
before insert on public.invites
for each row execute function public.invites_enforce_sender();

drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites
  for insert to authenticated
  with check (auth.uid() = from_user and public.can_send_invite(to_user));
drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites
  for select to authenticated
  using (auth.uid() = from_user or auth.uid() = to_user);
drop policy if exists invites_update on public.invites;
create policy invites_update on public.invites
  for update to authenticated
  using (auth.uid() = to_user)
  with check (auth.uid() = to_user);
drop policy if exists invites_delete on public.invites;
create policy invites_delete on public.invites
  for delete to authenticated
  using (auth.uid() = from_user or auth.uid() = to_user);

create table if not exists public.posts (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null default 'status' check (kind in ('status','activity')),
  text       text not null check (char_length(text) between 1 and 280),
  created_at timestamptz not null default now()
);
create index if not exists posts_user_idx on public.posts (user_id, created_at desc);
alter table public.posts enable row level security;
drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts
  for select to authenticated using (true);
drop policy if exists posts_insert on public.posts;
create policy posts_insert on public.posts
  for insert to authenticated
  with check (auth.uid() = user_id and public.can_write_social());
drop policy if exists posts_delete on public.posts;
create policy posts_delete on public.posts
  for delete to authenticated using (auth.uid() = user_id);

create table if not exists public.post_likes (
  post_id    bigint not null references public.posts(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists post_likes_post_idx on public.post_likes (post_id);
alter table public.post_likes enable row level security;
drop policy if exists post_likes_select on public.post_likes;
create policy post_likes_select on public.post_likes
  for select to authenticated using (true);
drop policy if exists post_likes_insert on public.post_likes;
create policy post_likes_insert on public.post_likes
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists post_likes_delete on public.post_likes;
create policy post_likes_delete on public.post_likes
  for delete to authenticated using (auth.uid() = user_id);

create table if not exists public.post_comments (
  id         bigint generated always as identity primary key,
  post_id    bigint not null references public.posts(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  text       text not null check (char_length(text) between 1 and 280),
  created_at timestamptz not null default now()
);
create index if not exists post_comments_post_idx on public.post_comments (post_id, created_at);
alter table public.post_comments enable row level security;
drop policy if exists post_comments_select on public.post_comments;
create policy post_comments_select on public.post_comments
  for select to authenticated using (true);
drop policy if exists post_comments_insert on public.post_comments;
create policy post_comments_insert on public.post_comments
  for insert to authenticated
  with check (auth.uid() = user_id and public.can_write_social());
drop policy if exists post_comments_delete on public.post_comments;
create policy post_comments_delete on public.post_comments
  for delete to authenticated using (auth.uid() = user_id);

create table if not exists public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  actor_id   uuid not null references auth.users(id) on delete cascade,
  type       text not null,
  post_id    bigint references public.posts(id) on delete cascade,
  preview    text,
  seen       boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('like','comment','visit')) not valid;
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unseen_idx on public.notifications (user_id) where not seen;
alter table public.notifications enable row level security;
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications
  for delete to authenticated using (auth.uid() = user_id);
drop policy if exists notifications_insert on public.notifications;

create or replace function public.notify_on_like()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_owner uuid;
begin
  select user_id into v_owner from public.posts where id = new.post_id;
  if v_owner is not null and v_owner <> new.user_id then
    insert into public.notifications (user_id, actor_id, type, post_id)
    values (v_owner, new.user_id, 'like', new.post_id);
  end if;
  return new;
end;
$$;
revoke all on function public.notify_on_like() from public;
drop trigger if exists notify_like_trg on public.post_likes;
create trigger notify_like_trg
after insert on public.post_likes
for each row execute function public.notify_on_like();

create or replace function public.notify_on_comment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_owner uuid;
begin
  select user_id into v_owner from public.posts where id = new.post_id;
  if v_owner is not null and v_owner <> new.user_id then
    insert into public.notifications (user_id, actor_id, type, post_id, preview)
    values (v_owner, new.user_id, 'comment', new.post_id, left(new.text, 80));
  end if;
  return new;
end;
$$;
revoke all on function public.notify_on_comment() from public;
drop trigger if exists notify_comment_trg on public.post_comments;
create trigger notify_comment_trg
after insert on public.post_comments
for each row execute function public.notify_on_comment();

create table if not exists public.profile_views (
  id         bigint generated always as identity primary key,
  viewer_id  uuid not null references auth.users(id) on delete cascade,
  target_id  uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (viewer_id <> target_id)
);
create index if not exists profile_views_pair_idx
  on public.profile_views (viewer_id, target_id, created_at desc);
create index if not exists profile_views_target_idx
  on public.profile_views (target_id, created_at desc);
create index if not exists profile_views_created_idx
  on public.profile_views (created_at);
alter table public.profile_views enable row level security;
drop policy if exists profile_views_select on public.profile_views;
create policy profile_views_select on public.profile_views
  for select to authenticated
  using (auth.uid() = viewer_id or auth.uid() = target_id);
drop policy if exists profile_views_insert on public.profile_views;
create policy profile_views_insert on public.profile_views
  for insert to authenticated
  with check (auth.uid() = viewer_id and viewer_id <> target_id);

create or replace function public.profile_view_dedupe()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.profile_views where created_at < now() - interval '30 days';
  if exists (
    select 1 from public.profile_views pv
     where pv.viewer_id = new.viewer_id
       and pv.target_id = new.target_id
       and pv.created_at > now() - interval '1 hour'
  ) then
    return null;
  end if;
  new.created_at := now();
  return new;
end;
$$;
revoke all on function public.profile_view_dedupe() from public;
drop trigger if exists trg_profile_view_dedupe on public.profile_views;
create trigger trg_profile_view_dedupe
before insert on public.profile_views
for each row execute function public.profile_view_dedupe();

create or replace function public.notify_on_profile_view()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (user_id, actor_id, type)
  values (new.target_id, new.viewer_id, 'visit');
  return new;
end;
$$;
revoke all on function public.notify_on_profile_view() from public;
drop trigger if exists notify_profile_view_trg on public.profile_views;
create trigger notify_profile_view_trg
after insert on public.profile_views
for each row execute function public.notify_on_profile_view();

create table if not exists public.gifts (
  id         bigint generated always as identity primary key,
  from_user  uuid not null references auth.users(id) on delete cascade,
  to_user    uuid not null references auth.users(id) on delete cascade,
  gift_type  int not null check (gift_type between 1 and 12),
  scope      text not null default 'partner' check (scope in ('self','partner','all')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists gifts_to_active_idx on public.gifts (to_user, expires_at desc);
alter table public.gifts enable row level security;
drop policy if exists gifts_select on public.gifts;
create policy gifts_select on public.gifts
  for select to authenticated using (true);
drop policy if exists gifts_insert on public.gifts;
drop policy if exists gifts_update on public.gifts;
drop policy if exists gifts_delete on public.gifts;

create or replace function public.gifts_prune()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.gifts where expires_at < now() - interval '1 day';
  new.created_at := now();
  return new;
end;
$$;
revoke all on function public.gifts_prune() from public;
drop trigger if exists trg_gifts_prune on public.gifts;
create trigger trg_gifts_prune
before insert on public.gifts
for each row execute function public.gifts_prune();
