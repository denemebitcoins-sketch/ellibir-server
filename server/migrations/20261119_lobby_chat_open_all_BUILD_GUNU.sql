-- BUILD GÜNÜ UYGULANACAK (yeni sürüm mağazaya çıkınca): topluluk sohbeti herkese açılır.
-- Eskiden yalnız VIP/yönetici yazabiliyordu. Sohbet yasağı aynen geçerli; flood koruması trg_lobby_chat_rate'te.
-- Uygulamadan önce canlıdaki can_write_lobby_chat gövdesine bak (yönetici rolü farklı yazılmış olabilir).
create or replace function public.can_write_lobby_chat()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id::text = auth.uid()::text
       and (p.chat_banned_until is null or p.chat_banned_until <= now())
  );
$$;
revoke execute on function public.can_write_lobby_chat() from public, anon;
grant execute on function public.can_write_lobby_chat() to authenticated;
notify pgrst, 'reload schema';
