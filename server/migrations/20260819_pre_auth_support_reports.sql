-- Giriş yapamayan oyuncunun destek bildirimi de yönetim raporlarına düşebilsin.
-- Auth öncesi kullanıcının auth.uid() değeri olmadığı için from_user boş kalabilir.

alter table public.reports
  alter column from_user drop not null;

