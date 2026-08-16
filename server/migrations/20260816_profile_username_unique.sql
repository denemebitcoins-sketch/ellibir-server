-- Online Kahvem - completed profile username uniqueness (2026-08-16)
-- Protect first-run onboarding from race conditions: two completed profiles
-- cannot claim the same visible username, ignoring case and surrounding spaces.

begin;

create unique index if not exists profiles_name_lower_uniq
  on public.profiles (lower(btrim(name)))
  where nullif(btrim(name), '') is not null
    and btrim(name) !~ '^Oyuncu_[0-9A-F]{6,10}$';

commit;
