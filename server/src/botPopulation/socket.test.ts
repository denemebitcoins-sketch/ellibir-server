import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client, Room as ClientRoom } from '@colyseus/sdk';
import { PopulationStorage } from './storage';
import { PopulationDirector, PopulationTablePlan } from './director';
import { ColyseusPopulationProvider } from './colyseusProvider';
import { EllibirRoom } from '../rooms/EllibirRoom';
import { IhaleRoom } from '../rooms/IhaleRoom';
import { OkeyRoom } from '../rooms/OkeyRoom';
import { TavlaRoom } from '../rooms/TavlaRoom';

const ids=vi.hoisted(()=>({owner:'90000000-0000-4000-8000-000000000001',human:'90000000-0000-4000-8000-000000000002'}));
vi.mock('../supabase',async original=>({
  ...await original<typeof import('../supabase')>(),
  requireVerifiedUser:vi.fn(async(token:string)=>{if(token!=='local-valid-token')throw new Error('auth_required');return ids.human;}),
  isGameBanned:vi.fn(async()=>false), fetchCanak:vi.fn(async()=>0),
  resolveClientProfileMeta:vi.fn(async()=>({name:'Local tester',role:'normal',gender:'e',adminBadgeHidden:false})),
  keepSeatPresence:vi.fn(async()=>{}),clearSeatPresence:vi.fn(async()=>{}),
  deductEntry:vi.fn(async()=>{throw new Error('legacy_wallet_forbidden');}),
  settleMatch:vi.fn(async()=>{throw new Error('legacy_wallet_forbidden');}),
}));
let db:PGlite,storage:PopulationStorage,server:Server,endpoint:string;
let joined:ClientRoom[]=[];
beforeAll(async()=>{
  db=await PGlite.create();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create function auth.role() returns text language sql as $$select 'service_role'::text$$;
    create table public.profiles(id uuid primary key,chips bigint not null);`);
  for(const name of ['01_bot_population_storage','02_bot_population_matches','03_bot_population_room_hosts','04_bot_population_admin','05_bot_population_presence'])
    await db.exec(readFileSync(resolve(__dirname,`../../migrations/20260917_${name}.sql`),'utf8'));
  storage=new PopulationStorage(async(name,args)=>{
    if(!/^bot_population_[a-z_]+$/.test(name))throw new Error('invalid_rpc');
    const r=await db.query<{value:any}>(`select public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(',')}) value`,
      Object.values(args).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v));
    return r.rows[0].value;
  });
  const app=express(); app.use(express.json()); app.get('/health',(_req,res)=>res.json({ok:true}));
  const http=createServer(app);
  server=new Server({transport:new WebSocketTransport({server:http}),greet:false});
  server.define('ellibir',EllibirRoom).filterBy(['mode','table']);
  server.define('ihale',IhaleRoom).filterBy(['mode','table']);
  server.define('okey',OkeyRoom).filterBy(['mode','table','variant']);
  server.define('tavla',TavlaRoom).filterBy(['mode','table']);
  await server.listen(0,'127.0.0.1');
  endpoint=`http://127.0.0.1:${(http.address() as AddressInfo).port}`;
},30000);
beforeEach(async()=>{
  joined=[];
  await db.exec(`truncate bot_population.match_wallet_entries,bot_population.match_seats,bot_population.matches,
    bot_population.leases,bot_population.ledger,bot_population.characters,bot_population.control_events,
    bot_population.room_hosts,bot_population.room_host_events,bot_population.runtime_health,public.profiles;
    update bot_population.control set mode='off',max_active=24,revision=0;`);
  await db.query('insert into public.profiles(id,chips)values($1,20000)',[ids.human]);
  await storage.seed();await storage.control(0,'running',24,'test');
});
afterEach(async()=>{
  for(const client of joined)if(client.connection.isOpen)try{await client.leave(true);}catch{}
  await Promise.all(matchMaker.disconnectAll());
});
afterAll(async()=>{await server?.gracefullyShutdown(false);await db?.close();});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test:()=>boolean,timeout=8000){const until=Date.now()+timeout;while(!test()){if(Date.now()>until)throw new Error('socket_condition_timeout');await delay(25);}}
describe('real SDK + websocket population tables (isolated auth and SQL)',()=>{
  it.each(['51','ihale','duz','banko','yuzbir','tavla'] as const)('joins %s, receives bot disclosure and preserves an active match during drain',async game=>{
    const p:PopulationTablePlan={key:`${game}:solo:2`,game,team:false,table:2,bet:500,kind:'waiting',waitingBots:game==='tavla'?1:2};
    const provider=new ColyseusPopulationProvider();
    const director=new PopulationDirector(storage,ids.owner,[p],provider,1);
    await director.tick();
    const host=(await storage.rooms())[0];
    const room:any=matchMaker.getLocalRoomById(host.room_id!);
    expect(room.populationInviteSeat(ids.human)).toBe(-1);
    const client=new Client(endpoint);
    await expect(client.joinById(host.room_id!,{token:'local-valid-token'})).rejects.toThrow('5.7');
    expect(room.seats.size).toBe(0);
    const connection=await client.joinById(host.room_id!,{token:'local-valid-token',name:'ignored',seat:game==='tavla'?1:2,ihalePilotVersion:1,populationVersion:1});
    joined.push(connection);
    const messages:any[]=[];connection.onMessage('*',(type,message)=>messages.push({type,message}));
    room.pushViews();
    await until(()=>messages.some(m=>m.type==='view'));
    const view=messages.find(m=>m.type==='view').message;
    expect(JSON.stringify(view)).toContain('bot:b0700000-0000-4000-8000-');
    expect(JSON.stringify(view)).not.toContain(ids.owner);
    expect(JSON.stringify(view)).not.toContain('local-valid-token');
    if(game!=='tavla'){
      const target=await provider.inviteTarget(ids.human);
      expect(target).toEqual({key:p.key,seat:3});
      expect(await provider.inviteTarget('forged')).toBeNull();
      await director.invite(director.status().lobby[0],target!.key,target!.seat);
    }
    await until(()=>!!room.game);
    expect((await storage.adminReport()).summary.active_matches).toBe(1);
    expect(Number((await db.query<{chips:string}>('select chips from public.profiles where id=$1',[ids.human])).rows[0].chips)).toBe(19500);
    const seat=game==='tavla'?1:2;
    const reconnectToken=connection.reconnectionToken;
    const abandoned=()=>game==='51'||game==='ihale'?room.game.abandoned?.includes(seat):room.abandoned.has(seat);
    connection.reconnection.enabled=false;
    joined=joined.filter(r=>r!==connection);
    connection.connection.close(4010,'local network-drop test');
    await until(abandoned);
    const resumed=await client.reconnect(reconnectToken);
    joined.push(resumed);resumed.onMessage('*',(type,message)=>messages.push({type,message}));
    await until(()=>!abandoned());
    expect(room.seats.get(resumed.sessionId)).toBe(seat);
    expect(Number((await db.query<{chips:string}>('select chips from public.profiles where id=$1',[ids.human])).rows[0].chips)).toBe(19500);
    await storage.control(1,'draining',24,'test');
    await director.tick();
    expect(room.population.status().phase).toBe('playing');
    expect(await provider.inviteTarget(ids.human)).toBeNull();
    expect(await storage.completeDrain()).toBe(false);
    room.pushViews();await delay(40);
    expect(messages.filter(m=>m.type==='view').length).toBeGreaterThan(1);
  },20000);
});
