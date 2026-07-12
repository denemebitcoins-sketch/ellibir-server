-- Online Kahvem - authoritative diamond-to-chip shop exchange (2026-07-12)
-- Supabase SQL Editor'da bir kez calistirin. Yeniden calistirilabilir.

begin;

drop function if exists public.buy_chip_package(int);
create function public.buy_chip_package(p_package int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_chip_delta bigint;
  v_diamond_cost int;
  v_chips bigint;
  v_diamonds int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'auth_required');
  end if;

  case p_package
    when 1 then v_chip_delta := 1000; v_diamond_cost := 2;
    when 2 then v_chip_delta := 3000; v_diamond_cost := 5;
    when 3 then v_chip_delta := 8000; v_diamond_cost := 10;
    else return jsonb_build_object('ok', false, 'error', 'invalid_package');
  end case;

  select coalesce(p.chips, 0), coalesce(p.diamonds, 0)
    into v_chips, v_diamonds
    from public.profiles p
   where p.id::text = v_uid::text
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'profile_missing');
  end if;
  if v_diamonds < v_diamond_cost then
    return jsonb_build_object(
      'ok', false, 'error', 'insufficient_diamonds',
      'chips', v_chips, 'diamonds', v_diamonds
    );
  end if;

  v_chips := v_chips + v_chip_delta;
  v_diamonds := v_diamonds - v_diamond_cost;
  update public.profiles
     set chips = v_chips,
         diamonds = v_diamonds,
         updated_at = now()
   where id::text = v_uid::text;

  return jsonb_build_object(
    'ok', true, 'error', '',
    'chips_delta', v_chip_delta, 'diamonds_delta', -v_diamond_cost,
    'chips', v_chips, 'diamonds', v_diamonds
  );
end;
$$;

revoke execute on function public.buy_chip_package(int) from public, anon;
grant execute on function public.buy_chip_package(int) to authenticated;

commit;
