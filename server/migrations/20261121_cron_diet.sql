-- 21.11 VERİTABANI RAHATLATMA (ücretsiz Nano makine bellek/disk baskısı)
--  * cron.job_run_details 640 bin satır / 108 MB'a şişmişti (her 30 sn'de bir satır): geçmiş sıfırlanır,
--    her gece 1 günden eski kayıtlar silinir.
--  * presence-leave-sweep 30 sn → 1 dk; invites-expire-sweep 1 dk → 5 dk (davetler istemcide zaten 10 dk tazelik kontrolünden geçer).
-- Hiçbir oyun verisi silinmez; yalnız zamanlanmış görevlerin çalışma GEÇMİŞİ temizlenir. Tekrar çalıştırmak güvenlidir.

truncate cron.job_run_details;

select cron.alter_job(j.jobid, schedule := '* * * * *') from cron.job j where j.jobname = 'presence-leave-sweep';
select cron.alter_job(j.jobid, schedule := '*/5 * * * *') from cron.job j where j.jobname = 'invites-expire-sweep';

select cron.unschedule('cron-history-cleanup') where exists (select 1 from cron.job where jobname = 'cron-history-cleanup');
select cron.schedule('cron-history-cleanup', '23 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '1 day'$$);

select jobname, schedule from cron.job order by jobid;
