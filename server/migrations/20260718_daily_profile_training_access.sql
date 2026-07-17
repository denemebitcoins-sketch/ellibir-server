-- Online Kahvem - beta daily reward + profile visibility + training access
-- Safe to run after 20260716/20260717 beta/social migrations.

begin;

-- Daily rewards are visible during beta; claiming must also be open.
insert into public.app_feature_flags(key, enabled)
values ('daily', true)
on conflict (key) do update set enabled = excluded.enabled;

-- Profile social access:
-- - self and admin can always view
-- - target admin is visible only to admins/self/accepted friends
-- - open is visible to everyone
-- - friends is visible to accepted friends
-- - hidden is visible only to self/admin
create or replace function public.can_view_profile_social(p_target text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and p_target is not null
     and (
       p_target = auth.uid()::text
       or public.is_current_user_admin()
       or (
         exists (
           select 1 from public.friendships f
            where f.status = 'accepted'
              and ((f.requester::text = auth.uid()::text and f.addressee::text = p_target)
                or (f.addressee::text = auth.uid()::text and f.requester::text = p_target))
         )
         and (
           exists (
             select 1 from public.profiles p
              where p.id::text = p_target
                and coalesce(p.role, 'normal') = 'admin'
           )
           or exists (
             select 1 from public.profiles p
              where p.id::text = p_target
                and coalesce(p.profile_visibility, 'open') in ('open', 'friends')
           )
         )
       )
       or exists (
         select 1 from public.profiles p
          where p.id::text = p_target
            and coalesce(p.role, 'normal') <> 'admin'
            and coalesce(p.profile_visibility, 'open') = 'open'
       )
     );
$$;

revoke execute on function public.can_view_profile_social(text) from public, anon;
grant execute on function public.can_view_profile_social(text) to authenticated;

create table if not exists public.training_access_windows (
  user_id text primary key,
  device_hash text,
  access_until timestamptz not null,
  source text not null default 'ad',
  updated_at timestamptz not null default now()
);

alter table public.training_access_windows enable row level security;
revoke all on public.training_access_windows from anon, authenticated;

drop policy if exists training_access_select_own on public.training_access_windows;
create policy training_access_select_own on public.training_access_windows
for select to authenticated
using (user_id = auth.uid()::text);

create or replace function public.get_training_access_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := auth.uid()::text;
  v_until timestamptz;
  v_remaining int := 0;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'auth_required', 'access_until', 0, 'remaining_seconds', 0);
  end if;

  if public.is_current_user_admin() or public.is_current_user_vip() then
    v_until := now() + interval '365 days';
  else
    select access_until into v_until
      from public.training_access_windows
     where user_id = v_uid;
  end if;

  if v_until is not null then
    v_remaining := greatest(0, floor(extract(epoch from (v_until - now())))::int);
  end if;

  return jsonb_build_object(
    'ok', true,
    'access_until', coalesce(floor(extract(epoch from v_until))::bigint, 0),
    'remaining_seconds', v_remaining
  );
end;
$$;

create or replace function public.grant_training_access(p_device_hash text, p_source text default 'ad')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := auth.uid()::text;
  v_until timestamptz;
  v_remaining int;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'auth_required', 'access_until', 0, 'remaining_seconds', 0);
  end if;

  if public.is_current_user_admin() or public.is_current_user_vip() then
    v_until := now() + interval '365 days';
  else
    v_until := now() + interval '2 hours';
    insert into public.training_access_windows(user_id, device_hash, access_until, source, updated_at)
    values (v_uid, nullif(trim(p_device_hash), ''), v_until, left(coalesce(p_source, 'ad'), 32), now())
    on conflict (user_id) do update
       set device_hash = excluded.device_hash,
           access_until = excluded.access_until,
           source = excluded.source,
           updated_at = now();
  end if;

  v_remaining := greatest(0, floor(extract(epoch from (v_until - now())))::int);
  return jsonb_build_object(
    'ok', true,
    'access_until', floor(extract(epoch from v_until))::bigint,
    'remaining_seconds', v_remaining
  );
end;
$$;

revoke execute on function public.get_training_access_state() from public, anon;
revoke execute on function public.grant_training_access(text, text) from public, anon;
grant execute on function public.get_training_access_state() to authenticated;
grant execute on function public.grant_training_access(text, text) to authenticated;

commit;
