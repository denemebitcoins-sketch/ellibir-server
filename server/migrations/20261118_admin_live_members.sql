-- Yönetici sitesi "Canlı" sekmesi: anlık çevrimiçi GERÇEK oyuncular + yeni üyeler.
-- Botlar presence/profiles'ta yok (bot_population ayrı şema) → buradaki tüm sayılar gerçek oyuncu.
-- Çevrimiçi = presence.last_seen son 3 dk (oyun kalp atışı). Kayıt sırası auth.users.created_at (canlı profiles'ta created_at yok).
-- Yalnız okuma; yalnız yöneticiye açık.

create or replace function public.admin_live_members(p_limit int default 60)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lim   int := greatest(10, least(coalesce(p_limit, 60), 200));
  v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Istanbul') at time zone 'Europe/Istanbul';
  v_res   jsonb;
begin
  if not coalesce(public.is_current_user_admin(), false) then
    return jsonb_build_object('ok', false, 'error', 'admin_required');
  end if;

  with pr as (
    select p.user_id::text as uid, p.last_seen, coalesce(p.status, '') as status
      from public.presence p
  ), online as (
    select * from pr where last_seen > now() - interval '3 minutes'
  ), members as (
    select u.id::text as uid, u.created_at
      from auth.users u join public.profiles pf on pf.id::text = u.id::text
  )
  select jsonb_build_object(
    'ok', true,
    'now', now(),
    'online', (select count(*) from online),
    'online_table', (select count(*) from online where status = 'masada'),
    'online_lobby', (select count(*) from online where status <> 'masada'),
    'seen_today', (select count(*) from pr where last_seen >= v_today),
    'seen_7d', (select count(*) from pr where last_seen >= now() - interval '7 days'),
    'total_members', (select count(*) from members),
    'new_today', (select count(*) from members where created_at >= v_today),
    'new_7d', (select count(*) from members where created_at >= now() - interval '7 days'),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day::date, 'count', coalesce(c.n, 0)) order by d.day), '[]'::jsonb)
                from generate_series((v_today at time zone 'Europe/Istanbul')::date - 13, (v_today at time zone 'Europe/Istanbul')::date, interval '1 day') as d(day)
                left join (select (created_at at time zone 'Europe/Istanbul')::date as day, count(*) n from members
                            where created_at >= now() - interval '15 days' group by 1) c on c.day = d.day::date),
    'online_list', (select coalesce(jsonb_agg(x order by x->>'status' desc, x->>'name'), '[]'::jsonb) from (
        select jsonb_build_object('id', pf.id, 'name', pf.name, 'role', pf.role, 'avatar_url',
                 case when coalesce(pf.avatar_status, 'visible') in ('visible', 'approved') then pf.avatar_url end,
                 'status', o.status, 'last_seen', o.last_seen, 'chips', pf.chips) as x
          from online o join public.profiles pf on pf.id::text = o.uid
         limit 200) t),
    'recent', (select coalesce(jsonb_agg(x order by (x->>'created_at') desc), '[]'::jsonb) from (
        select jsonb_build_object('id', pf.id, 'name', pf.name, 'role', pf.role, 'avatar_url',
                 case when coalesce(pf.avatar_status, 'visible') in ('visible', 'approved') then pf.avatar_url end,
                 'created_at', m.created_at, 'chips', pf.chips, 'matches', pf.matches,
                 'last_seen', pr.last_seen,
                 'online', coalesce(pr.last_seen > now() - interval '3 minutes', false)) as x
          from members m join public.profiles pf on pf.id::text = m.uid
          left join pr on pr.uid = m.uid
         order by m.created_at desc
         limit v_lim) t)
  ) into v_res;
  return v_res;
end;
$$;
revoke all on function public.admin_live_members(int) from public, anon;
grant execute on function public.admin_live_members(int) to authenticated;
