-- Online Kahvem — ön kayıt (talep toplama) + günlük ödül push hatırlatması
-- 2026-07-26
--
-- 1) game_interest: yaklaşan oyunlarla (bilardo/ihale/maça kızı) ilgilenen kullanıcılar.
-- 2) set_game_interest / my_game_interests RPC'leri (kullanıcı kendi kaydını yönetir).
-- 3) enqueue_daily_reminders: bugün ödülünü almamış + push cihazı açık kullanıcılara
--    push_outbox'a 'daily_reminder' bildirimi kuyruklar (pushWorker gönderir).

begin;

/* ── 1) ÖN KAYIT tablosu ── */
create table if not exists public.game_interest (
  user_id uuid not null references auth.users(id) on delete cascade,
  game text not null check (game in ('bilardo', 'ihale', 'macakizi')),
  created_at timestamptz not null default now(),
  primary key (user_id, game)
);

alter table public.game_interest enable row level security;

drop policy if exists game_interest_own_select on public.game_interest;
create policy game_interest_own_select on public.game_interest
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists game_interest_own_insert on public.game_interest;
create policy game_interest_own_insert on public.game_interest
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists game_interest_own_delete on public.game_interest;
create policy game_interest_own_delete on public.game_interest
  for delete to authenticated using (auth.uid() = user_id);

/* ── 2) İlgi toggle + liste RPC'leri ── */
create or replace function public.set_game_interest(p_game text, p_interested boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'auth_required'); end if;
  if p_game not in ('bilardo', 'ihale', 'macakizi') then
    return jsonb_build_object('ok', false, 'error', 'invalid_game');
  end if;

  if p_interested then
    insert into public.game_interest(user_id, game) values (v_uid, p_game)
    on conflict (user_id, game) do nothing;
  else
    delete from public.game_interest where user_id = v_uid and game = p_game;
  end if;

  return jsonb_build_object('ok', true, 'interested', p_interested);
end;
$$;
revoke all on function public.set_game_interest(text, boolean) from public;
grant execute on function public.set_game_interest(text, boolean) to authenticated;

create or replace function public.my_game_interests()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'auth_required'); end if;
  return jsonb_build_object(
    'ok', true,
    'games', coalesce(
      (select jsonb_agg(g.game) from public.game_interest g where g.user_id = v_uid),
      '[]'::jsonb));
end;
$$;
revoke all on function public.my_game_interests() from public;
grant execute on function public.my_game_interests() to authenticated;

/* ── 3) GÜNLÜK PUSH HATIRLATMASI ──
   profiles.id TEXT tutuluyor (canlı şema) — push_devices/push_outbox uuid bekler, cast edilir.
   Günlük tekrar koruması: aynı gün aynı kullanıcıya ikinci 'daily_reminder' yazılmaz. */
create or replace function public.enqueue_daily_reminders()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_week text := to_char(now(), 'IYYY-IW');
  v_dow  int  := extract(isodow from now())::int;
  v_count int := 0;
begin
  insert into public.push_outbox(user_id, kind, title, body, data)
  select p.id::uuid,
         'system',
         'Günlük ödülün hazır!',
         coalesce(nullif(trim(p.name), ''), 'Oyuncu') ||
           ', bugünkü günlük çip ödülün seni bekliyor. Kap gel!',
         jsonb_build_object('type', 'daily_reminder')
  from public.profiles p
  where exists (
      select 1 from public.push_devices d
      where d.user_id = p.id::uuid and d.enabled)
    and (
      p.daily_claim_week is distinct from v_week
      or (coalesce(p.daily_claim_mask, 0) & (1 << (v_dow - 1))) = 0)
    and not exists (
      select 1 from public.push_outbox o
      where o.user_id = p.id::uuid
        and o.kind = 'system'
        and o.data->>'type' = 'daily_reminder'
        and o.created_at >= date_trunc('day', now()));

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.enqueue_daily_reminders() from public;

commit;
