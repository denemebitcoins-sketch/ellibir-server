-- Prepare the shared entry-commission destination before enabling paid Ihale rooms.
-- No balances, permissions, or existing game pools are changed.
begin;
insert into public.canak (game, amount) values ('ihale', 0)
on conflict (game) do nothing;
commit;
