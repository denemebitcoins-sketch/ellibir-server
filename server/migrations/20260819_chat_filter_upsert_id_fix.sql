-- Hotfix: make admin_upsert_chat_filter_word return the real row id after insert/update.
create or replace function public.admin_upsert_chat_filter_word(
  p_id bigint,
  p_term text,
  p_match_mode text default 'word',
  p_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_term text := btrim(public.ok_chat_filter_norm(p_term));
  v_mode text := case when p_match_mode = 'contains' then 'contains' else 'word' end;
begin
  if auth.uid() is null or not public.is_current_user_admin() then
    return jsonb_build_object('ok', false, 'error', 'admin_required');
  end if;
  if char_length(v_term) < 2 or char_length(v_term) > 48 then
    return jsonb_build_object('ok', false, 'error', 'invalid_term');
  end if;

  if p_id is not null and p_id > 0 then
    update public.chat_banned_words
       set term = v_term,
           match_mode = v_mode,
           active = coalesce(p_active, true),
           updated_at = now()
     where id = p_id
     returning id into v_id;
  end if;

  if v_id is null then
    insert into public.chat_banned_words(term, match_mode, active, created_by)
    values (v_term, v_mode, coalesce(p_active, true), auth.uid())
    on conflict (term) do update
      set match_mode = excluded.match_mode,
          active = excluded.active,
          updated_at = now()
    returning id into v_id;
  end if;

  if v_id is null then
    select id
      into v_id
      from public.chat_banned_words
     where term = v_term
     limit 1;
  end if;

  return jsonb_build_object('ok', v_id is not null, 'id', v_id);
end;
$$;

revoke execute on function public.admin_upsert_chat_filter_word(bigint, text, text, boolean) from public, anon, authenticated;
grant execute on function public.admin_upsert_chat_filter_word(bigint, text, text, boolean) to authenticated;
