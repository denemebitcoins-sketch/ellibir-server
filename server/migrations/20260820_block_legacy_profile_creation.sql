-- Online Kahvem - block legacy client-side profile creation (2026-08-20)
-- New accounts are created only by the Render recovery/onboarding service.
-- This prevents old clients from producing 5000 chip / 5 diamond ghost profiles.

begin;

create or replace function public.profiles_guard_client_sensitive()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  jwt_role text := coalesce(auth.role(), '');
  is_admin boolean := false;
begin
  if jwt_role = 'service_role' or current_user in ('postgres', 'service_role') then
    return new;
  end if;

  if TG_OP = 'INSERT' then
    raise exception 'client_profile_creation_disabled'
      using errcode = '42501',
            hint = 'Create accounts through the recovery onboarding server.';
  end if;

  if auth.uid() is not null then
    is_admin := public.is_current_user_admin();
  end if;

  if is_admin then
    if TG_OP = 'UPDATE' then
      new.account_level := old.account_level;
      new.account_xp_total := old.account_xp_total;
      new.account_xp_updated_at := old.account_xp_updated_at;
    end if;
    return new;
  end if;

  if TG_OP = 'UPDATE' then
    new.chips := old.chips; new.diamonds := old.diamonds;
    new.matches := old.matches; new.wins := old.wins; new.best_streak := old.best_streak;
    new.cur_streak := old.cur_streak; new.total_won := old.total_won;
    new.vip_until := old.vip_until; new.last_daily := old.last_daily; new.daily_day := old.daily_day;
    new.daily_claim_week := old.daily_claim_week; new.daily_claim_mask := old.daily_claim_mask;
    new.vip_daily_day := old.vip_daily_day; new.vip_last_daily := old.vip_last_daily;
    new.account_level := old.account_level;
    new.account_xp_total := old.account_xp_total;
    new.account_xp_updated_at := old.account_xp_updated_at;
    new.role := old.role; new.banned := old.banned;
    new.chat_banned_until := old.chat_banned_until;
    new.message_banned_until := old.message_banned_until;
    new.game_banned_until := old.game_banned_until;
    new.avatar_status := old.avatar_status;
    new.recovery_secured_at := old.recovery_secured_at;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_profiles_guard_client_sensitive on public.profiles;
create trigger trg_profiles_guard_client_sensitive
before insert or update on public.profiles
for each row execute function public.profiles_guard_client_sensitive();

commit;

