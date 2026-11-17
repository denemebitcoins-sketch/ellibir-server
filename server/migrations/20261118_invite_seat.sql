-- 6.8: davet, davet edenin tıkladığı koltuğu taşır; davetli o koltuk boşsa oraya oturur (-1 = fark etmez).
-- 6.8 istemcisi seat yazar → bu kolon 6.8 yayınından ÖNCE canlıda olmalı (yoksa davet INSERT'i 400 alır).
alter table public.invites add column if not exists seat int not null default -1;
notify pgrst, 'reload schema';
