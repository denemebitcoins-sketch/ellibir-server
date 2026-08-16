-- Online Kahvem - completed profile username uniqueness (2026-08-16)
-- Protect first-run onboarding from race conditions without breaking migration
-- on old duplicate profile rows. Existing duplicates remain untouched; future
-- insert/update attempts for the same visible username are rejected.

begin;

create index if not exists profiles_name_lower_lookup_idx
  on public.profiles (lower(btrim(name)))
  where nullif(btrim(name), '') is not null
    and btrim(name) !~ '^Oyuncu_[0-9A-F]{6,10}$';

create or replace function public.guard_profile_name_unique()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_norm text := lower(btrim(new.name));
  v_existing text;
begin
  if v_norm is null or v_norm = '' or btrim(new.name) ~ '^Oyuncu_[0-9A-F]{6,10}$' then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_norm, 0));

  select p.id::text
    into v_existing
    from public.profiles p
   where lower(btrim(p.name)) = v_norm
     and p.id::text <> new.id::text
     and btrim(p.name) !~ '^Oyuncu_[0-9A-F]{6,10}$'
   limit 1;

  if v_existing is not null then
    raise exception 'profiles_name_lower_uniq'
      using errcode = '23505', constraint = 'profiles_name_lower_uniq';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_profile_name_unique() from public, anon, authenticated;

drop trigger if exists trg_profiles_name_unique on public.profiles;
create trigger trg_profiles_name_unique
before insert or update of name on public.profiles
for each row
execute function public.guard_profile_name_unique();

commit;
