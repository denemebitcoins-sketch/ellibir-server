-- Colyseus economy contract:
-- Rooms use these service-role RPCs for entry fees, refunds, canak payouts,
-- match payouts and bot/seat recovery flows. They must exist in every
-- Supabase environment, not only in manually patched live databases.

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