-- 18.11 ETKİNLİK BİLDİRİMLERİ (otomatik, sunucu zamanlayıcısı çağırır; hepsi idempotent)
--  1) Kahve Saati hatırlatması: her akşam ~19:50 (TR). Bildirimi açık + son 14 günde oyuna girmiş oyunculara,
--     günde en fazla bir kez.
--  2) Haftanın Kahvecisi: hafta kapanınca (weekly_close_due ödülleri dağıttıktan sonra) ilk 10'a "oldun" bildirimi,
--     hafta başına bir kez.
-- Gönderim mevcut push_outbox → pushWorker (FCM) hattından gider.

create or replace function public.enqueue_coffee_hour_reminders()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_day   date := (now() at time zone 'Europe/Istanbul')::date;
  v_start timestamptz := v_day::timestamp at time zone 'Europe/Istanbul';
  v_count int := 0;
begin
  insert into public.push_outbox(user_id, kind, title, body, data)
  select p.id::uuid, 'system',
         '☕ Kahve Saati 10 dakikaya başlıyor!',
         '20:00–23:00 arası günün ilk 5 maçında kaybedene bahsin yarısı iade, kazanana %30 bonus. Puanlar da 2 kat!',
         jsonb_build_object('type', 'coffee_hour', 'day', v_day)
    from public.profiles p
   where exists (select 1 from public.push_devices d where d.user_id = p.id::uuid and d.enabled)
     and exists (select 1 from public.presence pr where pr.user_id::text = p.id::text
                  and pr.last_seen >= now() - interval '14 days')
     and not exists (select 1 from public.push_outbox o
                      where o.user_id = p.id::uuid and o.kind = 'system'
                        and o.data->>'type' = 'coffee_hour' and o.created_at >= v_start);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.enqueue_coffee_hour_reminders() from public, anon, authenticated;
grant execute on function public.enqueue_coffee_hour_reminders() to service_role;

create or replace function public.enqueue_weekly_winner_pushes()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count int := 0;
begin
  insert into public.push_outbox(user_id, kind, title, body, data)
  select r.user_id::uuid, 'system',
         '🏆 Haftanın Kahvecisi ' || r.rank || '. oldun!',
         fmt.chips || ' çip + ' || r.diamonds || ' elmas hesabında. Tebrikler, yeni haftada da bekleriz!',
         jsonb_build_object('type', 'weekly_winner', 'week', r.week_start, 'rank', r.rank)
    from public.weekly_rewards r
    cross join lateral (select replace(to_char(r.chips, 'FM999G999G999'), ',', '.') as chips) fmt
   where r.rank >= 1 and r.user_id is not null
     and r.created_at >= now() - interval '3 days'
     and exists (select 1 from public.push_devices d where d.user_id::text = r.user_id and d.enabled)
     and not exists (select 1 from public.push_outbox o
                      where o.user_id::text = r.user_id and o.kind = 'system'
                        and o.data->>'type' = 'weekly_winner' and o.data->>'week' = r.week_start::text);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.enqueue_weekly_winner_pushes() from public, anon, authenticated;
grant execute on function public.enqueue_weekly_winner_pushes() to service_role;
