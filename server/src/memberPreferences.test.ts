import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let db: PGlite;
const admin='50000000-0000-4000-8000-000000000001', player='50000000-0000-4000-8000-000000000002';
const device='a'.repeat(64), otherDevice='b'.repeat(64), token='t'.repeat(64);
const sql=(name:string)=>readFileSync(resolve(__dirname,'../migrations/'+name),'utf8');
async function as(uid:string) { await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]); }
beforeAll(async()=>{
  db=await PGlite.create();
  await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'authenticated')$$;
    create table public.profiles(id text primary key,role text,vip_until timestamptz,chips bigint);
    create function public.is_current_user_admin() returns boolean language sql security definer as $$select exists(select 1 from public.profiles where id=auth.uid()::text and role='admin')$$;
    insert into auth.users values('${admin}'),('${player}');
    insert into public.profiles values('${admin}','admin',null,5000),('${player}','vip','2030-01-01',12345);
    grant usage on schema auth to authenticated,anon;
    grant select,update,insert on public.profiles to authenticated;
    grant execute on function auth.uid(),auth.role(),public.is_current_user_admin() to authenticated,anon;`);
  await db.exec(sql('20260716_push_notifications.sql').split('create or replace function public.queue_dm_push()')[0]+'commit;');
  await db.exec(sql('20260918_member_badge_push_preferences.sql'));
  await db.exec("alter table public.profiles add column gift_off boolean default false; alter table public.profiles add column invite_pref text default 'open'; create table public.blocks(blocker uuid,blocked uuid); create table public.friendships(requester uuid,addressee uuid,status text);");
  await db.exec(sql('20260918_gift_privacy.sql'));
  const invite = sql('20260710_social_runtime_contract.sql').match(/create or replace function public\.can_send_invite\(p_to uuid\)[\s\S]*?\$\$;/)![0];
  await db.exec(invite);
},30000);
afterAll(async()=>{await db?.close();});
describe('cosmetic pioneer title and device notification preferences',()=>{
  it('enforces open, friends-only, closed, and block invitation preferences on the server',async()=>{
    await as(admin);
    const can = async()=> (await db.query<{v:boolean}>('select public.can_send_invite($1) v',[player])).rows[0].v;
    expect(await can()).toBe(true);
    await db.query("update public.profiles set invite_pref='friends' where id=$1",[player]);
    expect(await can()).toBe(false);
    await db.query("insert into public.friendships values($1,$2,'accepted')",[admin,player]);
    expect(await can()).toBe(true);
    await db.query("update public.profiles set invite_pref='closed' where id=$1",[player]);
    expect(await can()).toBe(false);
    await db.query("update public.profiles set invite_pref='open' where id=$1",[player]);
    await db.query("insert into public.blocks values($1,$2)",[player,admin]);
    expect(await can()).toBe(false);
  });
  it('rejects disabled or missing gift recipients and permits only service callers',async()=>{
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
    const can = async(ids:string[])=> (await db.query<{v:boolean}>('select public.gift_recipients_allowed($1) v',[ids])).rows[0].v;
    expect(await can([player])).toBe(true);
    await db.query('update public.profiles set gift_off=true where id=$1',[player]);
    expect(await can([player])).toBe(false);
    expect(await can(['missing'])).toBe(false);
    await db.exec("select set_config('request.jwt.claim.role','authenticated',false); set role authenticated");
    await expect(can([admin])).rejects.toThrow('permission denied');
    await db.exec('reset role');
  });
  it('only administrators grant/revoke, without changing role, VIP, or chips',async()=>{
    await as(player);
    expect((await db.query<{v:any}>("select public.admin_set_honorary_title($1,'pioneer') v",[player])).rows[0].v.ok).toBe(false);
    await expect(db.query("update public.profiles set honorary_title='pioneer' where id=$1",[player])).rejects.toThrow('admin_required');
    await as(admin);
    expect((await db.query<{v:any}>("select public.admin_set_honorary_title($1,'pioneer') v",[player])).rows[0].v.ok).toBe(true);
    expect((await db.query('select role,chips,honorary_title,extract(year from vip_until)::int as year from public.profiles where id=$1',[player])).rows)
      .toEqual([{role:'vip',chips:12345,honorary_title:'pioneer',year:2030}]);
    expect((await db.query<{v:any}>("select public.admin_set_honorary_title($1,'admin') v",[player])).rows[0].v.ok).toBe(false);
    await db.query("select public.admin_set_honorary_title($1,'')",[player]);
    expect((await db.query('select role,chips,honorary_title from public.profiles where id=$1',[player])).rows)
      .toEqual([{role:'vip',chips:12345,honorary_title:''}]);
  });
  it('anonymous RPC access is denied and direct client assignment cannot bypass the RPC',async()=>{
    await as(player); await db.exec('set role authenticated');
    await expect(db.query("update public.profiles set honorary_title='pioneer' where id=$1",[player])).rejects.toThrow('admin_required');
    await db.exec('set role anon');
    await expect(db.query("select public.admin_set_honorary_title($1,'pioneer')",[player])).rejects.toThrow('permission denied');
    await expect(db.query("select public.sync_push_device($1,'android',$2,false)",[token,device])).rejects.toThrow('permission denied');
    await db.exec('reset role');
  });
  it('disables only this account and device, supports no-token disable and reenables atomically',async()=>{
    await as(player);
    await db.query("select public.sync_push_device($1,'android',$2,true)",[token,device]);
    await db.query("select public.sync_push_device($1,'android',$2,true)",['u'.repeat(64),otherDevice]);
    await as(admin);
    await db.query("select public.sync_push_device($1,'android',$2,true)",['v'.repeat(64),device]);
    await as(player);
    expect((await db.query<{v:any}>("select public.sync_push_device(null,'android',$1,false) v",[device])).rows[0].v.ok).toBe(true);
    expect((await db.query('select enabled from public.push_devices where token=$1',[token])).rows).toEqual([{enabled:false}]);
    expect((await db.query('select count(*)::int as n from public.push_devices where enabled')).rows).toEqual([{n:2}]);
    await db.query("select public.sync_push_device($1,'android',$2,true)",[token,device]);
    expect((await db.query('select enabled from public.push_devices where token=$1',[token])).rows).toEqual([{enabled:true}]);
    expect((await db.query<{v:any}>("select public.sync_push_device('bad','android',$1,true) v",[device])).rows[0].v.ok).toBe(false);
  });
});
