-- Online Kahvem - VIP/normal direct-message quota (2026-07-17)
-- Normal uyeler gunluk makul DM kotasinda kalir; VIP/admin sosyal tarafta daha genis alana sahip olur.

begin;

create table if not exists public.direct_message_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_day date not null,
  sent_count integer not null default 0 check (sent_count >= 0),
  primary key (user_id, usage_day)
);

alter table public.direct_message_daily_usage enable row level security;

drop policy if exists dm_daily_usage_select_own on public.direct_message_daily_usage;
create policy dm_daily_usage_select_own on public.direct_message_daily_usage
  for select to authenticated
  using (auth.uid() = user_id);

create or replace function public.direct_message_daily_limit()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1 from public.profiles p
       where p.id::text = auth.uid()::text
         and (p.role = 'admin' or (p.vip_until is not null and p.vip_until > now()))
    ) then 500
    else 50
  end;
$$;

revoke execute on function public.direct_message_daily_limit() from public, anon;
grant execute on function public.direct_message_daily_limit() to authenticated;

create or replace function public.direct_messages_enforce_daily_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := 25;
  v_day date := (now() at time zone 'Europe/Istanbul')::date;
  v_count integer := 0;
begin
  if auth.uid() is null or new.from_user <> auth.uid() then
    raise exception 'dm_auth_required';
  end if;

  v_limit := public.direct_message_daily_limit();

  select coalesce(sent_count, 0)
    into v_count
    from public.direct_message_daily_usage
   where user_id = new.from_user
     and usage_day = v_day
   for update;

  if coalesce(v_count, 0) >= v_limit then
    raise exception 'dm_daily_limit:%', v_limit;
  end if;

  insert into public.direct_message_daily_usage(user_id, usage_day, sent_count)
  values (new.from_user, v_day, 1)
  on conflict (user_id, usage_day)
  do update set sent_count = public.direct_message_daily_usage.sent_count + 1;

  return new;
end;
$$;

revoke all on function public.direct_messages_enforce_daily_quota() from public;

drop trigger if exists trg_direct_messages_daily_quota on public.direct_messages;
create trigger trg_direct_messages_daily_quota
before insert on public.direct_messages
for each row execute function public.direct_messages_enforce_daily_quota();

commit;
