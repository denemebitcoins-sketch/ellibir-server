-- Admin odulleri negatif bakiye yazamaz.
-- Not valid constraint mevcut eski satirlar yuzunden migration'i kirmadan
-- bundan sonraki insert/update islemlerini korur; RLS policy de client insertini reddeder.

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'admin_rewards_nonnegative_amounts'
       and conrelid = 'public.admin_rewards'::regclass
  ) then
    alter table public.admin_rewards
      add constraint admin_rewards_nonnegative_amounts
      check (chips >= 0 and diamonds >= 0 and (chips > 0 or diamonds > 0)) not valid;
  end if;
end $$;

drop policy if exists admin_rewards_insert on public.admin_rewards;
create policy admin_rewards_insert on public.admin_rewards
  for insert to authenticated
  with check (
    exists (select 1 from public.profiles pr where pr.id = auth.uid()::text and pr.role = 'admin')
    and chips >= 0
    and diamonds >= 0
    and (chips > 0 or diamonds > 0)
  );
