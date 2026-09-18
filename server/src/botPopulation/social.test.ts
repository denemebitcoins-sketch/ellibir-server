import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PopulationStorage} from './storage';
import {initialCharacters} from './characters';

let db:PGlite,store:PopulationStorage;
const chars=initialCharacters(),owner='50000000-0000-4000-8000-000000000001';
const token=(n:number)=>`50000000-0000-4000-8000-${String(n+10).padStart(12,'0')}`;
const names=['01_bot_population_storage','02_bot_population_matches','03_bot_population_room_hosts',
  '04_bot_population_admin','05_bot_population_presence','07_bot_population_social'];
beforeAll(async()=>{
  db=await PGlite.create();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table auth.users(id uuid primary key);
    create function public.is_current_user_admin() returns boolean language sql as $$select current_setting('test.admin',true)='on'$$;
    select set_config('request.jwt.claim.role','service_role',false);
    create table public.profiles(id uuid primary key,chips bigint not null);
    create table public.presence(user_id uuid primary key,last_seen timestamptz not null,status text not null default 'lobi');
    create table public.lobby_chat(id bigint generated always as identity primary key,text text);`);
  await db.exec(readFileSync(resolve(__dirname,'../../migrations/20260819_admin_clear_lobby_chat.sql'),'utf8'));
  for(const name of names) await db.exec(readFileSync(resolve(__dirname,`../../migrations/20260917_${name}.sql`),'utf8'));
  await db.exec(readFileSync(resolve(__dirname,'../../migrations/20260918_bot_social_waiting_only.sql'),'utf8'));
  store=new PopulationStorage(async(name,args)=>{
    if(!/^bot_population_[a-z_]+$/.test(name)) throw new Error('invalid_rpc');
    const result=await db.query<{value:any}>(`select public.${name}(${Object.keys(args).map((key,i)=>`${key}=>$${i+1}`).join(',')}) value`,
      Object.values(args).map(v=>v!==null && typeof v==='object'?JSON.stringify(v):v));
    return result.rows[0].value;
  });
},30000);
beforeEach(async()=>{
  await db.exec(`reset role;select set_config('request.jwt.claim.role','service_role',false);
    truncate bot_population.social_seen,bot_population.social_events,bot_population.match_wallet_entries,
      bot_population.match_seats,bot_population.matches,bot_population.leases,bot_population.ledger,
      bot_population.characters,bot_population.control_events,bot_population.room_hosts,
      bot_population.room_host_events,bot_population.runtime_health,public.presence,public.profiles,
      public.lobby_chat,public.lobby_chat_clear_audit,auth.users;
    select set_config('request.jwt.claim.sub','',false);select set_config('test.admin','off',false);
    update bot_population.control set mode='off',max_active=24,revision=0;
    update bot_population.social_control set next_event_at=now(),next_chat_at=now()+interval '8 minutes';`);
  await store.seed();
});
afterAll(async()=>{await db?.close();});
async function process(){return (await db.query<{value:any}>('select public.bot_population_process_social() value')).rows[0].value;}
async function feed(){return (await db.query<{value:any}>('select public.bot_population_public_social() value')).rows.map(r=>r.value);}
async function open(...indices:number[]){
  await store.control(0,'running',24,'admin');
  for(const i of indices) await store.claim(chars[i].id,owner,token(i));
}
async function cooldown(){await db.exec('update bot_population.social_control set next_event_at=now(),next_chat_at=now()');}
async function human(){await db.query("insert into public.presence(user_id,last_seen) values($1,now()) on conflict(user_id) do update set last_seen=now(),status='lobi'",[owner]);}

describe('private authoritative bot community feed',()=>{
  it('is inert while disabled and does not create human identity rows',async()=>{
    expect(await process()).toEqual({emitted:0});expect(await feed()).toEqual([]);
    expect((await db.query('select count(*) count from public.profiles')).rows[0]).toEqual({count:0});
    expect((await db.query('select count(*) count from public.presence')).rows[0]).toEqual({count:0});
  });
  it('tracks arrivals silently without polluting the human feed',async()=>{
    await open(0,1,2);
    expect(await process()).toEqual({emitted:0});expect(await process()).toEqual({emitted:0});
    expect(await feed()).toEqual([]);
    expect((await db.query('select count(*) count from bot_population.social_seen where published_online')).rows[0]).toEqual({count:3});
  });
  it('emits a departure only for a previously announced identity and deduplicates retries',async()=>{
    await open(0,1);await process();
    await store.release(chars[1].id,owner,token(1));
    await cooldown();expect(await process()).toEqual({emitted:0});
    await store.release(chars[0].id,owner,token(0));
    expect(await process()).toEqual({emitted:0});
    await cooldown();expect(await process()).toEqual({emitted:0});
    expect(await feed()).toEqual([]);
  });
  it('does not announce an expired character or a room with expired authority',async()=>{
    await open(0);await db.exec("update bot_population.leases set expires_at=now()-interval '1 second'");
    expect(await process()).toEqual({emitted:0});
    await store.claimRoom('duz:solo:9',owner,token(90),'duz',false,9,500);
    await store.claim(chars[1].id,owner,token(1),{room:'duz:solo:9',seat:0,game:'duz',bet:500});
    await db.exec("update bot_population.room_hosts set expires_at=now()-interval '1 second'");
    expect(await process()).toEqual({emitted:0});
  });
  it('sends only fixed VIP lobby greetings when a human is present, with an eight minute global budget',async()=>{
    await open(0);await process();await cooldown();
    expect(await process()).toEqual({emitted:0});await human();
    expect(await process()).toEqual({emitted:1});expect(await process()).toEqual({emitted:0});
    expect((await feed())[0]).toMatchObject({kind:'bot',role:'vip',text:'Herkese iyi oyunlar.',is_system_bot:true});
    expect((await feed())[0].id).toBeLessThan(0);
    expect(JSON.stringify(await feed())).not.toMatch(/owner|token|initial_chips/);
    const remaining=await db.query<{seconds:number}>('select extract(epoch from next_chat_at-now())::int seconds from bot_population.social_control');
    expect(remaining.rows[0].seconds).toBeGreaterThan(470);
  });
  it('suppresses normal characters, stale humans and draining-mode chat',async()=>{
    await open(1);await process();await cooldown();await human();
    expect(await process()).toEqual({emitted:0});
    await store.claim(chars[0].id,owner,token(0));await process();await cooldown();
    await db.exec("update public.presence set status='offline'");
    expect(await process()).toEqual({emitted:0});await human();
    await db.exec("update public.presence set last_seen=now()-interval '2 minutes'");
    expect(await process()).toEqual({emitted:0});await human();
    await store.control(1,'draining',24,'admin');expect(await process()).toEqual({emitted:0});
  });
  it('caps storage and public history and keeps bot events read-only to authenticated users',async()=>{
    await db.query(`insert into bot_population.social_events(character_id,event,name,role,text)
      select $1,'greeting','Arzu','vip','Herkese iyi oyunlar.' from generate_series(1,220)`,[chars[0].id]);
    await process();expect(await feed()).toHaveLength(12);
    expect((await db.query('select count(*) count from bot_population.social_events')).rows[0]).toEqual({count:200});
    await db.exec("set role authenticated;select set_config('request.jwt.claim.role','authenticated',false)");
    expect(await feed()).toHaveLength(12);
    await expect(process()).rejects.toThrow();
    await expect(db.query('select * from bot_population.social_events')).rejects.toThrow();
    await db.exec("reset role;select set_config('request.jwt.claim.role','anon',false)");
    await expect(feed()).rejects.toThrow('auth_required');
    await expect(process()).rejects.toThrow('service_required');
  });
  it('clears the bot feed through the existing authorized moderation RPC without resetting presence',async()=>{
    await open(0);await human();await cooldown();await process();expect(await feed()).toHaveLength(1);
    await db.query('insert into auth.users values($1)',[owner]);
    await db.exec("insert into public.lobby_chat(text) values('human message')");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
    await db.exec("set role authenticated;select set_config('request.jwt.claim.role','authenticated',false)");
    const rejected=await db.query<{value:any}>('select public.admin_clear_lobby_chat() value');
    expect(rejected.rows[0].value.ok).toBe(false);expect(await feed()).toHaveLength(1);
    await db.exec("select set_config('test.admin','on',false)");
    const cleared=await db.query<{value:any}>('select public.admin_clear_lobby_chat() value');
    expect(cleared.rows[0].value).toEqual({ok:true,cleared_count:1});expect(await feed()).toEqual([]);
    await db.exec("reset role;select set_config('request.jwt.claim.role','service_role',false)");
    expect(await process()).toEqual({emitted:0});
    expect((await db.query('select published_online from bot_population.social_seen where character_id=$1',[chars[0].id])).rows[0])
      .toEqual({published_online:true});
  });
  it('filters already stored arrival and departure events without deleting history',async()=>{
    await db.query(`insert into bot_population.social_events(character_id,event,name,role,text)
      values($1,'joined','Arzu','vip','Arzu joined'),($1,'left','Arzu','vip','Arzu left')`,[chars[0].id]);
    expect(await feed()).toEqual([]);
    expect((await db.query('select count(*) count from bot_population.social_events')).rows[0]).toEqual({count:2});
  });
});
