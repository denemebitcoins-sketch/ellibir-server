-- Online Kahvem beta reset tool.
-- This migration only installs the protected function. It DOES NOT run a reset.
-- Recommended invocation from Supabase SQL Editor:
--   select public.admin_reset_beta_data('ONLINE-KAHVEM-BETA-SIFIRLA', false);
--
-- Auth users, profile identity (name/gender/avatar), device bindings and one-time
-- welcome claims are deliberately retained. The immutable purchase/ad ledger is
-- retained unless the second argument is explicitly true.

begin;

create or replace function public.admin_reset_beta_data(
  p_confirmation text,
  p_include_financial_ledger boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_table text;
  v_profiles integer := 0;
  v_deleted_tables integer := 0;
  v_financial_tables integer := 0;
  v_tables text[] := array[
    'post_comments', 'post_likes', 'posts', 'profile_views',
    'direct_messages', 'lobby_chat', 'notifications', 'invites',
    'friendships', 'blocks', 'gifts', 'reports', 'bans',
    'presence', 'canak_events', 'admin_rewards', 'promo_redemptions', 'push_outbox',
    'app_feature_testers'
  ];
begin
  if current_user not in ('postgres', 'service_role') then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_confirmation is distinct from 'ONLINE-KAHVEM-BETA-SIFIRLA' then
    return jsonb_build_object('ok', false, 'error', 'confirmation_required');
  end if;

  -- Child/history tables are cleared individually. No CASCADE is used, so an
  -- unexpected future foreign key can never wipe auth.users or profiles.
  foreach v_table in array v_tables loop
    if to_regclass('public.' || v_table) is not null then
      execute format('delete from public.%I', v_table);
      v_deleted_tables := v_deleted_tables + 1;
    end if;
  end loop;

  -- Existing accounts remain usable, but launch economy, progression, VIP and
  -- moderation state return to the clean beta baseline. Admin identity survives.
  update public.profiles
     set chips = 50000,
         diamonds = 500,
         matches = 0,
         wins = 0,
         best_streak = 0,
         cur_streak = 0,
         total_won = 0,
         vip_until = null,
         last_daily = null,
         daily_day = 0,
         daily_claim_week = null,
         daily_claim_mask = 0,
         vip_daily_day = 0,
         vip_last_daily = null,
         banned = false,
         chat_banned_until = null,
         message_banned_until = null,
         game_banned_until = null,
         role = case when role = 'admin' then 'admin' else 'normal' end,
         allow_dm = true,
         allow_friend_req = true,
         invite_pref = 'open',
         gift_off = false,
         profile_visibility = 'open';
  get diagnostics v_profiles = row_count;

  insert into public.canak(game, amount, updated_at) values
    ('51', 20000, now()),
    ('okey', 20000, now()),
    ('tavla', 20000, now())
  on conflict (game) do update
    set amount = excluded.amount, updated_at = excluded.updated_at;

  -- Free beta remains closed after reset; administrators still bypass the gate.
  if to_regclass('public.app_features') is not null then
    update public.app_features
       set enabled = false, updated_at = now()
     where key in ('shop', 'daily', 'economy_test');
  end if;

  if p_include_financial_ledger then
    foreach v_table in array array['rewarded_ad_sessions', 'play_purchase_receipts'] loop
      if to_regclass('public.' || v_table) is not null then
        execute format('delete from public.%I', v_table);
        v_financial_tables := v_financial_tables + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'profiles_reset', v_profiles,
    'history_tables_cleared', v_deleted_tables,
    'financial_tables_cleared', v_financial_tables,
    'financial_ledger_preserved', not p_include_financial_ledger,
    'auth_users_preserved', true,
    'device_bindings_preserved', true,
    'canak_seed', 20000
  );
end;
$$;

revoke all on function public.admin_reset_beta_data(text, boolean) from public, anon, authenticated;
grant execute on function public.admin_reset_beta_data(text, boolean) to service_role;

commit;

-- Deliberately not part of the reset function:
-- delete from auth.users;
-- Running that statement invalidates every login and cascades profile/device rows.
