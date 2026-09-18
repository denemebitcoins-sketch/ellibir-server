begin;
alter table public.profiles add column if not exists honorary_title text not null default ''
  check (honorary_title in ('','pioneer'));

create or replace function public.guard_honorary_title()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if (tg_op='INSERT' and new.honorary_title<>'') or
     (tg_op='UPDATE' and new.honorary_title is distinct from old.honorary_title) then
    if coalesce(auth.role(),'')<>'service_role' and not coalesce(public.is_current_user_admin(),false) then
      raise exception 'admin_required' using errcode='42501';
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists guard_honorary_title on public.profiles;
create trigger guard_honorary_title before insert or update on public.profiles
  for each row execute function public.guard_honorary_title();
revoke all on function public.guard_honorary_title() from public,anon,authenticated;

create or replace function public.admin_set_honorary_title(p_user text,p_title text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not coalesce(public.is_current_user_admin(),false) then
    return jsonb_build_object('ok',false,'error','admin_required');
  end if;
  if p_title is null or p_title not in ('','pioneer') then
    return jsonb_build_object('ok',false,'error','invalid_title');
  end if;
  update public.profiles set honorary_title=p_title where id::text=p_user;
  if not found then return jsonb_build_object('ok',false,'error','profile_not_found'); end if;
  return jsonb_build_object('ok',true,'honorary_title',p_title);
end; $$;
revoke all on function public.admin_set_honorary_title(text,text) from public,anon;
grant execute on function public.admin_set_honorary_title(text,text) to authenticated;

-- One transaction prevents token registration from silently re-enabling a disabled device.
create or replace function public.sync_push_device(p_token text,p_platform text,p_device_hash text,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
  if auth.uid() is null then return jsonb_build_object('ok',false,'error','auth_required'); end if;
  if p_enabled is null or p_device_hash is null or p_device_hash !~ '^[0-9a-f]{64}$'
     or p_platform is null or p_platform not in ('android','ios') then
    return jsonb_build_object('ok',false,'error','device_invalid');
  end if;
  if p_enabled then
    result := public.register_push_device(p_token,p_platform,p_device_hash);
    if not coalesce((result->>'ok')::boolean,false) then return result; end if;
  end if;
  update public.push_devices set enabled=p_enabled,last_seen_at=now()
    where user_id=auth.uid() and device_hash=p_device_hash and platform=p_platform;
  return jsonb_build_object('ok',true);
end; $$;
revoke all on function public.sync_push_device(text,text,text,boolean) from public,anon;
grant execute on function public.sync_push_device(text,text,text,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
