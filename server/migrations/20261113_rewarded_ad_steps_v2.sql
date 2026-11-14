-- Online Kahvem - Rewarded ad daily stepped rewards (v2, 13.11.2026)
-- Rewards reset daily: 2500, 5000, 7500, 10000, 15000 chips.
-- Only the step table changes; begin/get/claim functions keep calling rewarded_ad_chips_for_index.
-- APPLIED to live Supabase on 2026-11-14.

begin;

create or replace function public.rewarded_ad_chips_for_index(p_used_before integer)
returns integer
language sql
immutable
as $$
  select case
    when coalesce(p_used_before, 0) <= 0 then 2500
    when p_used_before = 1 then 5000
    when p_used_before = 2 then 7500
    when p_used_before = 3 then 10000
    when p_used_before = 4 then 15000
    else 0
  end;
$$;

alter table public.rewarded_ad_sessions
  alter column reward_chips set default 2500;

commit;
