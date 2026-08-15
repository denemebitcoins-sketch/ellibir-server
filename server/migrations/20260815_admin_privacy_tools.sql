-- Online Kahvem - admin privacy/search tools (2026-08-15)
-- Keeps admin authority server-side while allowing admins to hide the visible badge.

begin;

alter table public.profiles
  add column if not exists admin_badge_hidden boolean not null default false;

alter table public.presence
  add column if not exists admin_badge_hidden boolean not null default false;

create or replace function public.presence_enforce_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare p record;
begin
  new.last_seen := now();
  select name, gender, role, chips, vip_until, avatar_url, avatar_status,
         allow_dm, allow_friend_req, invite_pref, gift_off, admin_badge_hidden
    into p
    from public.profiles
   where id::text = new.user_id::text;

  if found then
    new.name := coalesce(nullif(p.name, ''), 'Oyuncu');
    new.gender := p.gender;
    new.role := case
      when p.role = 'admin' then 'admin'
      when p.vip_until is not null and p.vip_until > now() then 'vip'
      else 'normal'
    end;
    new.admin_badge_hidden := p.role = 'admin' and coalesce(p.admin_badge_hidden, false);
    new.chips := greatest(coalesce(p.chips, 0), 0);
    new.avatar_url := case
      when coalesce(p.avatar_status, 'visible') = 'visible' then p.avatar_url
      else null
    end;
    new.allow_dm := coalesce(p.allow_dm, true);
    new.allow_friend_req := coalesce(p.allow_friend_req, true);
    new.invite_pref := case when p.invite_pref in ('open','friends','closed')
                            then p.invite_pref else 'open' end;
    new.gift_off := coalesce(p.gift_off, false);
  end if;
  return new;
end;
$$;
revoke all on function public.presence_enforce_profile() from public;

drop trigger if exists trg_presence_touch on public.presence;
drop trigger if exists trg_presence_enforce_profile on public.presence;
create trigger trg_presence_enforce_profile
before insert or update on public.presence
for each row execute function public.presence_enforce_profile();

create or replace function public.set_admin_badge_hidden(p_hidden boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_current_user_admin() then
    return jsonb_build_object('ok', false, 'error', 'admin_required');
  end if;

  update public.profiles
     set admin_badge_hidden = coalesce(p_hidden, false)
   where id::text = auth.uid()::text
     and role = 'admin';

  return jsonb_build_object('ok', true, 'admin_badge_hidden', coalesce(p_hidden, false));
end;
$$;

create or replace function public.record_profile_view(p_target text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'auth_required');
  end if;
  if p_target is null or p_target = '' or p_target = auth.uid()::text then
    return jsonb_build_object('ok', true, 'ignored', true, 'reason', 'self_or_empty');
  end if;
  if public.is_current_user_admin() then
    return jsonb_build_object('ok', true, 'ignored', true, 'reason', 'admin_view');
  end if;

  insert into public.profile_views(viewer_id, target_id)
  values (auth.uid()::text, p_target);

  return jsonb_build_object('ok', true, 'ignored', false);
end;
$$;

create or replace function public.ok_search_norm(p_text text)
returns text
language sql
immutable
as $$
  select regexp_replace(
    replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
      lower(coalesce(p_text, '')),
      'ı', 'i'), 'İ', 'i'), 'ç', 'c'), 'ğ', 'g'), 'ö', 'o'), 'ş', 's'), 'ü', 'u'),
      'â', 'a'), 'î', 'i'), 'û', 'u'),
    '[^a-z0-9]+', '', 'g'
  );
$$;

create or replace function public.ok_search_consonants(p_text text)
returns text
language sql
immutable
as $$
  select regexp_replace(public.ok_search_norm(p_text), '[aeiou]+', '', 'g');
$$;

create or replace function public.admin_search_profiles(p_query text)
returns table(
  id text,
  name text,
  avatar_url text,
  role text,
  gender text,
  admin_badge_hidden boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q_norm text := public.ok_search_norm(p_query);
  q_cons text := public.ok_search_consonants(p_query);
begin
  if not public.is_current_user_admin() then
    return;
  end if;
  if length(q_norm) < 2 then
    return;
  end if;

  return query
  select p.id::text,
         coalesce(p.name, '') as name,
         p.avatar_url,
         coalesce(p.role, 'normal') as role,
         p.gender,
         (coalesce(p.role, 'normal') = 'admin' and coalesce(p.admin_badge_hidden, false)) as admin_badge_hidden
    from public.profiles p
   where public.ok_search_norm(p.name) like '%' || q_norm || '%'
      or (length(q_cons) >= 2 and public.ok_search_consonants(p.name) like '%' || q_cons || '%')
   order by
      case
        when public.ok_search_norm(p.name) = q_norm then 0
        when public.ok_search_norm(p.name) like q_norm || '%' then 1
        when public.ok_search_consonants(p.name) like q_cons || '%' then 2
        else 3
      end,
      p.name asc
   limit 30;
end;
$$;

revoke execute on function public.set_admin_badge_hidden(boolean) from public, anon;
revoke execute on function public.record_profile_view(text) from public, anon;
revoke execute on function public.ok_search_norm(text) from public, anon;
revoke execute on function public.ok_search_consonants(text) from public, anon;
revoke execute on function public.admin_search_profiles(text) from public, anon;
grant execute on function public.set_admin_badge_hidden(boolean) to authenticated;
grant execute on function public.record_profile_view(text) to authenticated;
grant execute on function public.admin_search_profiles(text) to authenticated;

commit;
