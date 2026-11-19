-- Online Kahvem - oyun bakım modu (2026-11-19)
-- Her oyun ayrı ayrı "bakımda" yapılabilir. Bakımdaki oyunda salon "Şu an bakımda" yazar,
-- yeni masa açılmaz / masaya oturulmaz (sunucu da reddeder). Süren masalar bitene kadar devam eder.
-- Yöneticiler bakımdaki oyuna yine girebilir (test için). Tekrar çalıştırmak güvenlidir.

begin;

create table if not exists public.game_maintenance (
  game_key text primary key check (game_key in ('101','klasik','bankolu','51','ihale','tavla')),
  maintenance boolean not null default false,
  message text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into public.game_maintenance(game_key) values
  ('101'),('klasik'),('bankolu'),('51'),('ihale'),('tavla')
on conflict (game_key) do nothing;

alter table public.game_maintenance enable row level security;
revoke all on table public.game_maintenance from public, anon, authenticated;

-- Herkes (giriş yapmamış dahil) okuyabilir: { "51": {"on": true, "msg": "..."}, ... }
create or replace function public.get_game_maintenance()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(game_key, jsonb_build_object('on', maintenance, 'msg', message)), '{}'::jsonb)
    from public.game_maintenance;
$$;

revoke execute on function public.get_game_maintenance() from public;
grant execute on function public.get_game_maintenance() to anon, authenticated;

-- Yalnız yönetici değiştirir.
create or replace function public.admin_set_game_maintenance(p_game text, p_on boolean, p_message text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_current_user_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  if p_game not in ('101','klasik','bankolu','51','ihale','tavla') then
    raise exception 'bad_game';
  end if;
  insert into public.game_maintenance(game_key, maintenance, message, updated_at, updated_by)
  values (p_game, coalesce(p_on, false), left(coalesce(trim(p_message), ''), 160), now(), auth.uid())
  on conflict (game_key) do update
    set maintenance = excluded.maintenance, message = excluded.message,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  return public.get_game_maintenance();
end;
$$;

revoke execute on function public.admin_set_game_maintenance(text, boolean, text) from public, anon;
grant execute on function public.admin_set_game_maintenance(text, boolean, text) to authenticated;

commit;
