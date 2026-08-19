-- Giriş yapamayan oyuncunun destek bildirimi de yönetim raporlarına düşebilsin.
-- Auth öncesi kullanıcının auth.uid() değeri olmadığı için from_user boş kalabilir.

alter table public.reports
  alter column from_user drop not null;

alter table public.reports drop constraint if exists reports_type_check;
alter table public.reports add constraint reports_type_check
  check (type in ('istek','sikayet','oneri','bug','baglanti'));

create or replace function public.reports_enforce_sender()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_name text;
begin
  if new.from_user is null then
    new.name := coalesce(nullif(trim(new.name), ''), 'Giriş Desteği');
    return new;
  end if;

  select coalesce(nullif(p.name, ''), 'Oyuncu') into v_name
    from public.profiles p where p.id::text = new.from_user::text;
  new.name := coalesce(v_name, 'Oyuncu');
  return new;
end;
$$;

revoke all on function public.reports_enforce_sender() from public;
drop trigger if exists trg_reports_enforce_sender on public.reports;
create trigger trg_reports_enforce_sender
before insert on public.reports
for each row execute function public.reports_enforce_sender();
