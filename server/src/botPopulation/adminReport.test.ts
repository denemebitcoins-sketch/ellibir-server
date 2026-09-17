import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PopulationStorage } from './storage';
import { initialCharacters } from './characters';

let db: PGlite;
let store: PopulationStorage;
const uuid = (i: number) => `40000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const owner = uuid(1), room = 'tavla:solo:1', bot = initialCharacters()[0];
const migrations = ['01_bot_population_storage','02_bot_population_matches','03_bot_population_room_hosts','04_bot_population_admin','05_bot_population_presence','06_bot_population_progression']
  .map(f => readFileSync(resolve(__dirname, `../../migrations/20260917_${f}.sql`), 'utf8'));
beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
    create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
    select set_config('request.jwt.claim.role','service_role',false);
    create table public.profiles(id uuid primary key, chips bigint not null);
    create table public.test_progression(uid text,kind text,amount bigint);
    create function public.record_match_stats(p_user_id text,p_won boolean,p_winnings bigint) returns void language sql as $$
      insert into public.test_progression values(p_user_id,'stats',p_winnings)$$;
    create function public.grant_account_xp(p_user_id text,p_source text,p_event_key text,p_base_xp integer,p_game text,p_context jsonb)
      returns jsonb language plpgsql as $$begin
        if current_setting('test.xp_failure',true)='on' then return '{"ok":false}'::jsonb; end if;
        insert into public.test_progression values(p_user_id,'xp',p_base_xp);
        return '{"ok":true}'::jsonb;
      end;$$;`);
  for (const sql of migrations) await db.exec(sql);
  store = new PopulationStorage(async (name, args) => {
    if (!/^bot_population_[a-z_]+$/.test(name)) throw new Error('invalid_rpc');
    const r = await db.query<{ value: any }>(`select public.${name}(${Object.keys(args).map((k,i) => `${k}=>$${i+1}`).join(',')}) value`,
      Object.values(args).map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
    return r.rows[0].value;
  });
}, 30000);
beforeEach(async () => {
  await db.exec(`reset role; select set_config('request.jwt.claim.role','service_role',false);
    select set_config('test.xp_failure','off',false);
    truncate public.test_progression,bot_population.progression_outbox,bot_population.match_wallet_entries,bot_population.match_seats,bot_population.matches,
      bot_population.leases,bot_population.ledger,bot_population.characters,bot_population.control_events,
      bot_population.room_hosts,bot_population.room_host_events,bot_population.runtime_health,public.profiles;
    update bot_population.control set mode='off',max_active=24,revision=0;`);
  await store.seed();
});
afterAll(async () => { await db?.close(); });
async function match(key: string) {
  await store.claimRoom(room,owner,uuid(2),'tavla',false,1,500);
  await store.claim(bot.id,owner,uuid(3),{room,seat:0,game:'tavla',bet:500});
  await db.query('insert into public.profiles(id,chips) values($1,20000) on conflict do nothing',[uuid(4)]);
  return store.beginMatch(key,owner,room,'tavla',500,false,[
    {seat:0,kind:'bot',id:bot.id,token:uuid(3)}, {seat:1,kind:'human',id:uuid(4)},
  ]);
}
describe('private population reporting and global drain', () => {
  it('awards a human winner stats and XP once without repaying chips', async () => {
    await store.control(0,'running',24,'admin'); await match('progression');
    await store.finishMatch('progression',owner,1);
    expect(await store.processProgression()).toEqual({processed:1,failed:0,pending:0});
    expect(await store.processProgression()).toEqual({processed:0,failed:0,pending:0});
    expect((await db.query('select kind,amount from public.test_progression order by kind')).rows)
      .toEqual([{kind:'stats',amount:400},{kind:'xp',amount:65}]);
    expect((await db.query('select chips from public.profiles')).rows).toEqual([{chips:20400}]);
  });
  it('rolls back stats on an XP failure and retries without duplicate stats', async () => {
    await store.control(0,'running',24,'admin'); await match('retry');
    await store.finishMatch('retry',owner,0);
    await db.exec("select set_config('test.xp_failure','on',false)");
    expect(await store.processProgression()).toEqual({processed:0,failed:1,pending:1});
    expect((await db.query('select * from public.test_progression')).rows).toEqual([]);
    await db.exec("select set_config('test.xp_failure','off',false); update bot_population.progression_outbox set retry_at=now()");
    expect(await store.processProgression()).toEqual({processed:1,failed:0,pending:0});
    expect((await db.query('select kind,amount from public.test_progression order by kind')).rows)
      .toEqual([{kind:'stats',amount:0},{kind:'xp',amount:30}]);
  });
  it('does not award stats or XP for a refunded match', async () => {
    await store.control(0,'running',24,'admin'); await match('refunded-progress');
    await store.finishMatch('refunded-progress',owner,null);
    expect(await store.processProgression()).toEqual({processed:0,failed:0,pending:0});
  });
  it('reports the inactive pool without treating initial bankroll as earnings', async () => {
    const r = await store.adminReport();
    expect(r.summary).toMatchObject({pool:100,active:0,bot_net:0,human_net:0,house:0,refill:0});
    expect(r.control.mode).toBe('off');
    expect(r.characters).toHaveLength(100);
    expect(r.characters.every((c:any) => c.state==='offline' && c.net===0)).toBe(true);
  });
  it('counts only completed match net, separates daily topups and conserves the pot', async () => {
    await store.control(0,'running',24,'admin'); await match('settled');
    expect((await store.adminReport()).summary).toMatchObject({bot_net:0,human_net:0,active_matches:1});
    await store.finishMatch('settled',owner,0);
    const r = await store.adminReport();
    expect(r.summary).toMatchObject({bot_net:400,human_net:-500,house:100,matches:1,active_matches:0});
    expect(r.summary.bot_net+r.summary.human_net+r.summary.house).toBe(0);
    expect(r.characters.find((c:any) => c.id===bot.id).net).toBe(400);
    await store.release(bot.id,owner,uuid(3));
    await db.query('update bot_population.characters set chips=90000 where id=$1',[bot.id]);
    await store.refill(bot.id);
    const after = await store.adminReport();
    expect(after.summary.refill).toBeGreaterThan(0);
    expect(after.summary.bot_net).toBe(400);
  });
  it('counts refunds without manufacturing winnings and lists starting humans', async () => {
    await store.control(0,'running',24,'admin'); await match('refund');
    expect((await store.adminReport()).tables[0]).toMatchObject({phase:'playing',humans:1,bots:1});
    await store.finishMatch('refund',owner,null);
    expect((await store.adminReport()).summary).toMatchObject({bot_net:0,human_net:0,house:0,refunds:1});
  });
  it('does not declare global drain complete while another owner has work', async () => {
    await store.control(0,'running',24,'admin'); await match('active');
    await store.control(1,'draining',24,'admin');
    expect(await store.completeDrain()).toBe(false);
    await store.finishMatch('active',owner,null);
    expect(await store.completeDrain()).toBe(false);
    await store.release(bot.id,owner,uuid(3));
    expect(await store.completeDrain()).toBe(false);
    await store.releaseRoom(room,owner,uuid(2));
    expect(await store.completeDrain()).toBe(true);
    expect(await store.completeDrain()).toBe(false);
    expect((await store.snapshot()).control.mode).toBe('off');
  });
  it('redacts lease capabilities, expires health and rejects public readers/writers', async () => {
    await store.health(owner,true,'',{tables:0,lobby:0,errors:[]});
    const r = await store.adminReport();
    expect(r.health[0]).toMatchObject({ready:true,stale:false,error:''});
    expect(JSON.stringify(r)).not.toContain(owner);
    await db.exec("update bot_population.runtime_health set updated_at=now()-interval '1 minute'");
    expect((await store.adminReport()).health[0].stale).toBe(true);
    await db.exec("set role authenticated; select set_config('request.jwt.claim.role','authenticated',false)");
    await expect(store.adminReport()).rejects.toThrow('permission denied');
    await expect(store.health(owner,true,'',{})).rejects.toThrow('permission denied');
    await expect(store.completeDrain()).rejects.toThrow('permission denied');
  });
  it('replaying the migration preserves changed settings', async () => {
    await store.control(0,'running',12,'admin');
    await db.exec(migrations[3]);
    expect((await store.snapshot()).control).toMatchObject({mode:'running',max_active:12,revision:1});
  });
  it('exposes explicit bot presence but no private lease or authentication identity', async () => {
    await store.control(0,'running',24,'admin'); await match('presence');
    await db.exec("set role authenticated; select set_config('request.jwt.claim.role','authenticated',false)");
    const r = await db.query<{value:any}>('select public.bot_population_public_presence() value');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].value).toMatchObject({user_id:'bot:'+bot.id,is_system_bot:true,name:bot.name,
      table_mode:'tavla-solo',table_started:true,table_no:1,table_seat:0,allow_dm:false,allow_friend_req:false,invite_pref:'closed'});
    expect(JSON.stringify(r.rows)).not.toContain(owner);
    expect(JSON.stringify(r.rows)).not.toContain(uuid(3));
    await db.exec("reset role; select set_config('request.jwt.claim.role','service_role',false)");
    await db.exec("update bot_population.room_hosts set expires_at=now()-interval '1 second'");
    expect((await db.query('select public.bot_population_public_presence()')).rows).toHaveLength(0);
    await db.exec("set role anon; select set_config('request.jwt.claim.role','anon',false)");
    await expect(db.query('select public.bot_population_public_presence()')).rejects.toThrow('permission denied');
  });
  it('lobby bots are invitable only while running and disappear after their lease expires', async () => {
    await store.control(0,'running',24,'admin');
    await store.claim(bot.id,owner,uuid(3));
    let r = await db.query<{value:any}>('select public.bot_population_public_presence() value');
    expect(r.rows[0].value).toMatchObject({invite_pref:'open',status:'lobi',table_no:0,table_seat:-1});
    await store.control(1,'draining',24,'admin');
    r = await db.query<{value:any}>('select public.bot_population_public_presence() value');
    expect(r.rows[0].value.invite_pref).toBe('closed');
    await db.exec("update bot_population.leases set expires_at=now()-interval '1 second'");
    expect((await db.query('select public.bot_population_public_presence()')).rows).toHaveLength(0);
  });
  it('a restart during drain refunds only fully expired orphan tables and can finish shutting down', async () => {
    await store.control(0,'running',24,'admin');await match('cold-drain');
    await store.control(1,'draining',24,'admin');
    await db.exec("update bot_population.room_hosts set expires_at=now()-interval '1 second'");
    expect(await store.recoverExpired()).toBe(0);
    expect((await store.match('cold-drain'))?.state).toBe('active');
    await db.exec("update bot_population.room_hosts set expires_at=now()+interval '45 seconds'");
    await db.exec("update bot_population.leases set expires_at=now()-interval '1 second'");
    await db.exec("update bot_population.room_hosts set expires_at=now()-interval '1 second'");
    expect(await store.recoverExpired()).toBe(1);
    expect((await store.match('cold-drain'))?.state).toBe('refunded');
    expect(await store.recoverExpired()).toBe(0);
    expect(await store.completeDrain()).toBe(true);
    expect((await store.adminReport()).summary).toMatchObject({bot_net:0,human_net:0,house:0,refunds:1});
  });
});
