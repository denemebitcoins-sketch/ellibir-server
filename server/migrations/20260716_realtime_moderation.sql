-- Authenticated clients poll this small RPC every few seconds. It exposes only the caller's
-- moderation state and the public-facing reason, never admin notes.

create or replace function public.get_my_moderation_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  p record;
  v_chat_reason text := '';
  v_message_reason text := '';
  v_game_reason text := '';
  v_chat_active boolean;
  v_message_active boolean;
  v_game_active boolean;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'auth_required'); end if;
  select banned, chat_banned_until, message_banned_until, game_banned_until
    into p from public.profiles where id::text = v_uid::text;
  if not found then return jsonb_build_object('ok', false, 'error', 'profile_not_found'); end if;

  v_chat_active := p.chat_banned_until is not null and p.chat_banned_until > now();
  v_message_active := p.message_banned_until is not null and p.message_banned_until > now();
  -- Legacy banned is consulted only when no typed game expiry exists. Otherwise an expired
  -- timed punishment must not silently become permanent.
  v_game_active := case when p.game_banned_until is not null
                   then p.game_banned_until > now() else coalesce(p.banned, false) end;

  if v_chat_active then
    select coalesce(reason, '') into v_chat_reason from public.bans
     where target_user = v_uid and type = 'chat' and not revoked
       and (expires_at is null or expires_at > now()) order by created_at desc limit 1;
  end if;
  if v_message_active then
    select coalesce(reason, '') into v_message_reason from public.bans
     where target_user = v_uid and type = 'message' and not revoked
       and (expires_at is null or expires_at > now()) order by created_at desc limit 1;
  end if;
  if v_game_active then
    select coalesce(reason, '') into v_game_reason from public.bans
     where target_user = v_uid and type = 'game' and not revoked
       and (expires_at is null or expires_at > now()) order by created_at desc limit 1;
  end if;

  return jsonb_build_object(
    'ok', true,
    'chat_active', v_chat_active, 'chat_until', p.chat_banned_until, 'chat_reason', coalesce(v_chat_reason, ''),
    'message_active', v_message_active, 'message_until', p.message_banned_until, 'message_reason', coalesce(v_message_reason, ''),
    'game_active', v_game_active, 'game_until', p.game_banned_until, 'game_reason', coalesce(v_game_reason, ''),
    'account_banned', coalesce(p.banned, false) and p.game_banned_until is null
  );
end;
$$;

revoke all on function public.get_my_moderation_state() from public, anon;
grant execute on function public.get_my_moderation_state() to authenticated;
