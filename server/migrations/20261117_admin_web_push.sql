-- Yönetim web sayfası (online-kahvem.web.app/masa-…) için web push bildirimleri.
-- Yeni rapor → admin_web_push_outbox → sunucu (src/adminWebPush.ts) → sayfada bildirimi açmış yöneticilerin tarayıcıları.
-- Oyun push sistemine (push_outbox / push_devices) DOKUNMAZ.

create table if not exists public.server_secrets (
  key text primary key,
  value jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.server_secrets enable row level security;   -- politika yok → yalnız service role

create table if not exists public.admin_web_push_subs (
  endpoint text primary key,
  user_id uuid not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  fail_count int not null default 0
);
alter table public.admin_web_push_subs enable row level security;

create table if not exists public.admin_web_push_outbox (
  id bigserial primary key,
  title text not null,
  body text not null,
  url text,
  extra int not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
alter table public.admin_web_push_outbox enable row level security;
create index if not exists admin_web_push_outbox_unsent on public.admin_web_push_outbox (id) where sent_at is null;

create or replace function public.is_admin_user(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = p_uid and lower(coalesce(role, '')) in ('admin', 'admin_hidden'));
$$;

create or replace function public.admin_web_push_public_key() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  if not public.is_admin_user(auth.uid()) then return jsonb_build_object('ok', false, 'error', 'admin_required'); end if;
  select value->>'publicKey' into v from public.server_secrets where key = 'admin_web_push_vapid';
  if v is null then return jsonb_build_object('ok', false, 'error', 'not_ready'); end if;
  return jsonb_build_object('ok', true, 'public_key', v);
end $$;

create or replace function public.admin_web_push_subscribe(p_endpoint text, p_p256dh text, p_auth text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_user(auth.uid()) then return jsonb_build_object('ok', false, 'error', 'admin_required'); end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 1000
     or coalesce(length(p_p256dh), 0) not between 80 and 100 or coalesce(length(p_auth), 0) not between 16 and 30 then
    return jsonb_build_object('ok', false, 'error', 'subscription_invalid');
  end if;
  insert into public.admin_web_push_subs (endpoint, user_id, p256dh, auth)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, fail_count = 0;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_web_push_unsubscribe(p_endpoint text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth_required'); end if;
  delete from public.admin_web_push_subs where endpoint = p_endpoint and user_id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_web_push_status(p_endpoint text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin_user(auth.uid()) then return jsonb_build_object('ok', false, 'error', 'admin_required'); end if;
  return jsonb_build_object('ok', true, 'subscribed',
    exists (select 1 from public.admin_web_push_subs where endpoint = p_endpoint and user_id = auth.uid()),
    'total', (select count(*) from public.admin_web_push_subs));
end $$;

revoke all on function public.admin_web_push_public_key() from public;
revoke all on function public.admin_web_push_subscribe(text, text, text) from public;
revoke all on function public.admin_web_push_unsubscribe(text) from public;
revoke all on function public.admin_web_push_status(text) from public;
grant execute on function public.admin_web_push_public_key() to authenticated;
grant execute on function public.admin_web_push_subscribe(text, text, text) to authenticated;
grant execute on function public.admin_web_push_unsubscribe(text) to authenticated;
grant execute on function public.admin_web_push_status(text) to authenticated;

-- Yeni rapor → kuyruk. 60 sn içinde gönderilmemiş bir bildirim varsa yenisi açılmaz, sayaç artar.
-- Hata olursa rapor kaydı ASLA engellenmez.
create or replace function public.trg_reports_admin_web_push() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_title text; v_body text; v_recent bigint;
begin
  begin
    v_title := case new.type
      when 'sikayet' then 'Yeni şikayet'
      when 'istek' then 'Yeni istek'
      when 'oneri' then 'Yeni öneri'
      when 'bug' then 'Yeni hata bildirimi'
      when 'baglanti' then 'Giriş yapamayan oyuncu'
      else 'Yeni rapor' end;
    v_body := coalesce(nullif(trim(new.name), ''), 'Oyuncu') || ': ' || left(regexp_replace(coalesce(new.text, ''), '\s+', ' ', 'g'), 120);
    select id into v_recent from public.admin_web_push_outbox
      where sent_at is null and created_at > now() - interval '60 seconds' order by id desc limit 1;
    if v_recent is not null then
      update public.admin_web_push_outbox set extra = extra + 1 where id = v_recent;
    else
      insert into public.admin_web_push_outbox (title, body) values (v_title, v_body);
    end if;
  exception when others then null;
  end;
  return new;
end $$;

drop trigger if exists reports_admin_web_push on public.reports;
create trigger reports_admin_web_push after insert on public.reports
  for each row execute function public.trg_reports_admin_web_push();
