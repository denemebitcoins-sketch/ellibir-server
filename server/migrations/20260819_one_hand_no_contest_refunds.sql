-- One-hand no-contest economy guard.
-- Server rooms use this service-role RPC to refund entry fees exactly once when
-- a 1-hand 51/Okey match produces no authoritative winner.

create table if not exists public.match_entry_refunds (
  refund_key text primary key,
  reason text not null default 'one_hand_no_contest',
  amount bigint not null check (amount > 0),
  user_ids text[] not null,
  refunded_count integer not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.match_entry_refunds enable row level security;

revoke all on public.match_entry_refunds from public, anon, authenticated;
grant all on public.match_entry_refunds to service_role;

create or replace function public.refund_match_entry_once(
  p_refund_key text,
  p_reason text,
  p_user_ids text[],
  p_amount bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := btrim(coalesce(p_refund_key, ''));
  v_reason text := left(btrim(coalesce(p_reason, 'one_hand_no_contest')), 80);
  v_uid text;
  v_refunded integer := 0;
begin
  if v_key = '' then
    return jsonb_build_object('ok', false, 'error', 'refund_key_required');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'amount_invalid');
  end if;
  if p_user_ids is null or coalesce(array_length(p_user_ids, 1), 0) = 0 then
    return jsonb_build_object('ok', true, 'already_refunded', false, 'refunded_count', 0);
  end if;

  insert into public.match_entry_refunds(refund_key, reason, amount, user_ids)
  values (v_key, coalesce(nullif(v_reason, ''), 'one_hand_no_contest'), p_amount, p_user_ids)
  on conflict (refund_key) do nothing;

  if not found then
    return jsonb_build_object('ok', true, 'already_refunded', true, 'refunded_count', 0);
  end if;

  foreach v_uid in array p_user_ids loop
    if v_uid is null or btrim(v_uid) = '' then
      continue;
    end if;

    update public.profiles
       set chips = coalesce(chips, 0) + p_amount
     where id = v_uid;

    if found then
      v_refunded := v_refunded + 1;
    end if;
  end loop;

  update public.match_entry_refunds
     set refunded_count = v_refunded,
         completed_at = now()
   where refund_key = v_key;

  return jsonb_build_object('ok', true, 'already_refunded', false, 'refunded_count', v_refunded);
end;
$$;

revoke execute on function public.refund_match_entry_once(text, text, text[], bigint) from public, anon, authenticated;
grant execute on function public.refund_match_entry_once(text, text, text[], bigint) to service_role;
