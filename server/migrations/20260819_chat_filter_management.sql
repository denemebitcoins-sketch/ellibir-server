-- Online Kahvem - central chat filter management (2026-08-19)
-- One Supabase-managed word list for lobby chat, direct messages and Colyseus table chat.

create table if not exists public.chat_banned_words (
  id bigint generated always as identity primary key,
  term text not null unique,
  match_mode text not null default 'word' check (match_mode in ('word', 'contains')),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(btrim(term)) between 2 and 48)
);

create index if not exists chat_banned_words_active_idx
  on public.chat_banned_words(active, term);

alter table public.chat_banned_words enable row level security;
revoke all on public.chat_banned_words from public, anon, authenticated;
grant select on public.chat_banned_words to authenticated;
grant all on public.chat_banned_words to service_role;

create or replace function public.ok_chat_filter_norm(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select lower(translate(coalesce(p_text, ''), 'Iİ', 'ıi'));
$$;

create or replace function public.ok_chat_filter_regex_escape(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select regexp_replace(coalesce(p_text, ''), '([.\+*?\[^]$(){}=!<>|:\-])', '\\\1', 'g');
$$;

create or replace function public.apply_chat_filter(p_text text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  w record;
  v_text text := coalesce(p_text, '');
  v_term text;
  v_pattern text;
begin
  if v_text = '' then
    return v_text;
  end if;

  for w in
    select term, match_mode
      from public.chat_banned_words
     where active = true
     order by char_length(term) desc, term asc
  loop
    v_term := public.ok_chat_filter_regex_escape(btrim(w.term));
    if char_length(v_term) < 2 then
      continue;
    end if;

    if w.match_mode = 'contains' then
      v_text := regexp_replace(v_text, v_term, '***', 'gi');
    else
      v_pattern := '(^|[^[:alnum:]_çğıöşüÇĞİÖŞÜ])(' || v_term || ')($|[^[:alnum:]_çğıöşüÇĞİÖŞÜ])';
      v_text := regexp_replace(v_text, v_pattern, '\1***\3', 'gi');
    end if;
  end loop;

  return v_text;
end;
$$;

revoke execute on function public.apply_chat_filter(text) from public, anon, authenticated;
grant execute on function public.apply_chat_filter(text) to service_role;

create or replace function public.chat_filter_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'lobby_chat' then
    if coalesce(new.kind, 'msg') = 'msg' then
      new.text := public.apply_chat_filter(new.text);
    end if;
    return new;
  end if;

  if tg_table_name = 'direct_messages' then
    if coalesce(new.kind, 'msg') = 'msg' then
      new.text := public.apply_chat_filter(new.text);
    end if;
    return new;
  end if;

  return new;
end;
$$;

revoke all on function public.chat_filter_before_insert() from public;

drop trigger if exists trg_lobby_chat_filter_text on public.lobby_chat;
create trigger trg_lobby_chat_filter_text
before insert on public.lobby_chat
for each row execute function public.chat_filter_before_insert();

drop trigger if exists trg_direct_messages_filter_text on public.direct_messages;
create trigger trg_direct_messages_filter_text
before insert on public.direct_messages
for each row execute function public.chat_filter_before_insert();

create or replace function public.admin_list_chat_filter_words()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_current_user_admin() then
    return jsonb_build_object('ok', false, 'error', 'admin_required', 'words', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'ok', true,
    'words', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'term', term,
        'match_mode', match_mode,
        'active', active,
        'updated_at', updated_at
      ) order by term asc)
      from public.chat_banned_words
    ), '[]'::jsonb)
  );
end;
$$;

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
       set term = v_term, match_mode = v_mode, active = coalesce(p_active, true), updated_at = now()
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

create or replace function public.admin_delete_chat_filter_word(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
begin
  if auth.uid() is null or not public.is_current_user_admin() then
    return jsonb_build_object('ok', false, 'error', 'admin_required');
  end if;

  delete from public.chat_banned_words where id = p_id;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('ok', v_deleted > 0, 'deleted', v_deleted);
end;
$$;

revoke execute on function public.admin_list_chat_filter_words() from public, anon, authenticated;
revoke execute on function public.admin_upsert_chat_filter_word(bigint, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.admin_delete_chat_filter_word(bigint) from public, anon, authenticated;
grant execute on function public.admin_list_chat_filter_words() to authenticated;
grant execute on function public.admin_upsert_chat_filter_word(bigint, text, text, boolean) to authenticated;
grant execute on function public.admin_delete_chat_filter_word(bigint) to authenticated;
