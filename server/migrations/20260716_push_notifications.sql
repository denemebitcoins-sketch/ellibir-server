-- Online Kahvem device push registry + transactional outbox.
-- Client token registration is authenticated. Sending/claiming is service-role only.

begin;

create table if not exists public.push_devices (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null unique,
  platform text not null check (platform in ('android', 'ios')),
  device_hash text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique(user_id, device_hash, platform)
);
create index if not exists push_devices_user_idx
  on public.push_devices(user_id) where enabled;
alter table public.push_devices enable row level security;
revoke all on public.push_devices from public, anon, authenticated;

create table if not exists public.push_outbox (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('dm', 'system')),
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists push_outbox_pending_idx
  on public.push_outbox(next_attempt_at, id)
  where status in ('pending', 'failed');
alter table public.push_outbox enable row level security;
revoke all on public.push_outbox from public, anon, authenticated;

create or replace function public.register_push_device(
  p_token text,
  p_platform text,
  p_device_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'auth_required'); end if;
  if coalesce(length(trim(p_token)), 0) < 32 then
    return jsonb_build_object('ok', false, 'error', 'token_invalid');
  end if;
  if p_platform not in ('android', 'ios') then
    return jsonb_build_object('ok', false, 'error', 'platform_invalid');
  end if;
  if p_device_hash is null or p_device_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'device_invalid');
  end if;

  -- An FCM/APNs token belongs to its latest authenticated account. The secondary
  -- device key prevents one account accumulating stale rotations for one install.
  delete from public.push_devices
   where user_id = v_uid and device_hash = p_device_hash and platform = p_platform
     and token <> trim(p_token);
  insert into public.push_devices(user_id, token, platform, device_hash)
  values (v_uid, trim(p_token), p_platform, p_device_hash)
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        device_hash = excluded.device_hash,
        enabled = true,
        last_seen_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.queue_dm_push()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_name text;
begin
  if new.to_user = new.from_user then return new; end if;
  if not exists (
    select 1 from public.push_devices d where d.user_id = new.to_user and d.enabled
  ) then return new; end if;
  select nullif(trim(p.name), '') into v_name from public.profiles p
   where p.id::text = new.from_user::text;
  insert into public.push_outbox(user_id, kind, title, body, data)
  values (
    new.to_user,
    'dm',
    'Online Kahvem',
    coalesce(v_name, 'Bir oyuncu') || ' sana mesaj gönderdi.',
    jsonb_build_object('type', 'dm', 'from_user', new.from_user::text)
  );
  return new;
end;
$$;
revoke all on function public.queue_dm_push() from public;
drop trigger if exists queue_dm_push_trg on public.direct_messages;
create trigger queue_dm_push_trg
after insert on public.direct_messages
for each row execute function public.queue_dm_push();

create or replace function public.claim_push_outbox(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_rows jsonb;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  with picked as (
    select id from public.push_outbox
     where status in ('pending', 'failed')
       and attempts < 5 and next_attempt_at <= now()
     order by id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 25), 100))
  ), claimed as (
    update public.push_outbox o
       set status = 'processing', attempts = attempts + 1, claimed_at = now()
      from picked where o.id = picked.id
    returning o.id, o.user_id, o.kind, o.title, o.body, o.data, o.attempts
  )
  select coalesce(jsonb_agg(to_jsonb(claimed)), '[]'::jsonb) into v_rows from claimed;
  return v_rows;
end;
$$;

create or replace function public.finish_push_outbox(
  p_id bigint,
  p_success boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  update public.push_outbox
     set status = case when p_success then 'sent' else 'failed' end,
         sent_at = case when p_success then now() else null end,
         last_error = left(coalesce(p_error, ''), 500),
         next_attempt_at = case when p_success then next_attempt_at
                                else now() + make_interval(secs => least(3600, 30 * attempts * attempts)) end
   where id = p_id and status = 'processing';
end;
$$;

create or replace function public.disable_push_token(p_token text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  update public.push_devices set enabled = false where token = p_token;
end;
$$;

create or replace function public.enqueue_system_push(
  p_title text,
  p_body text,
  p_data jsonb default '{}'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  insert into public.push_outbox(user_id, kind, title, body, data)
  select distinct d.user_id, 'system', left(trim(p_title), 80), left(trim(p_body), 180), coalesce(p_data, '{}'::jsonb)
    from public.push_devices d where d.enabled
     and coalesce(length(trim(p_title)), 0) > 0 and coalesce(length(trim(p_body)), 0) > 0;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.register_push_device(text, text, text) from public, anon;
grant execute on function public.register_push_device(text, text, text) to authenticated;
revoke all on function public.claim_push_outbox(integer) from public, anon, authenticated;
revoke all on function public.finish_push_outbox(bigint, boolean, text) from public, anon, authenticated;
revoke all on function public.disable_push_token(text) from public, anon, authenticated;
revoke all on function public.enqueue_system_push(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_push_outbox(integer) to service_role;
grant execute on function public.finish_push_outbox(bigint, boolean, text) to service_role;
grant execute on function public.disable_push_token(text) to service_role;
grant execute on function public.enqueue_system_push(text, text, jsonb) to service_role;

commit;
