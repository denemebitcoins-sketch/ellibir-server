-- Online Kahvem - moderator role core (2026-08-20)

do $$
declare
  r record;
begin
  if to_regclass('public.profiles') is not null then
    for r in
      select conname
        from pg_constraint
       where conrelid = 'public.profiles'::regclass
         and contype = 'c'
         and pg_get_constraintdef(oid) ilike '%role%'
    loop
      execute format('alter table public.profiles drop constraint %I', r.conname);
    end loop;

    alter table public.profiles
      add constraint profiles_role_values_check
      check (role in ('normal', 'vip', 'moderator', 'admin'));
  end if;

  if to_regclass('public.presence') is not null then
    for r in
      select conname
        from pg_constraint
       where conrelid = 'public.presence'::regclass
         and contype = 'c'
         and pg_get_constraintdef(oid) ilike '%role%'
    loop
      execute format('alter table public.presence drop constraint %I', r.conname);
    end loop;

    alter table public.presence
      add constraint presence_role_values_check
      check (role in ('normal', 'vip', 'moderator', 'admin', 'admin_hidden'));
  end if;
end $$;

create or replace function public.is_current_user_vip()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.profiles p
     where p.id::text = auth.uid()::text
       and (
            coalesce(p.role, 'normal') in ('admin', 'moderator')
         or (p.vip_until is not null and p.vip_until > now())
       )
  );
$$;

create or replace function public.admin_set_profile_role(p_user text, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid := auth.uid();
  v_user uuid;
  v_role text := lower(trim(coalesce(p_role, '')));
begin
  if v_admin is null or not public.is_current_user_admin() then
    return jsonb_build_object('ok', false, 'error', 'admin_required');
  end if;

  begin
    v_user := p_user::uuid;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'invalid_user');
  end;

  if v_role not in ('normal', 'vip', 'moderator', 'admin') then
    return jsonb_build_object('ok', false, 'error', 'invalid_role');
  end if;

  if v_user = v_admin and v_role <> 'admin' then
    return jsonb_build_object('ok', false, 'error', 'cannot_demote_self');
  end if;

  if not exists (select 1 from public.profiles where id::text = v_user::text) then
    return jsonb_build_object('ok', false, 'error', 'profile_not_found');
  end if;

  update public.profiles
     set role = v_role
   where id::text = v_user::text;

  update public.presence
     set role = v_role
   where user_id::text = v_user::text;

  return jsonb_build_object('ok', true, 'role', v_role);
end;
$$;

revoke execute on function public.is_current_user_vip() from public, anon;
grant execute on function public.is_current_user_vip() to authenticated;

revoke execute on function public.admin_set_profile_role(text, text) from public, anon, authenticated;
grant execute on function public.admin_set_profile_role(text, text) to authenticated;
