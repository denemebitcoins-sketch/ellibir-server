import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchMaker } from '@colyseus/core';
import { ColyseusPopulationProvider } from './colyseusProvider';
import { PopulationStorage, PopulationRpc, PopulationGame } from './storage';
import { PopulationDirector, PopulationTablePlan } from './director';
import { defaultPopulationPlans } from './runtime';
import { initialCharacters } from './characters';
import { EllibirRoom } from '../rooms/EllibirRoom';
import { IhaleRoom } from '../rooms/IhaleRoom';
import { OkeyRoom } from '../rooms/OkeyRoom';
import { TavlaRoom } from '../rooms/TavlaRoom';

vi.mock('../supabase', async original => ({ ...await original<typeof import('../supabase')>(), fetchCanak: vi.fn(async () => 0) }));
let db: PGlite;
let storage: PopulationStorage;
let intercept: ((name: string, result: any) => Promise<void>) | null = null;
const owner = '00000000-0000-4000-8000-000000000001';
const next = '00000000-0000-4000-8000-000000000002';
const pool = initialCharacters();
const rpc: PopulationRpc = async (name, args) => {
  if (!/^bot_population_[a-z_]+$/.test(name)) throw new Error('invalid_rpc');
  const keys = Object.keys(args);
  const r = await db.query<{ value: any }>(`select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(',')}) value`,
    Object.values(args).map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
  if (intercept) await intercept(name, r.rows[0].value);
  return r.rows[0].value;
};
const plan = (game: PopulationGame = 'ihale', table = 1): PopulationTablePlan => ({ key: `${game}:solo:${table}`, game,
  team: false, bet: 1500, table, kind: 'waiting', waitingBots: 1 });
beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
    create function auth.role() returns text language sql as $$select 'service_role'::text$$;
    create table public.profiles(id uuid primary key, chips bigint not null);`);
  for (const f of ['20260917_01_bot_population_storage.sql', '20260917_02_bot_population_matches.sql', '20260917_03_bot_population_room_hosts.sql', '20260917_08_bot_population_lock_time.sql'])
    await db.exec(readFileSync(resolve(__dirname, '../../migrations', f), 'utf8'));
  storage = new PopulationStorage(rpc);
  await matchMaker.setup();
  await matchMaker.accept(true);
  matchMaker.defineRoomType('ellibir', EllibirRoom).filterBy(['mode', 'table']);
  matchMaker.defineRoomType('ihale', IhaleRoom).filterBy(['mode', 'table']);
  matchMaker.defineRoomType('okey', OkeyRoom).filterBy(['mode', 'table', 'variant']);
  matchMaker.defineRoomType('tavla', TavlaRoom).filterBy(['mode', 'table']);
}, 30000);
beforeEach(async () => {
  intercept = null;
  await db.exec(`truncate bot_population.match_wallet_entries, bot_population.match_seats, bot_population.matches,
    bot_population.leases, bot_population.ledger, bot_population.characters, bot_population.control_events,
    bot_population.room_hosts, bot_population.room_host_events, public.profiles;
    update bot_population.control set mode='off',max_active=16,revision=0;`);
  await storage.seed(); await storage.control(0, 'running', 16, 'test');
});
afterEach(async () => { intercept = null; await Promise.all(matchMaker.disconnectAll()); });
afterAll(async () => { await matchMaker.gracefullyShutdown(); await db?.close(); });

describe('actual Colyseus room provisioning with current authority migrations', () => {
  it('changes table after retirement, skips human tables and keeps one distributed quota', async () => {
    const existing = await matchMaker.handleCreateRoom('ihale', {mode:'solo',table:1,bet:1000});
    const provider = new ColyseusPopulationProvider(() => 0.99);
    const p = {...plan(), key:'ihale:showcase', tablePool:[1,2,3]};
    const first = (await provider.open(p, storage, owner))!;
    expect((await storage.rooms())[0].table_no).toBe(2);
    const other = new ColyseusPopulationProvider(() => 0);
    expect(await other.open(p, storage, next)).toBeNull();
    expect(await storage.rooms()).toHaveLength(1);
    await first.retire(); await provider.retired(first); await provider.close(first);
    const second = (await provider.open(p, storage, owner))!;
    expect((await storage.rooms())[0]).toMatchObject({room_key:p.key,table_no:3});
    expect(second).not.toBe(first);
    expect((await matchMaker.query()).some(r => r.roomId === existing.roomId)).toBe(true);
  });
  it('leaves busy tables alone instead of evicting humans to satisfy a quota', async () => {
    for (const table of [1,2]) await matchMaker.handleCreateRoom('ihale', {mode:'solo',table,bet:1000});
    const provider = new ColyseusPopulationProvider();
    expect(await provider.open({...plan(),key:'ihale:showcase',tablePool:[1,2]},storage,owner)).toBeNull();
    expect(await storage.rooms()).toEqual([]);
    expect(await matchMaker.query()).toHaveLength(2);
  });
  it('recovers a rotating quota in place after a lost publish response, without a second allocation', async () => {
    const provider = new ColyseusPopulationProvider(() => 0.99);
    const p = {...plan(),key:'ihale:showcase',tablePool:[2,3]};
    intercept = async name => {if (name === 'bot_population_publish_room') {intercept=null;throw new Error('lost_publish');}};
    const session = await provider.open(p,storage,owner);
    expect(session).toBeTruthy();
    expect(await provider.open(p,storage,owner)).toBe(session);
    expect(await storage.rooms()).toHaveLength(1);
    expect(await matchMaker.query()).toHaveLength(1);
  });
  it('keeps six partial waiting tables and reserves, never starting a bots-only game', async () => {
    vi.useFakeTimers();
    let now = Date.now();
    const director = new PopulationDirector(storage,owner,defaultPopulationPlans(),new ColyseusPopulationProvider(),3,() => now);
    try {
      await storage.control(1,'running',60,'test');
      await director.tick();
      expect(director.status().errors).toEqual([]);
      expect(director.status().tables).toHaveLength(6);
      expect(director.status().lobby).toHaveLength(3);
      for (const game of ['51','duz','banko','yuzbir','ihale','tavla']) {
        const table = director.status().tables.find(t => t.key === `${game}:waiting`)!;
        expect(table.bots).toBe(game === 'tavla' ? 1 : game === '51' || game === 'duz' ? 3 : 2);
        const host = (await storage.rooms()).find(h => h.room_key === table.key)!;
        expect((matchMaker.getLocalRoomById(host.room_id!) as any).startTimer, game).toBeFalsy();
      }
      expect((await storage.snapshot()).leases).toHaveLength(16);
      expect(director.status()).toMatchObject({target_active:16,active_limit:60,capacity_limited:false});
      await director.tick();
      expect((await storage.snapshot()).leases).toHaveLength(16);
      await vi.advanceTimersByTimeAsync(7100);
      expect(director.status().tables.filter(t => t.phase === 'playing')).toHaveLength(0);
      const before = await storage.rooms();
      const previousIds = (await storage.snapshot()).leases.map(l => l.character_id);
      now += 301000;
      await director.tick();
      expect(director.status().tables).toHaveLength(0);
      now += 61000;
      await director.tick();
      expect(director.status().tables).toHaveLength(6);
      for (const room of await storage.rooms()) {
        expect(room.table_no).not.toBe(before.find(r => r.room_key === room.room_key)!.table_no);
      }
      expect((await storage.snapshot()).leases.every(l => !previousIds.includes(l.character_id))).toBe(true);
      expect(director.status().tables.every(t => t.phase === 'waiting')).toBe(true);
    } finally {
      await Promise.all(matchMaker.disconnectAll());
      vi.useRealTimers();
    }
  });
  it('preserves invite reserves under a low cap and never opens a showcase', async () => {
    vi.useFakeTimers();
    try {
      await storage.control(1,'running',10,'test');
      const director = new PopulationDirector(storage,owner,defaultPopulationPlans(),new ColyseusPopulationProvider(),3);
      await director.tick();
      expect(director.status().errors).toEqual([]);
      expect(director.status().lobby).toHaveLength(3);
      expect(director.status()).toMatchObject({target_active:16,active_limit:10,capacity_limited:true});
      expect(director.status().tables.some(t => t.key.endsWith(':showcase'))).toBe(false);
      expect((await storage.snapshot()).leases.length).toBeLessThanOrEqual(10);
    } finally {
      await Promise.all(matchMaker.disconnectAll());vi.useRealTimers();
    }
  });
  it.each(['51','ihale','duz','banko','yuzbir','tavla'] as const)('creates, binds and retires %s before any simulated player joins', async game => {
    const provider = new ColyseusPopulationProvider();
    const p = plan(game);
    const session = await provider.open(p, storage, owner);
    expect(session).not.toBeNull();
    expect(session!.bet).toBe(1500);
    await session!.reserve(pool[0].id, 0);
    expect(session!.size).toBe(1);
    const hosts = await storage.rooms();
    expect(hosts).toHaveLength(1); expect(hosts[0].room_id).toBeTruthy();
    expect((await matchMaker.query()).map(r => r.roomId)).toContain(hosts[0].room_id);
    expect(await provider.open(p, storage, owner)).toBe(session);
    await provider.heartbeat();
    expect(await session!.retire()).toBe(true);
    await provider.retired(session!); await provider.close(session!);
    expect(await storage.rooms()).toEqual([]);
    expect((await storage.snapshot()).leases).toEqual([]);
    expect(await matchMaker.query()).toEqual([]);
  });
  it('preserves an existing normal room and does not claim or disconnect it', async () => {
    const existing = await matchMaker.handleCreateRoom('ihale', { mode: 'solo', table: 1, bet: 1000 });
    const provider = new ColyseusPopulationProvider();
    expect(await provider.open(plan(), storage, owner)).toBeNull();
    expect(await storage.rooms()).toEqual([]);
    expect((await matchMaker.query()).map(r => r.roomId)).toEqual([existing.roomId]);
  });
  it('does not honor JSON-shaped population capabilities from client options', async () => {
    const listing = await matchMaker.handleCreateRoom('ihale', { mode: 'solo', table: 1, bet: 1000,
      _populationBinding: { owner, key: plan().key, bet: 5000, storage: {} } });
    const room: any = matchMaker.getLocalRoomById(listing.roomId);
    expect(room.population).toBeNull(); expect(room.bet).toBe(1000);
  });
  it('recovers a lost publish reply without another room and blocks a second owner', async () => {
    const provider = new ColyseusPopulationProvider();
    intercept = async name => { if (name === 'bot_population_publish_room') { intercept = null; throw new Error('lost_publish'); } };
    const session = await provider.open(plan(), storage, owner);
    expect(session).toBeTruthy(); expect(await matchMaker.query()).toHaveLength(1);
    const other = new ColyseusPopulationProvider();
    expect(await other.open(plan(), storage, next)).toBeNull();
    expect(await matchMaker.query()).toHaveLength(1);
  });
  it('retains an unpublished room across both lost publication and failed reconciliation', async () => {
    const provider = new ColyseusPopulationProvider();
    intercept = async name => {
      if (name === 'bot_population_publish_room') throw new Error('lost_publish');
      if (name === 'bot_population_get_rooms') { intercept = null; throw new Error('lookup_down'); }
    };
    await expect(provider.open(plan(), storage, owner)).rejects.toThrow('lookup_down');
    const roomId = (await matchMaker.query())[0].roomId;
    const session = await provider.open(plan(), storage, owner);
    expect(session).toBeTruthy(); expect((await matchMaker.query()).map(r => r.roomId)).toEqual([roomId]);
  });
  it('a new owner replaces only the expired recorded room; stale heartbeats cannot erase its lease', async () => {
    const old = new ColyseusPopulationProvider();
    const session = (await old.open(plan(), storage, owner))!;
    await session.reserve(pool[0].id, 0);
    const oldId = (await storage.rooms())[0].room_id;
    await db.exec("update bot_population.leases set expires_at=now()-interval '1 second'");
    await db.exec("update bot_population.room_hosts set expires_at=now()-interval '1 second'");
    const replacement = new ColyseusPopulationProvider();
    expect(await replacement.open(plan(), storage, next)).toBeTruthy();
    expect((await matchMaker.query()).some(r => r.roomId === oldId)).toBe(false);
    await expect(old.heartbeat()).rejects.toThrow('room_lease_lost');
    expect((await storage.rooms())[0].owner_id).toBe(next);
    expect(await matchMaker.query()).toHaveLength(1);
  });
});
