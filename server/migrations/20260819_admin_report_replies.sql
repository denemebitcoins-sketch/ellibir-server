begin;

alter table public.direct_messages add column if not exists kind text not null default 'msg';
alter table public.direct_messages add column if not exists system_sender_name text;
alter table public.direct_messages add column if not exists reply_locked boolean not null default false;
alter table public.direct_messages add column if not exists report_id bigint;
alter table public.direct_messages add column if not exists report_type text;
alter table public.direct_messages add column if not exists report_excerpt text;

create index if not exists direct_messages_admin_reply_to_idx
  on public.direct_messages(to_user, created_at desc)
  where kind = 'admin_reply';

create or replace function public.direct_messages_enforce_daily_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := 25;
  v_day date := (now() at time zone 'Europe/Istanbul')::date;
  v_count integer := 0;
begin
  if coalesce(new.kind, 'msg') = 'admin_reply' and public.is_current_user_admin() then
    new.reply_locked := true;
    new.system_sender_name := coalesce(nullif(trim(new.system_sender_name), ''), 'OK - Yönetim');
    return new;
  end if;

  new.kind := 'msg';
  new.system_sender_name := null;
  new.reply_locked := false;
  new.report_id := null;
  new.report_type := null;
  new.report_excerpt := null;

  if auth.uid() is null or new.from_user <> auth.uid() then
    raise exception 'dm_auth_required';
  end if;

  v_limit := public.direct_message_daily_limit();

  select coalesce(sent_count, 0)
    into v_count
    from public.direct_message_daily_usage
   where user_id = new.from_user
     and usage_day = v_day
   for update;

  if coalesce(v_count, 0) >= v_limit then
    raise exception 'dm_daily_limit:%', v_limit;
  end if;

  insert into public.direct_message_daily_usage(user_id, usage_day, sent_count)
  values (new.from_user, v_day, 1)
  on conflict (user_id, usage_day)
  do update set sent_count = public.direct_message_daily_usage.sent_count + 1;

  return new;
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

  if coalesce(new.kind, 'msg') = 'admin_reply' then
    insert into public.push_outbox(user_id, kind, title, body, data)
    values (
      new.to_user,
      'dm',
      'Online Kahvem',
      'OK - Yönetim sana cevap gönderdi.',
      jsonb_build_object('type', 'dm', 'from_user', new.from_user::text, 'system', true)
    );
    return new;
  end if;

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

create or replace function public.admin_reply_to_report(
  p_report_id bigint,
  p_reply text,
  p_close_report boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin uuid := auth.uid();
  v_report public.reports%rowtype;
  v_sender uuid;
  v_reply text := trim(coalesce(p_reply, ''));
  v_type text;
  v_excerpt text;
  v_body text;
  v_message_id bigint;
begin
  if v_admin is null or not public.is_current_user_admin() then
    return jsonb_build_object('ok', false, 'error', 'admin_required');
  end if;
  if p_report_id is null or p_report_id <= 0 then
    return jsonb_build_object('ok', false, 'error', 'report_required');
  end if;
  if length(v_reply) < 2 then
    return jsonb_build_object('ok', false, 'error', 'reply_required');
  end if;
  if length(v_reply) > 900 then
    v_reply := left(v_reply, 900);
  end if;

  select * into v_report
    from public.reports
   where id = p_report_id
   for update;
  if not found or v_report.from_user is null then
    return jsonb_build_object('ok', false, 'error', 'report_not_found');
  end if;

  select dm.from_user into v_sender
    from public.direct_messages dm
   where dm.to_user = v_report.from_user
     and dm.kind = 'admin_reply'
   order by dm.created_at asc
   limit 1;
  v_sender := coalesce(v_sender, v_admin);

  v_type := upper(coalesce(nullif(trim(v_report.type), ''), 'BILDIRIM'));
  v_excerpt := replace(coalesce(v_report.text, ''), E'\r', ' ');
  v_excerpt := replace(v_excerpt, E'\n', ' ');
  v_excerpt := trim(v_excerpt);
  if length(v_excerpt) > 180 then
    v_excerpt := left(v_excerpt, 177) || '...';
  end if;

  v_body := 'Bildirim türü: ' || v_type || E'\n'
         || 'Orijinal içerik: ' || coalesce(nullif(v_excerpt, ''), '-') || E'\n\n'
         || 'OK - Yönetim: ' || v_reply;

  insert into public.direct_messages(
    from_user, to_user, text, read, kind, system_sender_name,
    reply_locked, report_id, report_type, report_excerpt
  )
  values (
    v_sender, v_report.from_user, left(v_body, 500), false, 'admin_reply',
    'OK - Yönetim', true, p_report_id, v_report.type, v_excerpt
  )
  returning id into v_message_id;

  if coalesce(p_close_report, true) then
    update public.reports
       set status = 'closed'
     where id = p_report_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'message_id', v_message_id,
    'sender', v_sender::text,
    'closed', coalesce(p_close_report, true)
  );
end;
$$;

revoke execute on function public.admin_reply_to_report(bigint, text, boolean) from public, anon, authenticated;
grant execute on function public.admin_reply_to_report(bigint, text, boolean) to authenticated;

commit;
