import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PopulationStorage, PopulationRpc } from './storage';
import { PopulationDirector, PopulationTablePlan } from './director';
import { initialCharacters } from './characters';
import { EllibirRoom } from '../rooms/EllibirRoom';
import { IhaleRoom } from '../rooms/IhaleRoom';
import { OkeyRoom } from '../rooms/OkeyRoom';
import { TavlaRoom } from '../rooms/TavlaRoom';
import { DEFAULT_OKEY_RULES } from '../../../packages/engine/src/okey';
import { DEFAULT_TAVLA_RULES } from '../../../packages/engine/src/tavla';
import { DEFAULT_RULES } from '../../../packages/engine/src/rules';
import { deductEntry, settleMatch } from '../supabase';

vi.mock('../supabase', async original => ({
  ...await original<typeof import('../supabase')>(),
  deductEntry: vi.fn(async () => { throw new Error('legacy_entry_must_not_run'); }),
  settleMatch: vi.fn(async () => { throw new Error('legacy_settlement_must_not_run'); }),
  resolveClientProfileMeta: vi.fn(async (id: string, options: any) => ({ name: options.name || id, role: 'normal', gender: 'e', adminBadgeHidden: false })),
  keepSeatPresence: vi.fn(async () => {}),
  clearSeatPresence: vi.fn(async () => {}),
}));

