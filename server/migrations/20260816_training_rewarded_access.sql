begin;

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
set search_path = public, pg_temp
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

create table if not exists public.training_rewarded_ad_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_hash text not null,
  status text not null default 'pending'
    check (status in ('pending', 'credited', 'expired', 'rejected')),
  transaction_id text unique,
  ad_unit text,
  reward_item text,
  reward_amount numeric,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '20 minutes'),
  rewarded_at timestamptz
);

create index if not exists training_rewarded_ad_sessions_user_created_idx
  on public.training_rewarded_ad_sessions(user_id, created_at desc);

alter table public.training_rewarded_ad_sessions enable row level security;
revoke all on public.training_rewarded_ad_sessions from anon, authenticated;

create or replace function public.begin_training_rewarded_ad(p_device_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_existing_until timestamptz;
  v_session uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'auth_required');
  end if;
  if coalesce(length(trim(p_device_hash)), 0) < 16 then
    return jsonb_build_object('ok', false, 'error', 'device_required');
  end if;

  if public.is_current_user_admin() or public.is_current_user_vip() then
    return jsonb_build_object('ok', false, 'error', 'exempt');
  end if;

  select access_until into v_existing_until
    from public.training_access_windows
   where user_id = v_uid::text;
  if v_existing_until is not null and v_existing_until > now() then
    return jsonb_build_object(
      'ok', false,
      'error', 'active',
      'access_until', floor(extract(epoch from v_existing_until))::bigint,
      'remaining_seconds', greatest(0, floor(extract(epoch from (v_existing_until - now())))::int)
    );
  end if;

  update public.training_rewarded_ad_sessions
     set status = 'expired'
   where user_id = v_uid and status = 'pending' and expires_at <= now();

  insert into public.training_rewarded_ad_sessions(user_id, device_hash)
  values (v_uid, trim(p_device_hash))
  returning id into v_session;

  return jsonb_build_object(
    'ok', true,
    'session_id', v_session::text,
    'custom_data', v_session::text,
    'status', 'pending',
    'credited', false
  );
end;
$$;

create or replace function public.get_training_rewarded_ad_state(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_until timestamptz;
  v_remaining int := 0;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'auth_required', 'remaining_seconds', 0);
  end if;

  select status into v_status
    from public.training_rewarded_ad_sessions
   where id = p_session_id and user_id = v_uid;
  if v_status is null then
    return jsonb_build_object('ok', false, 'error', 'session_not_found', 'remaining_seconds', 0);
  end if;

  select access_until into v_until
    from public.training_access_windows
   where user_id = v_uid::text;
  if v_until is not null then
    v_remaining := greatest(0, floor(extract(epoch from (v_until - now())))::int);
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', v_status,
    'credited', v_status = 'credited',
    'access_until', coalesce(floor(extract(epoch from v_until))::bigint, 0),
    'remaining_seconds', v_remaining
  );
end;
$$;

create or replace function public.finalize_training_rewarded_ad(
  p_session_id uuid,
  p_transaction_id text,
  p_ad_unit text,
  p_reward_item text,
  p_reward_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.training_rewarded_ad_sessions%rowtype;
  v_until timestamptz;
  v_remaining int;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if coalesce(trim(p_transaction_id), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'transaction_required');
  end if;

  select * into v_row
    from public.training_rewarded_ad_sessions
   where id = p_session_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'session_not_found');
  end if;

  if v_row.status = 'credited' then
    select access_until into v_until
      from public.training_access_windows
     where user_id = v_row.user_id::text;
    v_remaining := greatest(0, floor(extract(epoch from (v_until - now())))::int);
    return jsonb_build_object('ok', true, 'duplicate', true, 'credited', true,
      'access_until', floor(extract(epoch from v_until))::bigint,
      'remaining_seconds', v_remaining);
  end if;

  if v_row.status <> 'pending' or v_row.expires_at <= now() then
    update public.training_rewarded_ad_sessions set status = 'expired' where id = p_session_id;
    return jsonb_build_object('ok', false, 'error', 'session_expired');
  end if;
  if exists(select 1 from public.training_rewarded_ad_sessions where transaction_id = p_transaction_id) then
    return jsonb_build_object('ok', false, 'error', 'transaction_reused');
  end if;

  v_until := now() + interval '2 hours';
  insert into public.training_access_windows(user_id, device_hash, access_until, source, updated_at)
  values (v_row.user_id::text, v_row.device_hash, v_until, 'rewarded', now())
  on conflict (user_id) do update
     set device_hash = excluded.device_hash,
         access_until = excluded.access_until,
         source = excluded.source,
         updated_at = now();

  update public.training_rewarded_ad_sessions
     set status = 'credited',
         transaction_id = p_transaction_id,
         ad_unit = p_ad_unit,
         reward_item = p_reward_item,
         reward_amount = p_reward_amount,
         rewarded_at = now()
   where id = p_session_id;

  v_remaining := greatest(0, floor(extract(epoch from (v_until - now())))::int);
  return jsonb_build_object('ok', true, 'credited', true,
    'access_until', floor(extract(epoch from v_until))::bigint,
    'remaining_seconds', v_remaining);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'transaction_reused');
end;
$$;

do $$
begin
  if to_regprocedure('public.grant_training_access(text,text)') is not null then
    revoke execute on function public.grant_training_access(text, text) from public, anon, authenticated;
  end if;
end $$;

revoke execute on function public.get_training_access_state() from public, anon;
revoke execute on function public.begin_training_rewarded_ad(text) from public, anon;
revoke execute on function public.get_training_rewarded_ad_state(uuid) from public, anon;
revoke execute on function public.finalize_training_rewarded_ad(uuid, text, text, text, numeric) from public, anon, authenticated;
grant execute on function public.get_training_access_state() to authenticated;
grant execute on function public.begin_training_rewarded_ad(text) to authenticated;
grant execute on function public.get_training_rewarded_ad_state(uuid) to authenticated;
grant execute on function public.finalize_training_rewarded_ad(uuid, text, text, text, numeric) to service_role;

commit;
