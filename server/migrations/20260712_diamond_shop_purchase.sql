-- Online Kahvem - authenticated mock diamond package persistence (2026-07-12)
-- Temporary test-store bridge until Google Play receipt verification replaces it.
-- Run once in Supabase SQL Editor. Safe to rerun.

begin;

drop function if exists public.buy_diamond_package_mock(int);
create function public.buy_diamond_package_mock(p_package int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_diamond_delta int;
  v_chips bigint;
  v_diamonds int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'auth_required');
  end if;

  case p_package
    when 1 then v_diamond_delta := 10;
    when 2 then v_diamond_delta := 50;
    when 3 then v_diamond_delta := 150;
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

  v_diamonds := v_diamonds + v_diamond_delta;
  update public.profiles
     set diamonds = v_diamonds,
         updated_at = now()
   where id::text = v_uid::text;

  return jsonb_build_object(
    'ok', true, 'error', '',
    'diamonds_delta', v_diamond_delta,
    'chips', v_chips, 'diamonds', v_diamonds
  );
end;
$$;

revoke execute on function public.buy_diamond_package_mock(int) from public, anon;
grant execute on function public.buy_diamond_package_mock(int) to authenticated;

commit;
