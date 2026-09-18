import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

let db:PGlite;
const owner='60000000-0000-4000-8000-000000000001';
const other='60000000-0000-4000-8000-000000000002';
const migration=(name:string)=>readFileSync(resolve(__dirname,'../migrations',name),'utf8');
beforeAll(async()=>{
  db=await PGlite.create();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function public.is_current_user_admin() returns boolean language sql as $$select current_setting('test.admin',true)='on'$$;
    create table public.profiles(id text primary key,name text,gender text,chips bigint default 100000,
      diamonds bigint default 0,role text default 'normal',name_changed_at timestamptz,
      matches text,wins text,best_streak text,cur_streak text,total_won text,vip_until text,last_daily text,
      daily_day text,daily_claim_week text,daily_claim_mask text,vip_daily_day text,vip_last_daily text,
      account_level text,account_xp_total text,account_xp_updated_at text,banned text,chat_banned_until text,
      message_banned_until text,game_banned_until text,avatar_status text,recovery_secured_at text);
    alter table public.profiles enable row level security;
    grant usage on schema public,auth to anon,authenticated;
    grant select,insert,update,delete on public.profiles to anon,authenticated;
    create policy profiles_select_authenticated on public.profiles for select to authenticated using(true);
    create policy profiles_insert_own on public.profiles for insert to authenticated with check(id=auth.uid()::text);
    create policy profiles_update_own on public.profiles for update to authenticated using(id=auth.uid()::text) with check(id=auth.uid()::text);
    create policy profiles_admin_update on public.profiles for update to authenticated using(is_current_user_admin()) with check(is_current_user_admin());
    create policy self_write on public.profiles for all using(true) with check(true);`);
  await db.exec(migration('20260820_block_legacy_profile_creation.sql'));
  await db.exec(migration('20260816_profile_username_unique.sql'));
  await db.exec(migration('20260918_profile_write_scope.sql'));
},30000);
beforeEach(async()=>{
  await db.exec("reset role; select set_config('request.jwt.claim.role','service_role',false); select set_config('test.admin','off',false); truncate public.profiles;");
  await db.query('insert into public.profiles(id,name,gender) values($1,$2,$3),($4,$5,$6)',[owner,'Owner','e',other,'Other','k']);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  await db.exec("set role authenticated; select set_config('request.jwt.claim.role','authenticated',false)");
});
afterAll(async()=>{await db?.close();});
it('reproduces the old upsert failure even for an existing authenticated account',async()=>{
  await expect(db.query('insert into public.profiles(id,name) values($1,$2) on conflict(id) do update set name=excluded.name',[owner,'New name']))
    .rejects.toThrow('client_profile_creation_disabled');
});
it('saves name and gender with UPDATE while protecting wallet and role',async()=>{
  const result=await db.query('update public.profiles set name=$2,gender=$3,chips=999999,role=$4 where id=$1 returning name,gender,chips,role',[owner,'New name','k','admin']);
  expect(result.rows).toEqual([{name:'New name',gender:'k',chips:100000,role:'normal'}]);
});
it('cannot edit another profile or erase it; own updates remain available',async()=>{
  expect((await db.query('update public.profiles set name=$2 where id=$1 returning id',[other,'Changed'])).rows).toEqual([]);
  expect((await db.query('delete from public.profiles where id=$1 returning id',[owner])).rows).toEqual([]);
});
it('keeps duplicate name protection',async()=>{
  await expect(db.query('update public.profiles set name=$2 where id=$1',[owner,'Other'])).rejects.toThrow('profiles_name_lower_uniq');
});
it('preserves the dedicated administrator update policy',async()=>{
  await db.exec("select set_config('test.admin','on',false)");
  expect((await db.query('update public.profiles set name=$2 where id=$1 returning name',[other,'Admin edit'])).rows).toEqual([{name:'Admin edit'}]);
});
it('cannot create a ghost profile or update anonymously',async()=>{
  await db.exec("reset role; set role anon; select set_config('request.jwt.claim.role','anon',false)");
  expect((await db.query('update public.profiles set gender=$2 where id=$1 returning id',[owner,'k'])).rows).toEqual([]);
  await expect(db.query('insert into public.profiles(id,name) values($1,$2)',['ghost','Ghost'])).rejects.toThrow();
});
