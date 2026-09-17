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
import { PopulationStorage, PopulationGame } from './storage';
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
let intercept: ((name: string, result: any) => Promise<void>) | null = null;
beforeAll(async()=>{
  db=await PGlite.create();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create function auth.role() returns text language sql as $$select 'service_role'::text$$;
    create table public.profiles(id uuid primary key,chips bigint not null);`);
  for(const name of ['01_bot_population_storage','02_bot_population_matches','03_bot_population_room_hosts','04_bot_population_admin','05_bot_population_presence','08_bot_population_lock_time'])
    await db.exec(readFileSync(resolve(__dirname,`../../migrations/20260917_${name}.sql`),'utf8'));
  storage=new PopulationStorage(async(name,args)=>{
    if(!/^bot_population_[a-z_]+$/.test(name))throw new Error('invalid_rpc');
    const r=await db.query<{value:any}>(`select public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(',')}) value`,
      Object.values(args).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v));
    if(intercept)await intercept(name,r.rows[0].value);
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
  intercept=null;
  await db.exec(`truncate bot_population.match_wallet_entries,bot_population.match_seats,bot_population.matches,
    bot_population.leases,bot_population.ledger,bot_population.characters,bot_population.control_events,
    bot_population.room_hosts,bot_population.room_host_events,bot_population.runtime_health,public.profiles;
    update bot_population.control set mode='off',max_active=24,revision=0;`);
  await db.query('insert into public.profiles(id,chips)values($1,20000)',[ids.human]);
  await storage.seed();await storage.control(0,'running',24,'test');
});
afterEach(async()=>{
  intercept=null;
  for(const client of joined)if(client.connection.isOpen)try{await client.leave(true);}catch{}
  await Promise.all(matchMaker.disconnectAll());
});
afterAll(async()=>{await server?.gracefullyShutdown(false);await db?.close();});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test:()=>boolean,timeout=8000){const until=Date.now()+timeout;while(!test()){if(Date.now()>until)throw new Error('socket_condition_timeout');await delay(25);}}
async function humanTable(game:PopulationGame, options:any={}){
  const name=game==='51'?'ellibir':game==='ihale'?'ihale':game==='tavla'?'tavla':'okey';
  const listing=await matchMaker.handleCreateRoom(name,{mode:game==='tavla'?'solo':'duo',table:7,bet:1000,
    variant:game,rules:{variant:game,totalHands:3,totalEls:3},...options});
  const client=new Client(endpoint);
  const connection=await client.joinById(listing.roomId,{token:'local-valid-token',populationVersion:1,ihalePilotVersion:1,...options});
  joined.push(connection);connection.onMessage('*',()=>{});
  const room:any=matchMaker.getLocalRoomById(listing.roomId);
  await until(()=>room.seats.has(connection.sessionId));
  return {room,connection,client};
}
describe('real SDK + websocket population tables (isolated auth and SQL)',()=>{
  it.each(['51','ihale','duz','banko','yuzbir','tavla'] as const)('adopts a human-created %s table by invitation without changing its rules or transport',async game=>{
    const {room,connection}=await humanTable(game);
    const config=JSON.stringify(room.cfg),roomId=room.roomId;
    const provider=new ColyseusPopulationProvider();
    const director=new PopulationDirector(storage,ids.owner,[],provider,game==='tavla'?1:3);
    await director.tick();
    expect(room.population).toBeNull();expect(await storage.rooms()).toHaveLength(0);
    const invited=[...director.status().lobby];
    for(const id of invited)await director.inviteHuman(ids.human,id);
    expect(room.roomId).toBe(roomId);expect(JSON.stringify(room.cfg)).toBe(config);
    expect(room.seats.get(connection.sessionId)).toBe(0);
    expect((await matchMaker.query()).map(r=>r.roomId)).toEqual([roomId]);
    expect(director.status().tables).toHaveLength(1);
    expect(room.population.size).toBe(invited.length);
    expect(new Set((await storage.snapshot()).leases.map(l=>l.character_id)).size).toBe(invited.length);
    const messages:any[]=[];connection.onMessage('view',view=>messages.push(typeof view==='string'?JSON.parse(view):view));room.pushViews();
    await until(()=>messages.some(v=>v.seated?.filter((s:any)=>s.isSystemBot===true).length===invited.length));
    await until(()=>!!room.game);
    const matches=await db.query<{roster:any;team_mode:boolean;bet:number}>('select roster,team_mode,bet from bot_population.matches');
    expect(matches.rows).toHaveLength(1);
    expect(matches.rows[0]).toMatchObject({team_mode:game!=='tavla',bet:1000});
    expect(matches.rows[0].roster.filter((p:any)=>p.kind==='human')).toEqual([{seat:0,kind:'human',id:ids.human}]);
    expect(Number((await db.query<{chips:string}>('select chips from public.profiles where id=$1',[ids.human])).rows[0].chips)).toBe(19000);
    expect(room.matchRewardsEligible).toBe(false);
    await storage.control(1,'draining',24,'test');await director.tick();
    expect(room.population.activeMatch).toBe(true);expect(connection.connection.isOpen).toBe(true);
  },20000);

  it('refuses adoption for an old client, an unsupported bet, an admin test bot or an unseated inviter',async()=>{
    const {room,connection}=await humanTable('ihale',{populationVersion:0});
    const provider=new ColyseusPopulationProvider();const director=new PopulationDirector(storage,ids.owner,[],provider,1);
    await director.tick();const bot=director.status().lobby[0];
    await expect(director.inviteHuman(ids.human,bot)).rejects.toThrow('population_invite_unavailable');
    room.populationClients.observe(room.clients[0],{populationVersion:1},room.clients);
    room.bet=100;
    await expect(director.inviteHuman(ids.human,bot)).rejects.toThrow('population_invite_unavailable');
    room.bet=1000;room.adminBots.set(1,'Test bot');
    await expect(director.inviteHuman(ids.human,bot)).rejects.toThrow('population_invite_unavailable');
    room.adminBots.clear();
    await expect(director.inviteHuman('forged',bot)).rejects.toThrow('population_invite_unavailable');
    expect(room.population).toBeNull();expect(await storage.rooms()).toHaveLength(0);
    expect(connection.connection.isOpen).toBe(true);expect(director.status().lobby).toEqual([bot]);
  });

  it('rechecks a departure while publishing and releases authority without disconnecting the human room',async()=>{
    const {room,connection}=await humanTable('ihale');
    const provider=new ColyseusPopulationProvider();const director=new PopulationDirector(storage,ids.owner,[],provider,1);
    await director.tick();const bot=director.status().lobby[0];
    intercept=async name=>{if(name==='bot_population_publish_room'){intercept=null;room.seats.delete(connection.sessionId);}};
    await expect(director.inviteHuman(ids.human,bot)).rejects.toThrow('population_invite_unavailable');
    expect(room.population).toBeNull();expect(await storage.rooms()).toHaveLength(0);
    expect(connection.connection.isOpen).toBe(true);expect(director.status().lobby).toEqual([bot]);
    room.seats.set(connection.sessionId,0);
  });

  it('reconciles lost publish replies and prevents two simultaneous invites from double-seating one character',async()=>{
    const {room}=await humanTable('ihale');
    const provider=new ColyseusPopulationProvider();const director=new PopulationDirector(storage,ids.owner,[],provider,1);
    await director.tick();const bot=director.status().lobby[0];
    intercept=async name=>{if(name==='bot_population_publish_room'){intercept=null;throw new Error('lost_publish_reply');}};
    const results=await Promise.allSettled([director.inviteHuman(ids.human,bot),director.inviteHuman(ids.human,bot)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(room.population.size).toBe(1);expect((await storage.snapshot()).leases).toHaveLength(1);
    expect(await storage.rooms()).toHaveLength(1);
    await storage.control(1,'draining',24,'test');await director.tick();
    expect(room.population).toBeNull();expect(room.seats.size).toBe(1);
    expect(await storage.rooms()).toHaveLength(0);expect(director.status().tables).toHaveLength(0);
  });

  it('rolls back an empty adoption when the admin drains while the invitation is being published',async()=>{
    const {room,connection}=await humanTable('ihale');
    const provider=new ColyseusPopulationProvider();const director=new PopulationDirector(storage,ids.owner,[],provider,1);
    await director.tick();const bot=director.status().lobby[0];
    intercept=async name=>{if(name==='bot_population_publish_room'){intercept=null;await storage.control(1,'draining',24,'test');}};
    await expect(director.inviteHuman(ids.human,bot)).rejects.toThrow('population_invite_unavailable');
    expect(room.population).toBeNull();expect(await storage.rooms()).toHaveLength(0);
    expect(connection.connection.isOpen).toBe(true);expect(director.status().tables).toHaveLength(0);
    expect(director.status().lobby).toEqual([bot]);
    expect(Number((await db.query<{chips:string}>('select chips from public.profiles where id=$1',[ids.human])).rows[0].chips)).toBe(20000);
  });

  it('cleans a failed unpublished adoption on the next heartbeat without disconnecting its original room',async()=>{
    const {room,connection}=await humanTable('ihale');
    const provider=new ColyseusPopulationProvider();const director=new PopulationDirector(storage,ids.owner,[],provider,1);
    await director.tick();const bot=director.status().lobby[0];
    const publish=vi.spyOn(storage,'publishRoom').mockRejectedValue(new Error('publish_unavailable'));
    const release=vi.spyOn(storage,'releaseRoom').mockRejectedValue(new Error('release_unavailable'));
    await expect(director.inviteHuman(ids.human,bot)).rejects.toThrow('release_unavailable');
    expect(room.population).toBeNull();expect(await storage.rooms()).toHaveLength(1);
    publish.mockRestore();release.mockRestore();await provider.heartbeat();
    expect(await storage.rooms()).toHaveLength(0);expect(connection.connection.isOpen).toBe(true);
    expect(director.status().lobby).toEqual([bot]);
  });

  it('retires an invited waiting group after its humans leave instead of refilling an unrequested table',async()=>{
    const {room,connection}=await humanTable('ihale');
    let now=Date.now();
    const provider=new ColyseusPopulationProvider();const director=new PopulationDirector(storage,ids.owner,[],provider,1,()=>now,()=>0);
    await director.tick();const bot=director.status().lobby[0];
    await director.inviteHuman(ids.human,bot);
    await connection.leave(true);joined=joined.filter(c=>c!==connection);
    await until(()=>room.seats.size===0);now+=180001;await director.tick();
    expect(director.status().tables).toHaveLength(0);expect(await storage.rooms()).toHaveLength(0);
    expect(await matchMaker.query()).toHaveLength(0);
    expect(director.status().lobby).not.toContain(bot);
  });

  it('does not bind if an older spectator joins during the authority request',async()=>{
    const {room,client,connection}=await humanTable('ihale');
    const provider=new ColyseusPopulationProvider();const director=new PopulationDirector(storage,ids.owner,[],provider,1);
    await director.tick();const bot=director.status().lobby[0];
    intercept=async name=>{
      if(name==='bot_population_publish_room'){
        intercept=null;
        const spectator=await client.joinById(room.roomId,{token:'local-valid-token',spectate:true});
        joined.push(spectator);spectator.onMessage('*',()=>{});
        await until(()=>room.clients.length===2);
      }
    };
    await expect(director.inviteHuman(ids.human,bot)).rejects.toThrow('population_invite_unavailable');
    expect(room.population).toBeNull();expect(await storage.rooms()).toHaveLength(0);
    expect(connection.connection.isOpen).toBe(true);expect(joined.every(c=>c.connection.isOpen)).toBe(true);
  });

  it('detaches after a failed character claim without closing an original room that still has a spectator',async()=>{
    const {room,connection}=await humanTable('ihale');
    const provider=new ColyseusPopulationProvider();const director=new PopulationDirector(storage,ids.owner,[],provider,1);
    await director.tick();const bot=director.status().lobby[0];
    const claim=vi.spyOn(storage,'claim').mockImplementationOnce(async()=>{
      room.seats.delete(connection.sessionId);throw new Error('character_claim_failed');
    });
    try {
      await expect(director.inviteHuman(ids.human,bot)).rejects.toThrow('character_claim_failed');
      expect(room.population).toBeNull();expect(await storage.rooms()).toHaveLength(0);
      expect((await storage.snapshot()).leases).toHaveLength(0);
      expect(connection.connection.isOpen).toBe(true);expect(director.status().tables).toHaveLength(0);
    } finally {claim.mockRestore();room.seats.set(connection.sessionId,0);}
  });

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
