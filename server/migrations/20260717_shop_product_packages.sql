-- Online Kahvem - Shop product packages (chips / diamonds / VIP 1-6-12)
-- Run after 20260716_monetization_authority.sql. This supersedes the earlier
-- VIP-only 20260717_vip_6month_products.sql finalizer.

begin;

create or replace function public.finalize_play_purchase(
  p_user_id uuid,
  p_product_id text,
  p_purchase_token text,
  p_order_id text,
  p_package_name text,
  p_product_type text,
  p_raw_receipt jsonb,
  p_store_response jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.play_purchase_receipts%rowtype;
  v_chip_delta bigint := 0;
  v_diamonds integer := 0;
  v_months integer := 0;
  v_expiry timestamptz;
  v_chips bigint;
  v_wallet_diamonds integer;
  v_vip_until timestamptz;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_package_name <> 'com.elli.bir' or coalesce(trim(p_purchase_token), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'receipt_invalid');
  end if;

  select * into v_existing from public.play_purchase_receipts
   where purchase_token = p_purchase_token for update;
  if found then
    if v_existing.user_id <> p_user_id or v_existing.product_id <> p_product_id then
      return jsonb_build_object('ok', false, 'error', 'receipt_owned_by_another_account');
    end if;
    if v_existing.state = 'verified' then
      select chips, diamonds, vip_until into v_chips, v_wallet_diamonds, v_vip_until
        from public.profiles where id::text = p_user_id::text;
      return jsonb_build_object('ok', true, 'duplicate', true, 'chips', v_chips,
        'diamonds', v_wallet_diamonds, 'vip_until', v_vip_until);
    end if;
  else
    insert into public.play_purchase_receipts(
      user_id, product_id, purchase_token, order_id, package_name, product_type,
      raw_receipt, store_response
    ) values (
      p_user_id, p_product_id, p_purchase_token, p_order_id, p_package_name,
      p_product_type, coalesce(p_raw_receipt, '{}'::jsonb), coalesce(p_store_response, '{}'::jsonb)
    );
  end if;

  case p_product_id
    when 'onlinekahvem.chips.100k' then v_chip_delta := 100000;
    when 'onlinekahvem.chips.250k' then v_chip_delta := 250000;
    when 'onlinekahvem.chips.600k' then v_chip_delta := 600000;
    when 'onlinekahvem.chips.1500k' then v_chip_delta := 1500000;
    when 'onlinekahvem.chips.4000k' then v_chip_delta := 4000000;
    when 'onlinekahvem.diamond.100' then v_diamonds := 100;
    when 'onlinekahvem.diamond.300' then v_diamonds := 300;
    when 'onlinekahvem.diamond.750' then v_diamonds := 750;
    when 'onlinekahvem.diamond.1750' then v_diamonds := 1750;
    when 'onlinekahvem.diamond.4000' then v_diamonds := 4000;
    when 'onlinekahvem.vip.1month' then v_months := 1;
    when 'onlinekahvem.vip.6month' then v_months := 6;
    when 'onlinekahvem.vip.12month' then v_months := 12;
    else
      update public.play_purchase_receipts set state = 'rejected' where purchase_token = p_purchase_token;
      return jsonb_build_object('ok', false, 'error', 'product_invalid');
  end case;

  if v_chip_delta > 0 then
    update public.profiles set chips = chips + v_chip_delta
      where id::text = p_user_id::text;
  elsif v_diamonds > 0 then
    update public.profiles set diamonds = diamonds + v_diamonds
      where id::text = p_user_id::text;
  else
    begin
      v_expiry := nullif(p_store_response #>> '{lineItems,0,expiryTime}', '')::timestamptz;
    exception when others then v_expiry := null;
    end;
    update public.profiles
       set vip_until = greatest(coalesce(vip_until, now()), now())
                       + make_interval(months => v_months)
     where id::text = p_user_id::text;
    if v_expiry is not null then
      update public.profiles set vip_until = greatest(vip_until, v_expiry)
        where id::text = p_user_id::text;
    end if;
  end if;

  update public.play_purchase_receipts
     set state = 'verified', store_response = coalesce(p_store_response, '{}'::jsonb), verified_at = now()
   where purchase_token = p_purchase_token;

  select chips, diamonds, vip_until into v_chips, v_wallet_diamonds, v_vip_until
    from public.profiles where id::text = p_user_id::text;
  return jsonb_build_object('ok', true, 'chips', v_chips, 'diamonds', v_wallet_diamonds,
    'vip_until', v_vip_until, 'product_id', p_product_id,
    'chip_delta', v_chip_delta, 'diamond_delta', v_diamonds);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'receipt_reused');
end;
$$;

revoke all on function public.finalize_play_purchase(uuid, text, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_play_purchase(uuid, text, text, text, text, text, jsonb, jsonb) to service_role;

commit;
