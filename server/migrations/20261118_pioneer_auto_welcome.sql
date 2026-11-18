-- 6.8 Öncü Üye: ilk 1000 üyeye otomatik rozet + bir kez gösterilen karşılama penceresi.
-- Üye numarası = auth.users.created_at sırası (canlı profiles'ta created_at yok; botlar profiles'ta yok). Tavan fonksiyonda (sonradan büyütülebilir).
-- Elle verilmiş rozetler korunur; onlar da karşılamayı bir kez görür.
-- Mevcut admin bildirim akışına (my_member_award_notice / ack_member_award_notice) DOKUNMAZ.

alter table public.profiles add column if not exists pioneer_welcomed_at timestamptz;

-- Rozet koruyucusu: yalnız service_role/admin değiştirebilir + bu dosyadaki otomatik verme (işlem içi bayrak).
create or replace function public.guard_honorary_title()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if (tg_op='INSERT' and new.honorary_title<>'') or
     (tg_op='UPDATE' and new.honorary_title is distinct from old.honorary_title) then
    if coalesce(auth.role(),'')<>'service_role' and not coalesce(public.is_current_user_admin(),false)
       and coalesce(current_setting('app.pioneer_auto_grant', true), '') <> '1' then
      raise exception 'admin_required' using errcode='42501';
    end if;
  end if;
  return new;
end; $$;

create or replace function public.claim_pioneer_welcome() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c_cap constant int := 1000;
  v_uid text := auth.uid()::text;
  v_created timestamptz; v_title text; v_welcomed timestamptz; v_no bigint; v_granted boolean := false;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'auth_required'); end if;
  select coalesce(honorary_title, ''), pioneer_welcomed_at into v_title, v_welcomed
    from public.profiles where id::text = v_uid;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_profile'); end if;
  -- canlı profiles'ta created_at YOK → kayıt sırası auth.users.created_at'ten
  select u.created_at into v_created from auth.users u where u.id::text = v_uid;
  v_created := coalesce(v_created, now());
  select count(*) into v_no from public.profiles p left join auth.users u on u.id::text = p.id::text
    where coalesce(u.created_at, now()) < v_created
       or (coalesce(u.created_at, now()) = v_created and p.id::text <= v_uid);
  if v_title = '' and v_no <= c_cap then
    perform set_config('app.pioneer_auto_grant', '1', true);
    update public.profiles set honorary_title = 'pioneer' where id::text = v_uid;
    perform set_config('app.pioneer_auto_grant', '', true);
    v_title := 'pioneer'; v_granted := true;
  end if;
  return jsonb_build_object('ok', true,
    'member_no', v_no,
    'pioneer', v_title = 'pioneer',
    'granted', v_granted,
    'show', v_title = 'pioneer' and v_welcomed is null);
end $$;
revoke all on function public.claim_pioneer_welcome() from public, anon;
grant execute on function public.claim_pioneer_welcome() to authenticated;

create or replace function public.ack_pioneer_welcome() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'auth_required'); end if;
  update public.profiles set pioneer_welcomed_at = now() where id::text = auth.uid()::text and pioneer_welcomed_at is null;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.ack_pioneer_welcome() from public, anon;
grant execute on function public.ack_pioneer_welcome() to authenticated;

notify pgrst, 'reload schema';