const owner = '00000000-0000-4000-8000-000000000011';
const pool = initialCharacters();
let db: PGlite;
let storage: PopulationStorage;
let rooms: any[] = [];
let intercept: ((name: string, result: any) => Promise<void>) | null = null;
const rpc: PopulationRpc = async (name, args) => {
  if (!/^bot_population_[a-z_]+$/.test(name)) throw new Error('invalid_rpc');
  const keys = Object.keys(args);
  const r = await db.query<{ result: any }>(`select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(',')}) result`,
    Object.values(args).map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
  if (intercept) await intercept(name, r.rows[0].result);
  return r.rows[0].result;
};

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create function auth.role() returns text language sql as $$select 'service_role'::text$$;
    create table public.profiles(id text primary key, chips bigint not null);`);
  for (const name of ['20260917_01_bot_population_storage.sql', '20260917_02_bot_population_matches.sql'])
    await db.exec(readFileSync(resolve(__dirname, '../../migrations', name), 'utf8'));
}, 30000);
beforeEach(async () => {
  intercept = null; rooms = [];
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'] });
  await db.exec(`truncate bot_population.match_wallet_entries, bot_population.match_seats, bot_population.matches,
    bot_population.leases, bot_population.ledger, bot_population.characters, bot_population.control_events, public.profiles;
    update bot_population.control set mode='off', max_active=16, revision=0;`);
  storage = new PopulationStorage(rpc);
  await storage.seed(); await storage.control(0, 'running', 16, 'local-test');
});
afterEach(async () => {
  intercept = null;
  for (const r of rooms) await r.onDispose();
  await vi.advanceTimersByTimeAsync(700);
  vi.clearAllTimers(); vi.useRealTimers();
});
afterAll(async () => { await db?.close(); });

function makeRoom(Type: typeof EllibirRoom = EllibirRoom) {
  const r: any = new Type(); rooms.push(r);
  Object.defineProperty(r, 'metadata', { get: () => ({ mode: 'duo', table: 1 }) });
  r.cfg = { seed: 123, playerNames: ['A', 'B', 'C', 'D'], botSeats: [],
    rules: { ...DEFAULT_RULES, totalHands: 1, teamMode: true } };
  r.humanSeats = [0, 1, 2, 3]; r.bet = 1000; r.STEP_MS = 1;
  r.refreshCanak = vi.fn();
  r.broadcast = vi.fn();
  const population = r.bindPopulation(storage, owner, `${Type === IhaleRoom ? 'ihale' : '51'}:team:1`);
  return { r, population };
}
function makeOkey(variant: 'duz' | 'banko' | 'yuzbir') {
  const r: any = new OkeyRoom(); rooms.push(r);
  Object.defineProperty(r, 'metadata', { get: () => ({ mode: 'duo', table: 1, variant }) });
  r.cfg = { seed: 123, names: ['A', 'B', 'C', 'D'], botSeats: [],
    rules: { ...DEFAULT_OKEY_RULES, variant, totalEls: 1, teamMode: true } };
  r.humanSeats = [0, 1, 2, 3]; r.bet = 1000; r.STEP_MS = 1;
  r.refreshCanak = vi.fn(); r.broadcast = vi.fn();
  const population = r.bindPopulation(storage, owner, `${variant}:team:1`);
  return { r, population };
}
function makeTavla(seed = 123) {
  const r: any = new TavlaRoom(); rooms.push(r);
  Object.defineProperty(r, 'metadata', { get: () => ({ mode: 'duo', table: 1 }) });
  r.cfg = { seed, names: ['A', 'B'], botSeats: [], rules: { ...DEFAULT_TAVLA_RULES, targetScore: 1 } };
  r.humanSeats = [0, 1]; r.bet = 1000; r.STEP_MS = 1;
  r.refreshCanak = vi.fn(); r.broadcast = vi.fn();
  const population = r.bindPopulation(storage, owner, 'tavla:solo:1');
  return { r, population };
}
async function human(r: any, seat: number) {
  const uid = `human-${seat}`;
  await db.query('insert into public.profiles(id,chips) values($1,20000)', [uid]);
  const c = { sessionId: `sid-${seat}`, auth: uid, send: vi.fn() };
  r.clients.push(c);
  await r.onJoin(c, { requestedSeat: seat, name: `Human ${seat}`, populationVersion:1 });
  return c;
}
async function matches() { return (await db.query<{ match_key: string; state: string; house_amount: number }>('select * from bot_population.matches')).rows; }
async function walletTotal() {
  return Number((await db.query<{ n: string }>(`select ((select coalesce(sum(chips),0) from public.profiles)
    +(select sum(chips) from bot_population.characters))::text n`)).rows[0].n);
}

describe('real 51/Ihale rooms with persistent character seats', () => {
  it.each([EllibirRoom, IhaleRoom])('healthy %s heartbeats preserve the human countdown; recovery resumes once', async Type => {
    const { r, population } = makeRoom(Type);
    await human(r, 0); await human(r, 1);
    await population.reserve(pool[2].id, 2); await population.reserve(pool[3].id, 3);
    await vi.advanceTimersByTimeAsync(7200);
    expect(r.busy).toBe(false);
    expect(r.turnTimer).toBeTruthy();
    const timer = r.turnTimer;
    const deadline = r.ihaleDeadline;
    const engine = vi.spyOn(r, 'runEngine');
    await population.renew(); await population.renew();
    expect(r.turnTimer).toBe(timer);
    expect(r.ihaleDeadline).toBe(deadline);
    expect(engine).not.toHaveBeenCalled();
    intercept = async name => { if (name === 'bot_population_heartbeat') throw new Error('temporary_outage'); };
    await expect(population.renew()).rejects.toThrow('temporary_outage');
    expect(r.turnTimer).toBeNull();
    intercept = null;
    await population.renew();
    await vi.advanceTimersByTimeAsync(10);
    expect(engine).toHaveBeenCalledTimes(1);
    expect(r.turnTimer).toBeTruthy();
    await population.renew();
    expect(engine).toHaveBeenCalledTimes(1);
  });

  it('keeps unverified visitors unseated so they cannot deadlock a paid population table', async () => {
    const { r, population } = makeRoom();
    await population.reserve(pool[0].id, 0);
    const c = { sessionId: 'unverified', send: vi.fn() };
    r.clients.push(c);
    await r.onJoin(c, { requestedSeat: 1, populationVersion:1 });
    expect(r.seats.has(c.sessionId)).toBe(false);
    expect(c.send).toHaveBeenCalledWith('seat', { seat: -1 });
    await r.trySit(c, 1, {});
    expect(r.seatUsers.size).toBe(0);
    expect(await matches()).toEqual([]);
  });
  it.each([EllibirRoom, IhaleRoom])('starts %s through the existing engine, without treating bots as human accounts', async Type => {
    const { r, population } = makeRoom(Type);
    await human(r, 0); await human(r, 1);
    await population.reserve(pool[2].id, 2); await population.reserve(pool[3].id, 3);
    expect(r.seatUsers.size).toBe(2);
    await vi.advanceTimersByTimeAsync(7000);
    expect(r.game).toBeTruthy();
    expect(r.cfg.botSeats).toEqual([2, 3]);
    expect(r.game.players.map((p: any) => p.isBot)).toEqual([false, false, true, true]);
    expect(r.isHumanTurn(2)).toBe(false); expect(r.isHumanTurn(0)).toBe(true);
    expect(r.matchRewardsEligible).toBe(false);
    expect(deductEntry).not.toHaveBeenCalled();
    expect((await matches())[0].state).toBe('active');
    const watcher = { sessionId: 'watcher', auth: 'watcher', send: vi.fn() };
    r.clients.push(watcher);
    r.pushViews();
    const view = JSON.parse([...watcher.send.mock.calls].reverse().find((c: any[]) => c[0] === 'view')![1]);
    expect(view.myHand).toEqual([]);
    expect(view.seats[2]).toMatchObject({ uid: `bot:${pool[2].id}`, name: pool[2].name, isBot: true, isSystemBot: true, populationBotId: pool[2].id });
    expect(JSON.stringify(view)).not.toContain('owner_id');
    expect(JSON.stringify(view)).not.toContain('expires_at');
  });

  it('reserves a seat before async SQL and refuses both human collision and a second bot', async () => {
    const { r, population } = makeRoom();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    intercept = async name => { if (name === 'bot_population_claim') await gate; };
    const reserving = population.reserve(pool[0].id, 0);
    await expect(population.reserve(pool[1].id, 0)).rejects.toThrow('population_seat_unavailable');
    const client = await human(r, 0);
    expect(r.seats.has(client.sessionId)).toBe(false);
    expect(client.send).toHaveBeenCalledWith('seat', { seat: -1 });
    release(); await reserving;
    expect(population.size).toBe(1);
  });

  it('allows bots-only waiting rotation but pins characters once a human is waiting', async () => {
    const { r, population } = makeRoom();
    await population.reserve(pool[0].id, 0);
    await population.remove(0);
    expect(population.size).toBe(0); expect(r.seatNames.has(0)).toBe(false);
    await population.reserve(pool[1].id, 0);
    await human(r, 1);
    await expect(population.remove(0)).rejects.toThrow('population_seat_pinned');
    expect(population.size).toBe(1);
  });

  it('locks entry against reentrant readiness, refunds if the human roster changes while charging', async () => {
    const { r, population } = makeRoom();
    const c = await human(r, 0); await human(r, 1);
    await population.reserve(pool[2].id, 2); await population.reserve(pool[3].id, 3);
    const before = await walletTotal();
    let release!: () => void, charged!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const chargedSignal = new Promise<void>(resolve => { charged = resolve; });
    intercept = async name => { if (name === 'bot_population_begin_match') { charged(); await gate; } };
    // Timer callbacks may await HTTP; do not wait on the timer advance before releasing the gate.
    const advancing = vi.advanceTimersByTimeAsync(7000);
    await chargedSignal;
    expect(r.entryStarting).toBe(true);
    try {
      r.startGameIfReady(); r.startGameIfReady();
      r.cleanupSeat(c.sessionId, 0);
    } finally { release(); }
    await advancing;
    expect(r.game).toBeFalsy(); expect(r.entryStarting).toBe(false);
    expect(await walletTotal()).toBe(before);
    expect(await matches()).toHaveLength(1);
    expect((await matches())[0].state).toBe('refunded');
  });

  it('reconciles a committed entry with a lost HTTP response without another debit', async () => {
    const { r, population } = makeRoom();
    await human(r, 0); await human(r, 1);
    await population.reserve(pool[2].id, 2); await population.reserve(pool[3].id, 3);
    const before = await walletTotal();
    intercept = async name => { if (name === 'bot_population_begin_match') { intercept = null; throw new Error('lost_reply'); } };
    await vi.advanceTimersByTimeAsync(7000);
    expect(r.game).toBeTruthy();
    expect(await matches()).toHaveLength(1);
    expect(await walletTotal()).toBe(before - 4000);
  });

  it('never falls back to legacy settlement when only the post-payout snapshot fails', async () => {
    const { r, population } = makeRoom(IhaleRoom);
    await human(r, 0); await human(r, 1);
    await population.reserve(pool[2].id, 2); await population.reserve(pool[3].id, 3);
    await vi.advanceTimersByTimeAsync(7000);
    r.game.phase = 'matchEnded'; r.game.matchWinnerSeat = 0;
    let snapshotFailed = false;
    intercept = async name => { if (name === 'bot_population_snapshot' && !snapshotFailed) { snapshotFailed = true; throw new Error('lost_snapshot'); } };
    r.checkHandEnd(); await r.settlePromise;
    expect(r.settled).toBe(false); expect(population.hasMatch).toBe(true);
    const total = await walletTotal();
    r.checkHandEnd(); await r.settlePromise;
    expect(r.settled).toBe(true); expect(await walletTotal()).toBe(total);
    expect(settleMatch).not.toHaveBeenCalled();
  });

  it('reconciles an unknown entry receipt before retrying with a new match key', async () => {
    const { r, population } = makeRoom();
    await human(r, 0); await human(r, 1);
    await population.reserve(pool[2].id, 2); await population.reserve(pool[3].id, 3);
    const before = await walletTotal();
    intercept = async name => {
      if (name === 'bot_population_begin_match') throw new Error('lost_entry_reply');
      if (name === 'bot_population_get_match') { intercept = null; throw new Error('lookup_temporarily_unavailable'); }
    };
    await vi.advanceTimersByTimeAsync(7000);
    expect(r.game).toBeFalsy(); expect((await matches())[0].state).toBe('active');
    r.startGameIfReady();
    await vi.advanceTimersByTimeAsync(7000);
    expect(r.game).toBeTruthy();
    const rows = await matches();
    expect(rows.map(m => m.state).sort()).toEqual(['active', 'refunded']);
    expect(await walletTotal()).toBe(before - 4000);
  });

  it('disposal during an in-flight debit waits for its receipt and refunds exactly once', async () => {
    const { r, population } = makeRoom();
    await human(r, 0); await human(r, 1);
    await population.reserve(pool[2].id, 2); await population.reserve(pool[3].id, 3);
    const before = await walletTotal();
    let release!: () => void, charged!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const signal = new Promise<void>(resolve => { charged = resolve; });
    intercept = async name => { if (name === 'bot_population_begin_match') { charged(); await gate; } };
    const advancing = vi.advanceTimersByTimeAsync(7000);
    await signal;
    const disposing = r.onDispose();
    release(); await advancing; await disposing;
    expect(r.game).toBeFalsy();
    expect(await walletTotal()).toBe(before);
    expect((await matches())[0].state).toBe('refunded');
    expect((await storage.snapshot()).leases).toEqual([]);
  });

  it('fences engine steps after lease loss and keeps a managed match alive when humans leave', async () => {
    const { r, population } = makeRoom(IhaleRoom);
    const c0 = await human(r, 0); const c1 = await human(r, 1);
    await population.reserve(pool[2].id, 2); await population.reserve(pool[3].id, 3);
    await vi.advanceTimersByTimeAsync(7000);
    r.setAbandoned(0, true); r.setAbandoned(1, true);
    const disconnect = vi.fn(); r.disconnect = disconnect;
    r.cleanupSeat(c0.sessionId, 0); r.cleanupSeat(c1.sessionId, 1);
    await db.exec("update bot_population.leases set expires_at=now()-interval '1 second'");
    await expect(population.renew()).rejects.toThrow('lease_lost');
    const revision = r.game.revision;
    await r.runEngine(); await vi.advanceTimersByTimeAsync(700);
    expect(r.game.revision).toBe(revision);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it.each([EllibirRoom, IhaleRoom])('completes an actual all-character %s match using the existing AI and recorded wallets', async Type => {
    const { r, population } = makeRoom(Type);
    for (let seat = 0; seat < 4; seat++) await population.reserve(pool[seat].id, seat);
    const before = await walletTotal();
    await vi.advanceTimersByTimeAsync(7000);
    let iterations = 0;
    while (r.game?.phase !== 'matchEnded' && iterations++ < 350) await vi.advanceTimersByTimeAsync(100);
    expect(r.game?.phase).toBe('matchEnded');
    await r.settlePromise;
    expect(r.settled).toBe(true);
    const rows = await matches();
    expect(rows).toHaveLength(1);
    expect(['settled', 'refunded']).toContain(rows[0].state);
    expect(await walletTotal()).toBe(before - Number(rows[0].house_amount));
    expect(r.seatUsers.size).toBe(0);
    expect(settleMatch).not.toHaveBeenCalled();
    expect(deductEntry).not.toHaveBeenCalled();
  }, 20000);
});

describe('real Okey-family rooms with persistent character seats', () => {
  it.each(['duz', 'banko', 'yuzbir'] as const)('%s reserves honest identities and hides bot hands from spectators', async variant => {
    const { r, population } = makeOkey(variant);
    await human(r, 0); await human(r, 1);
    await population.reserve(pool[2].id, 2); await population.reserve(pool[3].id, 3);
    const watcher = { sessionId: 'watcher', send: vi.fn() };
    r.clients.push(watcher); await r.onJoin(watcher, { requestedSeat: 2, populationVersion:1 });
    expect(r.seats.has(watcher.sessionId)).toBe(false);
    await vi.advanceTimersByTimeAsync(7100);
    expect(r.game).toBeTruthy();
    expect(r.cfg.botSeats).toEqual([2, 3]);
    expect(r.game.players.map((p: any) => p.isBot)).toEqual([false, false, true, true]);
    expect(r.matchRewardsEligible).toBe(false);
    const view = JSON.parse([...watcher.send.mock.calls].reverse().find((c: any[]) => c[0] === 'view')![1]);
    expect(view.myHand).toEqual([]);
    expect(view.players[2]).toMatchObject({ uid: `bot:${pool[2].id}`, name: pool[2].name, isBot: true, isSystemBot: true, populationBotId: pool[2].id });
    expect(view.seated[2]).toMatchObject({ filled: true, isSystemBot: true });
    expect(JSON.stringify(view)).not.toContain('expires_at');
    expect((await matches())[0].state).toBe('active');
    expect(deductEntry).not.toHaveBeenCalled();
  });

  it.each(['duz', 'banko', 'yuzbir'] as const)('%s completes a real all-bot match and reconciles all wallets', async variant => {
    const { r, population } = makeOkey(variant);
    for (let seat = 0; seat < 4; seat++) await population.reserve(pool[seat].id, seat);
    const before = await walletTotal();
    await vi.advanceTimersByTimeAsync(7000);
    let iterations = 0;
    while (!r.game?.matchEnded && iterations++ < 300) await vi.advanceTimersByTimeAsync(1000);
    expect(r.game?.matchEnded).toBe(true);
    await r.settlePromise;
    expect(r.settled).toBe(true);
    const rows = await matches();
    expect(rows).toHaveLength(1);
    expect(['settled', 'refunded']).toContain(rows[0].state);
    expect(await walletTotal()).toBe(before - Number(rows[0].house_amount));
    expect(r.seatUsers.size).toBe(0);
    expect(deductEntry).not.toHaveBeenCalled(); expect(settleMatch).not.toHaveBeenCalled();
  }, 30000);

  it.each(['duz', 'yuzbir'] as const)('%s renewals leave the human timer intact and resume after a transient outage', async variant => {
    const { r, population } = makeOkey(variant);
    await human(r, 0); await human(r, 1);
    await population.reserve(pool[2].id, 2); await population.reserve(pool[3].id, 3);
    await vi.advanceTimersByTimeAsync(7200);
    const timer = r.humanTimer; expect(timer).toBeTruthy();
    const deadline = r.turnDeadlineAt;
    await population.renew(); expect(r.humanTimer).toBe(timer); expect(r.turnDeadlineAt).toBe(deadline);
    intercept = async name => { if (name === 'bot_population_heartbeat') throw new Error('outage'); };
    await expect(population.renew()).rejects.toThrow('outage');
    expect(r.humanTimer).toBeNull();
    const stock = r.game.stock.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(r.game.stock.length).toBe(stock);
    intercept = null; await population.renew();
    expect(r.humanTimer).toBeTruthy();
  });

  it('preserves banko decisions through a pause without resetting healthy selection timers', async () => {
    const { r, population } = makeOkey('banko');
    r.cfg.rules.totalEls = 3;
    await human(r, 0); await human(r, 1);
    await population.reserve(pool[2].id, 2); await population.reserve(pool[3].id, 3);
    await vi.advanceTimersByTimeAsync(7100);
    expect(r.game.bankoPhase).toBe(true);
    r.game.bankoChoice[0] = 0;
    const timer = r.bankoTimer;
    await population.renew(); expect(r.bankoTimer).toBe(timer);
    const choices = [...r.game.bankoChoice];
    intercept = async name => { if (name === 'bot_population_heartbeat') throw new Error('outage'); };
    await expect(population.renew()).rejects.toThrow('outage');
    expect(r.bankoTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(2800);
    expect(r.game.bankoChoice).toEqual(choices);
    expect(r.game.bankoPhase).toBe(true);
    intercept = null; await population.renew();
    expect(r.game.bankoChoice).toEqual(choices);
    expect(r.bankoTimer).toBeTruthy();
    await vi.advanceTimersByTimeAsync(10000);
    expect(r.game.bankoPhase).toBe(false);
    expect(r.game.bankoChoice[0]).toBe(0);
  });

  it('refunds an Okey roster change during async entry and never starts the stale game', async () => {
    const { r, population } = makeOkey('yuzbir');
    const client = await human(r, 0); await human(r, 1);
    await population.reserve(pool[2].id, 2); await population.reserve(pool[3].id, 3);
    const before = await walletTotal();
    let release!: () => void, charged!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const signal = new Promise<void>(resolve => { charged = resolve; });
    intercept = async name => { if (name === 'bot_population_begin_match') { charged(); await gate; } };
    const advancing = vi.advanceTimersByTimeAsync(7000);
    await signal;
    try { r.startGameIfReady(); r.cleanupSeat(client.sessionId, 0); } finally { release(); }
    await advancing;
    expect(r.game).toBeNull(); expect(r.entryStarting).toBe(false);
    expect(await walletTotal()).toBe(before);
    expect((await matches()).map(m => m.state)).toEqual(['refunded']);
  });

  it('Okey payout snapshot failure cannot fall through to the legacy payout', async () => {
    const { r, population } = makeOkey('duz');
    await human(r, 0); await human(r, 1);
    await population.reserve(pool[2].id, 2); await population.reserve(pool[3].id, 3);
    await vi.advanceTimersByTimeAsync(7100);
    r.game.matchEnded = true; r.game.elEnded = true; r.game.elWinner = 0; r.game.scores = [0, 20, 0, 20];
    intercept = async name => { if (name === 'bot_population_snapshot') { intercept = null; throw new Error('lost_refresh'); } };
    r.settleOnce(); await r.settlePromise;
    expect(r.settled).toBe(false);
    const total = await walletTotal();
    r.settleOnce(); await r.settlePromise;
    expect(r.settled).toBe(true); expect(await walletTotal()).toBe(total);
    expect(settleMatch).not.toHaveBeenCalled();
  });
});

describe('real Tavla rooms with persistent character seats', () => {
  it('starts one human and one named character with a two-seat recorded entry', async () => {
    const { r, population } = makeTavla();
    await human(r, 0); await population.reserve(pool[1].id, 1);
    await expect(population.reserve(pool[2].id, 2)).rejects.toThrow('population_seat_unavailable');
    const watcher = { sessionId: 'watcher', send: vi.fn() };
    r.clients.push(watcher); await r.onJoin(watcher, { requestedSeat: 1, populationVersion:1 });
    const before = await walletTotal();
    await vi.advanceTimersByTimeAsync(7100);
    expect(r.game.players.map((p: any) => p.isBot)).toEqual([false, true]);
    expect(r.matchRewardsEligible).toBe(false);
    expect(await walletTotal()).toBe(before - 2000);
    const view = JSON.parse([...watcher.send.mock.calls].reverse().find((c: any[]) => c[0] === 'view')![1]);
    expect(view.players[1]).toMatchObject({ uid: `bot:${pool[1].id}`, name: pool[1].name, isBot: true, isSystemBot: true, populationBotId: pool[1].id });
    expect(JSON.stringify(view)).not.toContain('expires_at');
    expect(r.seats.has(watcher.sessionId)).toBe(false);
    expect(deductEntry).not.toHaveBeenCalled();
  });

  it.each([123, 456, 789])('seed %s plays a complete bot match with conserved actual stakes', async seed => {
    const { r, population } = makeTavla(seed);
    await population.reserve(pool[0].id, 0); await population.reserve(pool[1].id, 1);
    const before = await walletTotal();
    await vi.advanceTimersByTimeAsync(7000);
    let iterations = 0;
    while (!r.game?.matchEnded && iterations++ < 300) await vi.advanceTimersByTimeAsync(1000);
    expect(r.game?.matchEnded).toBe(true);
    await r.settlePromise;
    expect(r.settled).toBe(true);
    const rows = await matches();
    expect(rows).toHaveLength(1); expect(rows[0].state).toBe('settled');
    expect(await walletTotal()).toBe(before - Number(rows[0].house_amount));
    expect(Number(rows[0].house_amount)).toBe(200);
    expect(deductEntry).not.toHaveBeenCalled(); expect(settleMatch).not.toHaveBeenCalled();
  }, 30000);

  it('does not rearm a human turn on healthy renewal and resumes after transient lease failure', async () => {
    const { r, population } = makeTavla();
    await human(r, 0); await population.reserve(pool[1].id, 1);
    await vi.advanceTimersByTimeAsync(7100);
    expect(r.game.turn).toBe(0);
    const timer = r.humanTimer; expect(timer).toBeTruthy();
    const deadline = r.turnDeadlineAt;
    await population.renew(); r.afterChange();
    expect(r.humanTimer).toBe(timer); expect(r.turnDeadlineAt).toBe(deadline);
    intercept = async name => { if (name === 'bot_population_heartbeat') throw new Error('outage'); };
    await expect(population.renew()).rejects.toThrow('outage');
    expect(r.humanTimer).toBeNull();
    intercept = null; await population.renew(); expect(r.humanTimer).toBeTruthy();
  });

  it.each(['pendingDouble', 'pendingResign'] as const)('freezes %s responses without losing the pending decision', async pending => {
    const { r, population } = makeTavla();
    await human(r, 0); await population.reserve(pool[1].id, 1);
    await vi.advanceTimersByTimeAsync(7100);
    r.game[pending] = 0;
    r.afterChange();
    expect(r.botTimer).toBeTruthy();
    intercept = async name => { if (name === 'bot_population_heartbeat') throw new Error('outage'); };
    await expect(population.renew()).rejects.toThrow('outage');
    expect(r.botTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(1500);
    expect(r.game[pending]).toBe(0);
    intercept = null; await population.renew();
    await vi.advanceTimersByTimeAsync(1500);
    expect(r.game[pending]).toBe(-1);
  });

  it('refunds a departed Tavla human during charging, without closing the managed waiting room', async () => {
    const { r, population } = makeTavla();
    const client = await human(r, 0); await population.reserve(pool[1].id, 1);
    const before = await walletTotal();
    let release!: () => void, charged!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const signal = new Promise<void>(resolve => { charged = resolve; });
    intercept = async name => { if (name === 'bot_population_begin_match') { charged(); await gate; } };
    const disconnect = vi.fn(); r.disconnect = disconnect;
    const advancing = vi.advanceTimersByTimeAsync(7000);
    await signal;
    try { r.startGameIfReady(); r.cleanupSeat(client.sessionId, 0); } finally { release(); }
    await advancing;
    expect(r.game).toBeNull(); expect(await walletTotal()).toBe(before);
    expect((await matches()).map(m => m.state)).toEqual(['refunded']);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('settles to the captured human identity even if that player already left', async () => {
    const { r, population } = makeTavla();
    const client = await human(r, 0); await population.reserve(pool[1].id, 1);
    await vi.advanceTimersByTimeAsync(7100);
    r.game.matchEnded = true; r.game.gameEnded = true; r.game.matchScore = [1, 0];
    r.cleanupSeat(client.sessionId, 0);
    expect(r.seatUsers.size).toBe(0);
    r.settleOnce(); await r.settlePromise;
    const wallet = await db.query<{ chips: number }>("select chips from public.profiles where id='human-0'");
    expect(Number(wallet.rows[0].chips)).toBe(20800);
    expect(settleMatch).not.toHaveBeenCalled();
  });
});

describe('population director with real rooms and SQL leases', () => {
  const waiting: PopulationTablePlan = { key: 'ihale:team:1', game: 'ihale', team: true, bet: 1000,
    table: 1, kind: 'waiting', waitingBots: 2 };
  function director(plan: PopulationTablePlan = waiting, lobby = 2) {
    let time = Date.now();
    const opened: ReturnType<typeof makeRoom>[] = [];
    const provider = {
      open: vi.fn(async () => {
        const m = plan.game === '51' ? makeRoom(EllibirRoom) : plan.game === 'duz' ? makeOkey('duz') : makeRoom(IhaleRoom);
        opened.push(m); return m.population;
      }),
      close: vi.fn(async () => {}),
    };
    const d = new PopulationDirector(storage, owner, [plan], provider, lobby, () => time, () => 0.25);
    return { d, opened, provider, later: (ms = 300001) => { time += ms; } };
  }

  it('is inert on construction and provisions nothing while the persisted control is off', async () => {
    await storage.control(1, 'off', 16, 'test');
    const { d, provider } = director();
    expect(provider.open).not.toHaveBeenCalled();
    await d.tick();
    expect(provider.open).not.toHaveBeenCalled();
    expect((await storage.snapshot()).leases).toEqual([]);
  });

  it('fills a small active roster, coalesces ticks and rotates idle names after 3-5 minutes', async () => {
    const { d, opened, later, provider } = director();
    const ticking = d.tick(); expect(d.tick()).toBe(ticking); await ticking;
    expect(provider.open).toHaveBeenCalledTimes(1);
    expect(d.status().tables[0].bots).toBe(2); expect(d.status().lobby).toHaveLength(2);
    const before = (await storage.snapshot()).leases.map(l => l.character_id);
    expect(before).toHaveLength(4);
    const oldSeats = opened[0].population.seats().map(s => opened[0].population.characterId(s));
    later(); await d.tick();
    expect(d.status().errors).toEqual([]);
    const after = (await storage.snapshot()).leases.map(l => l.character_id);
    expect(after).toHaveLength(4);
    expect(after.filter(id => before.includes(id))).toHaveLength(1);
    expect(opened[0].population.characterId(0)).not.toBe(oldSeats[0]);
    expect(provider.open).toHaveBeenCalledTimes(1);
  });

  it('pins a waiting human table, accepts a community bot invite and drains only after match settlement', async () => {
    const { d, opened, later, provider } = director();
    await d.tick();
    const { r, population } = opened[0];
    const before = population.seats().map(s => population.characterId(s));
    await human(r, 2);
    later(); await d.tick();
    expect(population.seats().map(s => population.characterId(s))).toEqual(before);
    const invited = d.status().lobby[0];
    await d.invite(invited, waiting.key, 3);
    await d.invite(invited, waiting.key, 3);
    expect(population.characterId(3)).toBe(invited);
    expect(d.status().lobby).not.toContain(invited);
    await vi.advanceTimersByTimeAsync(7100);
    expect(r.game).toBeTruthy();
    await storage.control(1, 'draining', 16, 'test');
    await d.tick();
    expect(d.status().tables).toHaveLength(1);
    expect(population.activeMatch).toBe(true);
    expect((await matches())[0].state).toBe('active');
    expect(d.status().lobby).toEqual([]);
    await population.renew();
    expect(population.canPlay).toBe(true);
    r.game.phase = 'matchEnded'; r.game.matchWinnerSeat = 2;
    r.checkHandEnd(); await r.settlePromise;
    await d.tick();
    expect(d.status().tables).toEqual([]);
    expect((await storage.snapshot()).leases).toEqual([]);
    expect((await matches())[0].state).toBe('settled');
    expect(r.seats.size).toBe(1); expect(r.population).toBeNull();
    expect(provider.close).not.toHaveBeenCalled();
  });

  it('rotates a three-bot waiting table, then starts with its first human and preserves that match during drain', async () => {
    const { d, opened, later } = director({ ...waiting, waitingBots: 3 }, 0);
    await d.tick();
    const { r, population } = opened[0];
    expect(population.size).toBe(3);
    expect(r.game).toBeFalsy();
    expect(r.startTimer).toBeNull();
    const before = population.seats().map(s => population.characterId(s));
    later(); await d.tick();
    expect(population.size).toBe(3);
    const rotated = population.seats().map(s => population.characterId(s));
    expect(rotated).not.toEqual(before);
    await human(r, 3);
    later(); await d.tick();
    expect(population.seats().map(s => population.characterId(s))).toEqual(rotated);
    await vi.advanceTimersByTimeAsync(7100);
    expect(r.game).toBeTruthy();
    expect(population.activeMatch).toBe(true);
    expect((await matches())).toHaveLength(1);
    await d.requestDrain();
    expect(population.canPlay).toBe(true);
    expect(d.status().tables).toHaveLength(1);
    r.game.phase = 'matchEnded'; r.game.matchWinnerSeat = 3;
    r.checkHandEnd(); await r.settlePromise;
    await d.tick();
    expect(d.status().tables).toEqual([]);
    expect((await matches())[0].state).toBe('settled');
    expect(r.seats.size).toBe(1);
  });

  it.each(['51', 'duz'] as const)('%s starts its three-bot table with one human, without requiring an invite', async game => {
    const { d, opened, later } = director({ ...waiting, game, key: `${game}:team:1`, waitingBots: 3 }, 0);
    await d.tick();
    const { r, population } = opened[0];
    const before = population.seats().map(s => population.characterId(s));
    expect(before).toHaveLength(3);
    expect(r.game).toBeFalsy();
    await human(r, 3);
    later(); await d.tick();
    expect(population.seats().map(s => population.characterId(s))).toEqual(before);
    await vi.advanceTimersByTimeAsync(7100);
    expect(r.game).toBeTruthy();
    expect(population.activeMatch).toBe(true);
    expect((await matches())).toHaveLength(1);
    await d.requestDrain();
    expect(population.canPlay).toBe(true);
    expect(d.status().tables).toHaveLength(1);
  });

  it('drain releases idle bots without removing a waiting human or charging a match', async () => {
    const { d, opened, provider } = director();
    await d.tick(); await human(opened[0].r, 2);
    await d.requestDrain();
    expect(d.status().stopping).toBe(true);
    expect(d.status().tables).toEqual([]);
    expect(d.status().lobby).toEqual([]);
    expect((await storage.snapshot()).leases).toEqual([]);
    expect(opened[0].r.seats.size).toBe(1);
    expect(await matches()).toEqual([]);
    expect(provider.close).not.toHaveBeenCalled();
    await d.tick(); expect(provider.open).toHaveBeenCalledTimes(1);
  });

  it('rejects invites without a human, invalid seats and simultaneous duplicate-seat requests', async () => {
    const { d, opened } = director();
    await d.tick();
    const [first, second] = d.status().lobby;
    await expect(d.invite(first, waiting.key, 3)).rejects.toThrow('population_invite_unavailable');
    await human(opened[0].r, 2);
    await expect(d.invite(first, waiting.key, 9)).rejects.toThrow('population_seat_unavailable');
    expect(d.status().lobby).toContain(first);
    const invited = d.invite(first, waiting.key, 3);
    const collision = d.invite(second, waiting.key, 3);
    await invited; await expect(collision).rejects.toThrow('population_seat_unavailable');
    expect(opened[0].population.characterId(3)).toBe(first);
    expect(d.status().lobby).toContain(second);
  });

  it('respects capacity and sheds only idle reservations when the cap is lowered', async () => {
    await storage.control(1, 'running', 3, 'test');
    const { d, opened } = director();
    await d.tick();
    expect((await storage.snapshot()).leases).toHaveLength(3);
    await storage.control(2, 'running', 1, 'test');
    await d.tick();
    expect((await storage.snapshot()).leases).toHaveLength(1);
    expect(opened[0].population.size).toBe(1);
  });

  it('replenishes a completed bots-only showcase with a different roster, never restarting its old receipt', async () => {
    const { d, opened, provider } = director({ ...waiting, kind: 'showcase' }, 0);
    await d.tick();
    const { r, population } = opened[0];
    const ids = population.seats().map(s => population.characterId(s));
    await vi.advanceTimersByTimeAsync(7100);
    r.game.phase = 'matchEnded'; r.game.matchWinnerSeat = 0;
    r.checkHandEnd(); await r.settlePromise;
    await d.tick();
    expect(provider.close).toHaveBeenCalledTimes(1);
    expect(provider.open).toHaveBeenCalledTimes(2);
    expect(opened[1].population.size).toBe(4);
    expect(opened[1].population.seats().map(s => opened[1].population.characterId(s)).some(id => ids.includes(id))).toBe(false);
    expect(await matches()).toHaveLength(1);
    expect((await matches())[0].state).toBe('settled');
  });

  it('pauses a rotating quota after match end and retires its old roster before creating another game', async () => {
    const { d, opened, provider, later } = director({...waiting,kind:'showcase',tablePool:[1,2,3]},0);
    await d.tick();
    const {r,population} = opened[0];
    const old = population.seats().map(s => population.characterId(s));
    await vi.advanceTimersByTimeAsync(7100);
    r.game.phase='matchEnded';r.game.matchWinnerSeat=0;
    r.checkHandEnd();await r.settlePromise;
    await d.tick();
    expect(d.status().tables).toEqual([]);
    expect(provider.close).toHaveBeenCalledTimes(1);
    await d.tick();
    expect(provider.open).toHaveBeenCalledTimes(1);
    later(40001);await d.tick();
    expect(provider.open).toHaveBeenCalledTimes(2);
    expect(opened[1].population.size).toBe(4);
    expect(opened[1].population.seats().map(s => opened[1].population.characterId(s)).some(id => old.includes(id))).toBe(false);
    expect((await matches()).map(m => m.state)).toEqual(['settled']);
  });

  it('enforces below-threshold refill through SQL and leaves richer wallets intact', async () => {
    await db.exec('update bot_population.characters set chips=90000');
    await db.query('update bot_population.characters set chips=400000 where id=$1', [pool[0].id]);
    const { d } = director(); await d.tick();
    const snapshot = await storage.snapshot();
    for (const lease of snapshot.leases) {
      const c = snapshot.characters.find(c => c.id === lease.character_id)!;
      expect(c.chips).toBeGreaterThanOrEqual(100000);
    }
    expect(snapshot.characters.find(c => c.id === pool[0].id)!.chips).toBe(400000);
    const credits = await db.query("select * from bot_population.ledger where reason='daily_refill'");
    await d.tick();
    expect((await db.query("select * from bot_population.ledger where reason='daily_refill'")).rows).toHaveLength(credits.rows.length);
  });

  it('validates plan bounds and does not create duplicate logical tables', () => {
    const provider = { open: vi.fn(), close: vi.fn() };
    expect(() => new PopulationDirector(storage, owner, [waiting, { ...waiting, key: 'duplicate' }], provider)).toThrow('population_plan_invalid');
    expect(() => new PopulationDirector(storage, owner, [{ ...waiting, waitingBots: 4 }], provider)).toThrow('population_plan_invalid');
    expect(() => new PopulationDirector(storage, owner, [{ ...waiting, bet: 550 }], provider)).toThrow('population_plan_invalid');
  });

  it.each(['51', 'ihale', 'duz', 'banko', 'yuzbir', 'tavla'] as const)('%s waiting drain preserves humans and removes bot display names', async game => {
    const { r, population } = game === '51' ? makeRoom() : game === 'ihale' ? makeRoom(IhaleRoom)
      : game === 'tavla' ? makeTavla() : makeOkey(game);
    await human(r, 0); await population.reserve(pool[1].id, 1);
    expect(await population.retire()).toBe(true);
    expect(r.seats.size).toBe(1); expect(r.seatNames.has(1)).toBe(false);
    expect(r.population).toBeNull();
    await vi.advanceTimersByTimeAsync(7100);
    expect(r.game).toBeFalsy(); expect(await matches()).toEqual([]);
  });

  it('a lost release response and a subsequent new lease cannot leave a ghost seat or release the new owner', async () => {
    const { population, r } = makeRoom(IhaleRoom);
    await population.reserve(pool[0].id, 0);
    const nextOwner = '00000000-0000-4000-8000-000000000022';
    const nextToken = '00000000-0000-4000-8000-000000000023';
    intercept = async name => {
      if (name === 'bot_population_release') {
        intercept = null;
        await storage.claim(pool[0].id, nextOwner, nextToken);
        throw new Error('lost_release_reply');
      }
    };
    expect(await population.retire()).toBe(true);
    expect(r.seatNames.has(0)).toBe(false);
    expect((await storage.snapshot()).leases[0]).toMatchObject({ owner_id: nextOwner, token: nextToken });
  });

  it('retries closing an empty retired room before creating another showcase', async () => {
    const { d, provider } = director();
    await d.tick();
    provider.close.mockRejectedValueOnce(new Error('close_temporarily_failed'));
    await d.requestDrain();
    expect(d.status().tables).toHaveLength(1);
    expect(d.status().errors[0]).toContain('close_temporarily_failed');
    await d.tick();
    expect(d.status().tables).toEqual([]);
    expect(provider.close).toHaveBeenCalledTimes(2);
    expect(provider.open).toHaveBeenCalledTimes(1);
  });

  it('a drain requested during an asynchronous claim waits, then clears that newly acquired reservation', async () => {
    const { d } = director();
    let release!: () => void, claimed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const signal = new Promise<void>(resolve => { claimed = resolve; });
    intercept = async name => { if (name === 'bot_population_claim') { claimed(); await gate; } };
    const ticking = d.tick();
    await signal;
    const draining = d.requestDrain();
    release(); await ticking; await draining;
    expect(d.status().stopping).toBe(true);
    expect(d.status().tables).toEqual([]); expect(d.status().lobby).toEqual([]);
    expect((await storage.snapshot()).leases).toEqual([]);
    expect(await matches()).toEqual([]);
  });
});
