-- Online Kahvem - 2026-07-09 SECURITY DEFINER / RPC hardening
-- Supabase SQL Editor'da calistirilacak kucuk, idempotent yama.
-- Amac:
-- 1) SECURITY DEFINER fonksiyonlarini public search_path'e sabitlemek.
-- 2) Service-role-only RPC'leri anon/authenticated client'lardan kapatmak.
-- 3) Gercek Play Billing receipt dogrulamasi gelene kadar mock VIP RPC'yi kapatmak.

alter function if exists public.record_match_stats(text, boolean, bigint) set search_path = public;
alter function if exists public.canak_add(text, bigint) set search_path = public;
alter function if exists public.canak_take(text) set search_path = public;
alter function if exists public.claim_admin_reward(bigint) set search_path = public;
alter function if exists public.friend_count(text) set search_path = public;
alter function if exists public.admin_set_avatar_status(text, text) set search_path = public;
alter function if exists public.my_report_count(int) set search_path = public;
alter function if exists public.deduct_diamonds(text, int) set search_path = public;
alter function if exists public.profiles_guard_client_sensitive() set search_path = public;
alter function if exists public.buy_vip_mock(int) set search_path = public;
alter function if exists public.get_daily_state() set search_path = public;
alter function if exists public.claim_daily(int) set search_path = public;

revoke execute on function public.record_match_stats(text, boolean, bigint) from public, anon, authenticated;
grant  execute on function public.record_match_stats(text, boolean, bigint) to service_role;

revoke execute on function public.canak_add(text, bigint) from public, anon, authenticated;
revoke execute on function public.canak_take(text) from public, anon, authenticated;
grant  execute on function public.canak_add(text, bigint) to service_role;
grant  execute on function public.canak_take(text) to service_role;

revoke execute on function public.deduct_diamonds(text, int) from public, anon, authenticated;
grant  execute on function public.deduct_diamonds(text, int) to service_role;

revoke execute on function public.claim_admin_reward(bigint) from public, anon;
grant  execute on function public.claim_admin_reward(bigint) to authenticated;

revoke execute on function public.friend_count(text) from public, anon;
grant  execute on function public.friend_count(text) to authenticated;

revoke execute on function public.admin_set_avatar_status(text, text) from public, anon;
grant  execute on function public.admin_set_avatar_status(text, text) to authenticated;

revoke execute on function public.my_report_count(int) from public, anon;
grant  execute on function public.my_report_count(int) to authenticated;

-- Production: mock VIP satin alma gercek odeme dogrulamasi degildir.
-- Play Billing receipt dogrulayan yeni server RPC gelene kadar client tarafindan cagrilamaz.
revoke execute on function public.buy_vip_mock(int) from public, anon, authenticated;

grant execute on function public.get_daily_state() to authenticated;
grant execute on function public.claim_daily(int) to authenticated;
