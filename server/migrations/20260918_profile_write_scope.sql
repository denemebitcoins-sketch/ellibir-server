-- Existing own-row and admin policies remain authoritative. The legacy ALL/true
-- policy bypassed them (permissive policies are ORed, not ANDed).
begin;
do $$
begin
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='profiles'
    and policyname='profiles_update_own' and cmd='UPDATE')
    or not exists(select 1 from pg_policies where schemaname='public' and tablename='profiles'
    and policyname='profiles_admin_update' and cmd='UPDATE') then
    raise exception 'required_profile_write_policies_missing';
  end if;
end;
$$;
drop policy if exists self_write on public.profiles;
commit;
