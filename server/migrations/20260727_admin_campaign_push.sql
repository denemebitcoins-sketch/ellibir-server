-- ════════════════════════════════════════════════════════════════════════════
-- ADMIN KAMPANYA PUSH (2026-07-27) — yönetim panelinden tüm cihazlara anlık bildirim.
-- admin_send_campaign_push: yalnız profiles.role='admin' çağırabilir; kuyruk
-- enqueue_system_push (push_outbox) üzerinden mevcut FCM dağıtımına düşer.
-- KULLANICI NOTU: bu dosyayı Supabase SQL editöründe ÇALIŞTIR.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.admin_send_campaign_push(p_title text, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if not public.is_current_user_admin() then
    return jsonb_build_object('ok', false, 'error', 'admin_required');
  end if;
  if coalesce(length(trim(p_title)), 0) = 0 or coalesce(length(trim(p_body)), 0) = 0 then
    return jsonb_build_object('ok', false, 'error', 'empty_fields');
  end if;
  select public.enqueue_system_push(p_title, p_body, '{}'::jsonb) into v_count;
  return jsonb_build_object('ok', true, 'sent', v_count);
end;
$$;

revoke all on function public.admin_send_campaign_push(text, text) from public, anon;
grant  execute on function public.admin_send_campaign_push(text, text) to authenticated;
