-- Online Kahvem - Cosmetic ownership and equip authority
-- Stores permanent cosmetic ownership and validates diamond purchases server-side.

alter table if exists public.profiles
  add column if not exists equipped_profile_frame text not null default 'profile_frame_default';

create table if not exists public.cosmetic_ownerships (
  user_id uuid not null references public.profiles(id) on delete cascade,
  cosmetic_id text not null,
  category text not null,
  source text not null default 'purchase',
  acquired_at timestamp with time zone not null default now(),
  primary key (user_id, cosmetic_id),
  constraint cosmetic_ownerships_category_chk
    check (category in ('profile_frame', 'emoji_pack', 'table_bg', 'card_back', 'rack', 'dice', 'scoreboard'))
);

create index if not exists cosmetic_ownerships_user_idx
  on public.cosmetic_ownerships(user_id, acquired_at desc);

create table if not exists public.cosmetic_transactions (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  cosmetic_id text not null,
  category text not null,
  diamond_delta integer not null,
  created_at timestamp with time zone not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists cosmetic_transactions_user_idx
  on public.cosmetic_transactions(user_id, created_at desc);

create or replace function public.cosmetic_purchase(
  p_user_id uuid,
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
  if p_category not in ('profile_frame', 'emoji_pack', 'table_bg', 'card_back', 'rack', 'dice', 'scoreboard') then
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
  p_user_id uuid,
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
  if p_category not in ('profile_frame', 'emoji_pack', 'table_bg', 'card_back', 'rack', 'dice', 'scoreboard') then
    return jsonb_build_object('ok', false, 'error', 'invalid_category');
  end if;

  insert into public.cosmetic_ownerships(user_id, cosmetic_id, category, source)
  values (p_user_id, p_cosmetic_id, p_category, coalesce(nullif(trim(p_source), ''), 'admin_grant'))
  on conflict (user_id, cosmetic_id) do update
    set source = excluded.source;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.equip_profile_frame(
  p_user_id uuid,
  p_cosmetic_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text := coalesce(nullif(trim(p_cosmetic_id), ''), 'profile_frame_default');
  v_role text;
  v_owns boolean;
begin
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  select coalesce(role, 'normal')
    into v_role
    from public.profiles
   where id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'profile_not_found');
  end if;

  if v_id <> 'profile_frame_default' then
    select exists(
      select 1 from public.cosmetic_ownerships
       where user_id = p_user_id
         and cosmetic_id = v_id
         and category = 'profile_frame'
    ) into v_owns;

    if not v_owns and v_role <> 'admin' then
      return jsonb_build_object('ok', false, 'error', 'not_owned');
    end if;
  end if;

  update public.profiles
     set equipped_profile_frame = v_id,
         updated_at = now()
   where id = p_user_id;

  return jsonb_build_object('ok', true, 'equipped_profile_frame', v_id);
end;
$$;

revoke all on table public.cosmetic_ownerships from anon, authenticated;
revoke all on table public.cosmetic_transactions from anon, authenticated;
revoke execute on function public.cosmetic_purchase(uuid, text, text, integer) from public, anon, authenticated;
revoke execute on function public.cosmetic_grant(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.equip_profile_frame(uuid, text) from public, anon, authenticated;
grant execute on function public.cosmetic_purchase(uuid, text, text, integer) to service_role;
grant execute on function public.cosmetic_grant(uuid, text, text, text) to service_role;
grant execute on function public.equip_profile_frame(uuid, text) to service_role;
