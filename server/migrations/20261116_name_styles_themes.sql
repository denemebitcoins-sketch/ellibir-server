-- Online Kahvem - İsim stilleri (elmas) + elmasla açılan arayüz temaları (2026-11-16)
-- 1) Yeni kozmetik kategorileri: name_style, ui_theme.
-- 2) profiles.equipped_name_style + sunucu yetkili takma fonksiyonu.
-- 3) presence/lobby_chat satırlarına name_style DAİMA profilden yazılır (istemci sahte stil gönderemez).
-- Uygulama sırası: ÖNCE bu migration, SONRA sunucu push (sunucu yeni kolonu okur).

begin;

alter table public.profiles
  add column if not exists equipped_name_style text not null default '';
alter table public.presence
  add column if not exists name_style text not null default '';
alter table public.lobby_chat
  add column if not exists name_style text not null default '';

-- Kategori listesi: name_style + ui_theme eklendi.
alter table public.cosmetic_ownerships drop constraint if exists cosmetic_ownerships_category_chk;
alter table public.cosmetic_ownerships add constraint cosmetic_ownerships_category_chk
  check (category in ('profile_frame', 'emoji_pack', 'table_bg', 'card_back', 'rack', 'dice', 'scoreboard', 'name_style', 'ui_theme'));

create or replace function public.cosmetic_purchase(
  p_user_id text,
  p_cosmetic_id text,
  p_category text,
  p_diamond_cost integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_diamonds integer;
  v_owned boolean;
begin
  if p_user_id is null or nullif(trim(p_cosmetic_id), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;
  if p_category not in ('profile_frame', 'emoji_pack', 'table_bg', 'card_back', 'rack', 'dice', 'scoreboard', 'name_style', 'ui_theme') then
    return jsonb_build_object('ok', false, 'error', 'invalid_category');
  end if;
  if coalesce(p_diamond_cost, 0) < 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_price');
  end if;

  select exists(
    select 1 from public.cosmetic_ownerships
    where user_id = p_user_id and cosmetic_id = p_cosmetic_id
  ) into v_owned;

  select coalesce(diamonds, 0)
    into v_diamonds
    from public.profiles
   where id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'profile_not_found');
  end if;

  if v_owned then
    return jsonb_build_object('ok', true, 'already_owned', true, 'diamonds', v_diamonds);
  end if;

  if v_diamonds < coalesce(p_diamond_cost, 0) then
    return jsonb_build_object('ok', false, 'error', 'insufficient_diamonds', 'diamonds', v_diamonds);
  end if;

  v_diamonds := v_diamonds - coalesce(p_diamond_cost, 0);

  update public.profiles
     set diamonds = v_diamonds,
         updated_at = now()
   where id = p_user_id;

  insert into public.cosmetic_ownerships(user_id, cosmetic_id, category, source)
  values (p_user_id, p_cosmetic_id, p_category, 'purchase')
  on conflict (user_id, cosmetic_id) do nothing;

  insert into public.cosmetic_transactions(user_id, cosmetic_id, category, diamond_delta, metadata)
  values (p_user_id, p_cosmetic_id, p_category, -coalesce(p_diamond_cost, 0),
          jsonb_build_object('source', 'diamond_purchase'));

  return jsonb_build_object('ok', true, 'already_owned', false, 'diamonds', v_diamonds);
end;
$$;

create or replace function public.cosmetic_grant(
  p_user_id text,
  p_cosmetic_id text,
  p_category text,
  p_source text default 'admin_grant'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null or nullif(trim(p_cosmetic_id), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;
  if p_category not in ('profile_frame', 'emoji_pack', 'table_bg', 'card_back', 'rack', 'dice', 'scoreboard', 'name_style', 'ui_theme') then
    return jsonb_build_object('ok', false, 'error', 'invalid_category');
  end if;

  insert into public.cosmetic_ownerships(user_id, cosmetic_id, category, source)
  values (p_user_id, p_cosmetic_id, p_category, coalesce(nullif(trim(p_source), ''), 'admin_grant'))
  on conflict (user_id, cosmetic_id) do update
    set source = excluded.source;

  return jsonb_build_object('ok', true);
end;
$$;

-- İsim stili tak / çıkar ('' = standart). Sahiplik sunucuda doğrulanır; admin her stili test edebilir.
create or replace function public.equip_name_style(
  p_user_id text,
  p_cosmetic_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text := coalesce(trim(p_cosmetic_id), '');
  v_role text;
  v_owns boolean;
begin
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  select coalesce(role, 'normal') into v_role
    from public.profiles where id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'profile_not_found');
  end if;

  if v_id <> '' then
    select exists(
      select 1 from public.cosmetic_ownerships
       where user_id = p_user_id and cosmetic_id = v_id and category = 'name_style'
    ) into v_owns;
    if not v_owns and v_role <> 'admin' then
      return jsonb_build_object('ok', false, 'error', 'not_owned');
    end if;
  end if;

  update public.profiles
     set equipped_name_style = v_id,
         updated_at = now()
   where id = p_user_id;

  return jsonb_build_object('ok', true, 'equipped_name_style', v_id);
end;
$$;

-- presence / lobby_chat: name_style profilden (mevcut tetikleyicilere dokunmadan ayrı tetikleyici).
create or replace function public.social_row_name_style()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_style text;
begin
  select coalesce(equipped_name_style, '') into v_style
    from public.profiles where id::text = new.user_id::text;
  new.name_style := coalesce(v_style, '');
  return new;
end;
$$;
revoke all on function public.social_row_name_style() from public;

drop trigger if exists trg_presence_name_style on public.presence;
create trigger trg_presence_name_style
before insert or update on public.presence
for each row execute function public.social_row_name_style();

drop trigger if exists trg_lobby_chat_name_style on public.lobby_chat;
create trigger trg_lobby_chat_name_style
before insert on public.lobby_chat
for each row execute function public.social_row_name_style();

-- Takılı kozmetikler yalnız sunucu fonksiyonlarıyla değişir (istemci profil kaydı parasız stil takamasın).
create or replace function public.profiles_guard_equipped_cosmetics()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' or current_user in ('postgres', 'service_role') then
    return new;
  end if;
  if auth.uid() is not null and public.is_current_user_admin() then
    return new;
  end if;
  new.equipped_name_style := old.equipped_name_style;
  new.equipped_profile_frame := old.equipped_profile_frame;
  return new;
end;
$$;
drop trigger if exists trg_profiles_guard_equipped_cosmetics on public.profiles;
create trigger trg_profiles_guard_equipped_cosmetics
before update on public.profiles
for each row execute function public.profiles_guard_equipped_cosmetics();

revoke execute on function public.equip_name_style(text, text) from public, anon, authenticated;
grant execute on function public.equip_name_style(text, text) to service_role;

commit;
