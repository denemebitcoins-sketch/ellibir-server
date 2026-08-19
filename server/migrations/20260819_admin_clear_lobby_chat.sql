-- Online Kahvem - admin community chat clear tool (2026-08-19)
-- Clears public lobby/community chat only through an admin-checked RPC.

create table if not exists public.lobby_chat_clear_audit (
  id bigint generated always as identity primary key,
  admin_user uuid not null references auth.users(id) on delete restrict,
  cleared_count integer not null default 0,
  reason text not null default 'admin_clear',
  created_at timestamptz not null default now()
);

alter table public.lobby_chat_clear_audit enable row level security;
revoke all on public.lobby_chat_clear_audit from public, anon, authenticated;
grant all on public.lobby_chat_clear_audit to service_role;

create or replace function public.admin_clear_lobby_chat()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid := auth.uid();
  v_count integer := 0;
begin
  if v_admin is null or not public.is_current_user_admin() then
    return jsonb_build_object('ok', false, 'error', 'admin_required', 'cleared_count', 0);
  end if;

  select count(*)::integer into v_count from public.lobby_chat;

  delete from public.lobby_chat
   where id is not null;

  insert into public.lobby_chat_clear_audit(admin_user, cleared_count, reason)
  values (v_admin, v_count, 'admin_clear_lobby_chat');

  return jsonb_build_object('ok', true, 'cleared_count', v_count);
end;
$$;

revoke execute on function public.admin_clear_lobby_chat() from public, anon, authenticated;
grant execute on function public.admin_clear_lobby_chat() to authenticated;
