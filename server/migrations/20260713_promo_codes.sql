-- Promosyon kodu altyapısı: kod kataloğu istemciden gizli, kullanım atomik ve kullanıcı başına tektir.
create table if not exists public.promo_codes (
  code text primary key,
  active boolean not null default true,
  starts_at timestamptz,
  expires_at timestamptz,
  chip_reward bigint not null default 0 check (chip_reward >= 0),
  diamond_reward integer not null default 0 check (diamond_reward >= 0),
  max_redemptions integer check (max_redemptions is null or max_redemptions > 0),
  redemption_count integer not null default 0 check (redemption_count >= 0),
  created_at timestamptz not null default now(),
  check (code = upper(btrim(code))),
  check (char_length(code) between 3 and 32),
  check (code ~ '^[A-Z0-9_-]+$'),
  check (chip_reward > 0 or diamond_reward > 0)
);

create table if not exists public.promo_redemptions (
  code text not null references public.promo_codes(code) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  chip_reward bigint not null default 0,
  diamond_reward integer not null default 0,
  redeemed_at timestamptz not null default now(),
  primary key (code, user_id)
);

create index if not exists promo_redemptions_user_idx
  on public.promo_redemptions (user_id, redeemed_at desc);

alter table public.promo_codes enable row level security;
alter table public.promo_redemptions enable row level security;

-- Bilinmeyen/geçersiz kodların katalog üzerinden taranmasını engellemek için istemciye
-- doğrudan tablo politikası verilmez. Yalnız aşağıdaki RPC kendi kodunu doğrular.
create or replace function public.redeem_promo_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(btrim(coalesce(p_code, '')));
  c public.promo_codes%rowtype;
  p public.profiles%rowtype;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if char_length(v_code) < 3 or char_length(v_code) > 32 or v_code !~ '^[A-Z0-9_-]+$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  select * into c
    from public.promo_codes
   where code = v_code
   for update;
  if not found or not c.active
     or (c.starts_at is not null and now() < c.starts_at)
     or (c.expires_at is not null and now() >= c.expires_at) then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;
  if c.max_redemptions is not null and c.redemption_count >= c.max_redemptions then
    return jsonb_build_object('ok', false, 'error', 'limit_reached');
  end if;
  if exists (select 1 from public.promo_redemptions where code = v_code and user_id = v_uid) then
    return jsonb_build_object('ok', false, 'error', 'already_redeemed');
  end if;

  select * into p from public.profiles where id = v_uid for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'profile_not_found');
  end if;

  insert into public.promo_redemptions(code, user_id, chip_reward, diamond_reward)
  values (v_code, v_uid, c.chip_reward, c.diamond_reward);

  update public.promo_codes
     set redemption_count = redemption_count + 1
   where code = v_code;

  update public.profiles
     set chips = coalesce(chips, 0) + c.chip_reward,
         diamonds = coalesce(diamonds, 0) + c.diamond_reward
   where id = v_uid
   returning * into p;

  return jsonb_build_object(
    'ok', true,
    'chips_delta', c.chip_reward,
    'diamonds_delta', c.diamond_reward,
    'chips', coalesce(p.chips, 0),
    'diamonds', coalesce(p.diamonds, 0)
  );
end;
$$;

revoke all on function public.redeem_promo_code(text) from public;
grant execute on function public.redeem_promo_code(text) to authenticated;
