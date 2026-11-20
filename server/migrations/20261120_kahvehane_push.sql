-- 20.11 (5): Kahvehane beğeni/yorum PUSH bildirimi + tek gönderi okuma RPC'si (bildirimden gönderiye gitmek için).
-- Spam olmasın: aynı gönderi için beğeni pushu saatte 1, yorum pushu 5 dakikada 1; kişi başı saatte en fazla 6 Kahvehane pushu.

create or replace function public.kahvehane_post(p_post bigint)
returns jsonb language sql stable security definer set search_path = public as $$
  select public.kv_post_json(p, auth.uid()) from public.posts p
   where p.id = p_post and auth.uid() is not null and public.kv_can_see_post(p.id);
$$;
revoke all on function public.kahvehane_post(bigint) from public, anon;
grant execute on function public.kahvehane_post(bigint) to authenticated;

create or replace function public.queue_kv_push()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text; v_body text;
begin
  if new.type not in ('like', 'comment') or new.post_id is null or new.user_id = new.actor_id then return new; end if;
  begin
    if not exists (select 1 from public.push_devices d where d.user_id = new.user_id and d.enabled) then return new; end if;
    if exists (select 1 from public.push_outbox o
                where o.user_id = new.user_id and o.data->>'type' = 'kv' and o.data->>'kv' = new.type
                  and o.data->>'post_id' = new.post_id::text
                  and o.created_at > now() - case when new.type = 'like' then interval '1 hour' else interval '5 minutes' end)
    then return new; end if;
    if (select count(*) from public.push_outbox o
         where o.user_id = new.user_id and o.data->>'type' = 'kv' and o.created_at > now() - interval '1 hour') >= 6
    then return new; end if;
    select nullif(trim(p.name), '') into v_name from public.profiles p where p.id::text = new.actor_id::text;
    v_body := coalesce(v_name, 'Bir oyuncu') ||
      case when new.type = 'like' then ' gönderini beğendi.'
           else ' yorum yaptı: ' || left(coalesce(new.preview, ''), 70) end;
    insert into public.push_outbox(user_id, kind, title, body, data)
    values (new.user_id, 'system', 'Kahvehane', left(v_body, 180),
            jsonb_build_object('type', 'kv', 'kv', new.type, 'post_id', new.post_id::text, 'actor_id', new.actor_id::text));
  exception when others then null; -- bildirim kaydı asla bozulmasın
  end;
  return new;
end;
$$;
revoke all on function public.queue_kv_push() from public, anon;
drop trigger if exists queue_kv_push_trg on public.notifications;
create trigger queue_kv_push_trg after insert on public.notifications
  for each row execute function public.queue_kv_push();
