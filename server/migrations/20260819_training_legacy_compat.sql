begin;

-- Temporary compatibility bridge for already-published clients that still call
-- grant_training_access(text,text) after a rewarded training ad. New clients use
-- begin_training_rewarded_ad + AdMob SSV + finalize_training_rewarded_ad.

create table if not exists public.training_legacy_access_grants (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  device_hash text not null,
  source text not null default 'legacy_rewarded',
  access_until timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists training_legacy_access_grants_user_created_idx
  on public.training_legacy_access_grants(user_id, created_at desc);

alter table public.training_legacy_access_grants enable row level security;
revoke all on public.training_legacy_access_grants from anon, authenticated;

create or replace function public.grant_training_access(
  p_device_hash text,
  p_source text default 'legacy_rewarded'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := auth.uid()::text;
  v_device text := trim(coalesce(p_device_hash, ''));
  v_existing_until timestamptz;
  v_until timestamptz;
  v_recent_count int := 0;
  v_remaining int := 0;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'auth_required', 'remaining_seconds', 0);
  end if;

  if length(v_device) < 16 then
    return jsonb_build_object('ok', false, 'error', 'device_required', 'remaining_seconds', 0);
  end if;

  if public.is_current_user_admin() or public.is_current_user_vip() then
    v_until := now() + interval '365 days';
    return jsonb_build_object(
      'ok', true,
      'legacy_compat', true,
      'credited', true,
      'access_until', floor(extract(epoch from v_until))::bigint,
      'remaining_seconds', greatest(0, floor(extract(epoch from (v_until - now())))::int)
    );
  end if;

  select access_until into v_existing_until
    from public.training_access_windows
   where user_id = v_uid;

  if v_existing_until is not null and v_existing_until > now() then
    v_remaining := greatest(0, floor(extract(epoch from (v_existing_until - now())))::int);
    return jsonb_build_object(
      'ok', true,
      'legacy_compat', true,
      'credited', false,
      'already_active', true,
      'access_until', floor(extract(epoch from v_existing_until))::bigint,
      'remaining_seconds', v_remaining
    );
  end if;

  select count(*) into v_recent_count
    from public.training_legacy_access_grants
   where user_id = v_uid
     and device_hash = v_device
     and created_at >= now() - interval '24 hours';

  if v_recent_count >= 5 then
    return jsonb_build_object('ok', false, 'error', 'legacy_daily_limit', 'remaining_seconds', 0);
  end if;

  v_until := now() + interval '2 hours';

  insert into public.training_access_windows(user_id, device_hash, access_until, source, updated_at)
  values (v_uid, v_device, v_until, 'legacy_rewarded', now())
  on conflict (user_id) do update
     set device_hash = excluded.device_hash,
         access_until = excluded.access_until,
         source = excluded.source,
         updated_at = now();

  insert into public.training_legacy_access_grants(user_id, device_hash, source, access_until)
  values (v_uid, v_device, left(coalesce(nullif(trim(p_source), ''), 'legacy_rewarded'), 64), v_until);

  v_remaining := greatest(0, floor(extract(epoch from (v_until - now())))::int);
  return jsonb_build_object(
    'ok', true,
    'legacy_compat', true,
    'credited', true,
    'access_until', floor(extract(epoch from v_until))::bigint,
    'remaining_seconds', v_remaining
  );
end;
$$;

revoke execute on function public.grant_training_access(text, text) from public, anon;
grant execute on function public.grant_training_access(text, text) to authenticated;

commit;
