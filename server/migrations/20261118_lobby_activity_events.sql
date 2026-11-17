-- 6.8 Topluluk sohbeti: gerçek olaylardan sistem satırları (lobby_chat.kind = 'system').
--  • "☕ X kahvehaneye geldi": oyuncu ≥45 dk aradan sonra ilk kez çevrimiçi olunca (presence tetikleyicisi).
--      Kişi başı 3 saatte bir, toplamda saatte en fazla 12 satır.
--  • "🏆 X 101'de 25.000 çip kazandı": sunucu maç ödemesinde net kazanç ≥ 10.000 ise (lobby_win_event RPC).
--      Kişi başı 30 dakikada bir, toplamda saatte en fazla 8 satır.
-- Hata olursa asıl işlem (heartbeat / ödeme) ASLA engellenmez.

create or replace function public.lobby_post_system(p_user uuid, p_name text, p_text text, p_event text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.lobby_chat (user_id, name, role, text, kind, event)
  values (p_user, coalesce(nullif(p_name, ''), 'Oyuncu'), 'normal', left(p_text, 300), 'system', p_event);
end $$;
revoke all on function public.lobby_post_system(uuid, text, text, text) from public, anon, authenticated;

create or replace function public.trg_presence_arrival_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  begin
    if new.user_id is null then return new; end if;
    if tg_op = 'UPDATE' and old.last_seen is not null and old.last_seen > now() - interval '45 minutes' then return new; end if;
    v_name := nullif(trim(coalesce(new.name, '')), '');
    if v_name is null or v_name ~* '^oyuncu[_-]' then return new; end if;              -- henüz adını seçmemiş
    if exists (select 1 from public.lobby_chat where kind = 'system' and event = 'arrival'
               and user_id::text = new.user_id::text and created_at > now() - interval '3 hours') then return new; end if;
    if (select count(*) from public.lobby_chat where kind = 'system' and event = 'arrival'
        and created_at > now() - interval '1 hour') >= 12 then return new; end if;
    perform public.lobby_post_system(new.user_id::uuid, v_name, '☕ ' || v_name || ' kahvehaneye geldi', 'arrival');
  exception when others then null;
  end;
  return new;
end $$;

drop trigger if exists presence_arrival_event on public.presence;
create trigger presence_arrival_event after insert or update on public.presence
  for each row execute function public.trg_presence_arrival_event();

create or replace function public.lobby_win_event(p_user uuid, p_game text, p_amount bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_name text; v_game text; v_amt text;
begin
  if p_user is null or coalesce(p_amount, 0) < 10000 then return jsonb_build_object('ok', false, 'error', 'below_threshold'); end if;
  select nullif(trim(name), '') into v_name from public.profiles where id::text = p_user::text;
  if v_name is null then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;
  if exists (select 1 from public.lobby_chat where kind = 'system' and event = 'big_win'
             and user_id::text = p_user::text and created_at > now() - interval '30 minutes') then
    return jsonb_build_object('ok', false, 'error', 'cooldown'); end if;
  if (select count(*) from public.lobby_chat where kind = 'system' and event = 'big_win'
      and created_at > now() - interval '1 hour') >= 8 then return jsonb_build_object('ok', false, 'error', 'global_cap'); end if;
  v_game := case lower(coalesce(p_game, ''))
    when 'yuzbir' then '101''de' when 'banko' then 'Bankolu Okey''de' when 'duz' then 'Okey''de' when 'okey' then 'Okey''de'
    when '51' then '51''de' when 'ihale' then 'İhale''de' when 'tavla' then 'Tavla''da' else '' end;
  v_amt := replace(to_char(p_amount, 'FM999G999G999'), ',', '.');
  perform public.lobby_post_system(p_user, v_name,
    '🏆 ' || v_name || case when v_game = '' then ' ' else ' ' || v_game || ' ' end || v_amt || ' çip kazandı', 'big_win');
  return jsonb_build_object('ok', true);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'failed');
end $$;
revoke all on function public.lobby_win_event(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.lobby_win_event(uuid, text, bigint) to service_role;
