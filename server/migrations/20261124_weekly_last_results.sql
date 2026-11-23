-- 24.11: Haftanın Kahvecisi · GEÇEN HAFTA sekmesi (yalnız okuma).
-- Son KAPANMIŞ hafta (weekly_rewards rank=0 işareti) → ilk 10 + ödülleri + çağıranın o haftaki sırası/puanı.
begin;
create or replace function public.weekly_last_results()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_week date;
  v_me   text := auth.uid()::text;
  v_rows jsonb;
  v_me_j jsonb;
begin
  select max(week_start) into v_week from public.weekly_rewards where rank = 0;
  if v_week is null then
    return jsonb_build_object('week_start', null, 'rows', '[]'::jsonb, 'me', jsonb_build_object('rank', null, 'points', 0));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'rank', r.rank, 'user_id', r.user_id, 'points', r.points, 'chips', r.chips, 'diamonds', r.diamonds,
           'name', p.name, 'avatar_url', case when coalesce(p.avatar_status, 'visible') in ('visible', 'approved') then p.avatar_url end,
           'role', p.role, 'gender', p.gender) order by r.rank), '[]'::jsonb)
    into v_rows
    from public.weekly_rewards r
    left join public.profiles p on p.id::text = r.user_id
   where r.week_start = v_week and r.rank between 1 and 10;

  if v_me is not null then
    with ranked as (
      select w.user_id, w.points,
             row_number() over (order by w.points desc, w.updated_at asc) as rank
        from public.weekly_points w
       where w.week_start = v_week and w.points > 0
    )
    select jsonb_build_object('rank', m.rank, 'points', m.points) into v_me_j
      from ranked m where m.user_id = v_me;
  end if;

  return jsonb_build_object(
    'week_start', v_week,
    'week_end', v_week + 6,
    'rows', v_rows,
    'me', coalesce(v_me_j, jsonb_build_object('rank', null, 'points', 0)));
end;
$$;
revoke execute on function public.weekly_last_results() from public, anon;
grant  execute on function public.weekly_last_results() to authenticated;
commit;
