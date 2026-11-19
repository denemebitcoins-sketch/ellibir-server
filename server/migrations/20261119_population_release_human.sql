-- 19.11: salon-botlu maçtan KALICI ayrılan (çıkış / dönüş süresi doldu) insanın aktif kimlik kilidini kaldırır.
-- match_seats_active_identity_idx (kind, participant_id) where released_at is null — bu kilit, maç bitene kadar
-- oyuncunun başka masada (başka oyunda) maç başlatmasını engelliyordu. Hesaplaşma (finish_match) tüm koltukları
-- released_at'e bakmadan dolaştığı için ödül/iade aynı kalır. Yalnız service_role çağırır. Tekrar çalıştırmak güvenli.
begin;
create or replace function public.bot_population_release_human(p_match text, p_owner uuid, p_user text)
returns boolean language plpgsql security definer set search_path = pg_catalog, bot_population as $$
declare m bot_population.matches; n integer;
begin
  perform bot_population.require_service();
  select * into m from bot_population.matches where match_key = p_match;
  if not found or m.state <> 'active' then return false; end if;
  if m.owner_id is distinct from p_owner then raise exception 'match_owner_lost'; end if;
  update bot_population.match_seats set released_at = clock_timestamp()
   where match_key = p_match and kind = 'human' and participant_id = p_user and released_at is null;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
revoke all on function public.bot_population_release_human(text, uuid, text) from public, anon, authenticated;
grant execute on function public.bot_population_release_human(text, uuid, text) to service_role;
commit;
