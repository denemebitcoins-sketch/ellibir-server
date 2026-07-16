-- Online Kahvem live schema compatibility hotfix.
-- public.profiles.id is text in the production project while auth.uid() and
-- the new authority tables use uuid. Rebuild the affected RPC definitions
-- with explicit casts. Safe to run more than once after migrations 1-8.

begin;

do $hotfix$
declare
  v_signature text;
  v_oid regprocedure;
  v_sql text;
begin
  foreach v_signature in array array[
    'public.claim_beta_welcome(text)',
    'public.get_my_moderation_state()',
    'public.begin_rewarded_ad(text)',
    'public.get_rewarded_ad_state(uuid)',
    'public.finalize_rewarded_ad(uuid,text,text,text,numeric)',
    'public.finalize_play_purchase(uuid,text,text,text,text,text,jsonb,jsonb)'
  ] loop
    v_oid := to_regprocedure(v_signature);
    if v_oid is null then
      raise exception 'Required RPC is missing: %. Run migrations 1-8 first.', v_signature;
    end if;

    select pg_get_functiondef(v_oid) into v_sql;
    v_sql := replace(v_sql,
      'where id = v_uid',
      'where id::text = v_uid::text');
    v_sql := replace(v_sql,
      'where id = v_row.user_id',
      'where id::text = v_row.user_id::text');
    v_sql := replace(v_sql,
      'where id = p_user_id',
      'where id::text = p_user_id::text');

    execute v_sql;
  end loop;
end
$hotfix$;

-- Force PostgREST to refresh the function signatures/definitions immediately.
notify pgrst, 'reload schema';

commit;

select 'OK - profile id compatibility hotfix applied' as result;
