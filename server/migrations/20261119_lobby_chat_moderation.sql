-- 19.11 TOPLULUK SOHBETİ MODERASYONU (build gerektirmez; oyun içi menü sonraki build'de)
--  1) Flood koruması: oyuncu mesajı kişi başı 5 sn'de 1, dakikada en fazla 8 (yönetici/sistem hariç).
--  2) Yönetici tek mesaj siler (admin_delete_lobby_message) + denetim kaydı.
--  3) Herkes bir mesajı şikâyet eder (report_lobby_message) → mevcut reports akışı (yönetici sitesi + bildirim).
--  4) Gürültü azaltma: bot giriş/çıkış satırı 30 sn → 3 dk aralık; gerçek oyuncu "geldi" saatlik tavanı 12 → 6.
begin;

-- ── 1) flood koruması ───────────────────────────────────────────────────────────
create or replace function public.lobby_chat_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_5s int; v_60s int;
begin
  if new.kind is distinct from 'msg' then return new; end if;                 -- sistem satırları serbest
  if public.is_current_user_admin() then return new; end if;             -- yönetici serbest
  select count(*) filter (where created_at > now() - interval '5 seconds'),
         count(*) filter (where created_at > now() - interval '60 seconds')
    into v_5s, v_60s
    from public.lobby_chat
   where user_id = new.user_id and kind = 'msg' and created_at > now() - interval '60 seconds';
  if v_5s >= 1 or v_60s >= 8 then
    raise exception 'chat_rate_limited' using errcode = 'P0001', hint = 'Çok hızlı yazıyorsun, biraz bekle.';
  end if;
  return new;
end;
$$;
revoke all on function public.lobby_chat_rate_limit() from public;
drop trigger if exists trg_lobby_chat_rate on public.lobby_chat;
create trigger trg_lobby_chat_rate
before insert on public.lobby_chat
for each row execute function public.lobby_chat_rate_limit();
create index if not exists lobby_chat_user_created_idx on public.lobby_chat (user_id, created_at desc);

-- ── 2) yönetici tek mesaj silme ────────────────────────────────────────────────
create table if not exists public.lobby_chat_mod_audit (
  id         bigint generated always as identity primary key,
  admin_user uuid not null,
  action     text not null,
  message_id bigint,
  user_id    uuid,
  name       text,
  text       text,
  created_at timestamptz not null default now()
);
alter table public.lobby_chat_mod_audit enable row level security;
revoke all on public.lobby_chat_mod_audit from public, anon, authenticated;

create or replace function public.admin_delete_lobby_message(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_admin uuid := auth.uid(); r record;
begin
  if v_admin is null or not public.is_current_user_admin() then
    return jsonb_build_object('ok', false, 'error', 'admin_required');
  end if;
  delete from public.lobby_chat where id = p_id returning id, user_id, name, text into r;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  insert into public.lobby_chat_mod_audit (admin_user, action, message_id, user_id, name, text)
    values (v_admin, 'delete', r.id, r.user_id, r.name, r.text);
  -- bu mesaja ait açık şikâyetler kapanır
  update public.reports set status = 'closed'
   where status = 'open' and context = 'lobby_chat:' || p_id::text;
  return jsonb_build_object('ok', true, 'id', r.id);
end;
$$;
revoke execute on function public.admin_delete_lobby_message(bigint) from public, anon;
grant execute on function public.admin_delete_lobby_message(bigint) to authenticated;

-- ── 3) mesaj şikâyeti (herkese açık) ───────────────────────────────────────────
create or replace function public.report_lobby_message(p_id bigint, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_me uuid := auth.uid(); m record; v_name text; v_reason text;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'auth_required'); end if;
  select id, user_id, name, text, kind into m from public.lobby_chat where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if m.kind <> 'msg' then return jsonb_build_object('ok', false, 'error', 'not_reportable'); end if;
  if m.user_id = v_me then return jsonb_build_object('ok', false, 'error', 'own_message'); end if;
  if exists (select 1 from public.reports where from_user = v_me and context = 'lobby_chat:' || p_id::text) then
    return jsonb_build_object('ok', true, 'dup', true);
  end if;
  if (select count(*) from public.reports where from_user = v_me and created_at > now() - interval '10 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'too_many_reports');
  end if;
  select coalesce(nullif(name, ''), 'Oyuncu') into v_name from public.profiles where id::text = v_me::text;
  v_reason := left(coalesce(nullif(btrim(p_reason), ''), 'Topluluk sohbeti mesajı'), 300);
  insert into public.reports (from_user, name, type, text, reported_user, reported_name, reported_text, context)
    values (v_me, coalesce(v_name, 'Oyuncu'), 'sikayet', 'Topluluk sohbeti: ' || v_reason,
            m.user_id, m.name, left(m.text, 300), 'lobby_chat:' || p_id::text);
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.report_lobby_message(bigint, text) from public, anon;
grant execute on function public.report_lobby_message(bigint, text) to authenticated;

-- ── 4) gürültü azaltma: gerçek oyuncu "geldi" saatlik tavanı 12 → 6 ────────────
create or replace function public.trg_presence_arrival_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  begin
    if new.user_id is null then return new; end if;
    if tg_op = 'UPDATE' and old.last_seen is not null and old.last_seen > now() - interval '45 minutes' then return new; end if;
    v_name := nullif(trim(coalesce(new.name, '')), '');
    if v_name is null or v_name ~* '^oyuncu[_-]' then return new; end if;
    if exists (select 1 from public.lobby_chat where kind = 'system' and event = 'arrival'
               and user_id::text = new.user_id::text and created_at > now() - interval '3 hours') then return new; end if;
    if (select count(*) from public.lobby_chat where kind = 'system' and event = 'arrival'
        and created_at > now() - interval '1 hour') >= 6 then return new; end if;
    perform public.lobby_post_system(new.user_id::uuid, v_name, '☕ ' || v_name || ' kahvehaneye geldi', 'arrival');
  exception when others then null;
  end;
  return new;
end $$;

commit;
notify pgrst, 'reload schema';
