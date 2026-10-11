import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchMaker } from '@colyseus/core';
import { EllibirRoom } from './rooms/EllibirRoom';
import { IhaleRoom } from './rooms/IhaleRoom';
import { OkeyRoom } from './rooms/OkeyRoom';
import { TavlaRoom } from './rooms/TavlaRoom';
import { seatsWithoutLivePlayer } from './seatSelection';
import { clearSeatPresence, deductEntry } from './supabase';

vi.mock('./supabase', async importOriginal => ({
  ...await importOriginal<object>(),
  keepSeatPresence: vi.fn(async () => {}),
  clearSeatPresence: vi.fn(async () => {}),
  fetchCanak: vi.fn(async () => 0),
  deductEntry: vi.fn(async () => ({ ok: true, failedSeats: [] })),
}));

beforeAll(async () => {
  await matchMaker.setup();
  await matchMaker.accept(true);
  matchMaker.defineRoomType('ellibir', EllibirRoom).filterBy(['mode', 'table']);
  matchMaker.defineRoomType('ihale', IhaleRoom).filterBy(['mode', 'table']);
  matchMaker.defineRoomType('okey', OkeyRoom).filterBy(['mode', 'table', 'variant']);
  matchMaker.defineRoomType('tavla', TavlaRoom).filterBy(['mode', 'table']);
});
beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => {
  vi.useRealTimers();
  // Fake clients never consumed a real seat reservation; drop core bookkeeping so dispose completes now.
  const live = (await matchMaker.query()).map(l => matchMaker.getLocalRoomById(l.roomId) as any).filter(Boolean);
  for (const room of live) {
    for (const t of Object.values(room._reservedSeatTimeouts ?? {})) clearTimeout(t as any);
    room._reservedSeats = {}; room._reservedSeatTimeouts = {};
  }
  const closing = Promise.all(matchMaker.disconnectAll());
  for (const room of live) room.resetAutoDisposeTimeout(0);
  await closing;
});
afterAll(async () => { await matchMaker.gracefullyShutdown(); });

const rooms = [
  ['51', 'ellibir', { mode: 'solo' }],
  ['ihale', 'ihale', { mode: 'solo' }],
  ['okey', 'okey', { mode: 'solo', variant: 'duz' }],
  ['tavla', 'tavla', { mode: 'duo' }],
] as const;

function fakeClient(sessionId: string, uid: string) {
  const ref = { removeAllListeners: vi.fn(), removeListener: vi.fn(), once: vi.fn(), close: vi.fn() };
  return { sessionId, auth: uid, reconnectionToken: `tok-${sessionId}`, send: vi.fn(), leave: vi.fn(), readyState: 1, ref };
}

async function seatedRoom(name: string, options: object) {
  const listing = await matchMaker.handleCreateRoom(name, { table: 7, bet: 500, ...options });
  const room: any = matchMaker.getLocalRoomById(listing.roomId);
  room.pushViews = vi.fn(); room.runEngine = vi.fn(); room.afterChange = vi.fn(); room.enterBankoPhase = vi.fn();
  const clients = room.humanSeats.map((seat: number) => {
    const client = fakeClient(`s${seat}`, `user-${seat}`);
    room.seats.set(client.sessionId, seat); room.seatUsers.set(seat, client.auth); room.seatNames.set(seat, `P${seat}`);
    room.clients.push(client);
    return client;
  });
  const isBotControlled = (seat: number) => room.abandoned ? room.abandoned.has(seat) : room.game.abandoned?.includes(seat) === true;
  return { room, clients, isBotControlled };
}

describe('seatsWithoutLivePlayer', () => {
  it('flags empty and disconnected human seats, never bot seats', () => {
    const seats = new Map([['a', 0], ['b', 1], ['c', 3]]);
    expect(seatsWithoutLivePlayer([0, 1, 2, 3], seats, new Set(['a', 'c']), [])).toEqual([1, 2]);
    expect(seatsWithoutLivePlayer([0, 1, 2, 3], seats, new Set(['a', 'c']), [2])).toEqual([1]);
    expect(seatsWithoutLivePlayer([0, 1], new Map([['a', 0], ['b', 1]]), new Set(['a', 'b']), [])).toEqual([]);
  });
});

describe.each(rooms)('%s match start fairness', (_label, name, options) => {
  it('a seat whose holder dropped while waiting starts under bot control; live seats stay human', async () => {
    vi.useFakeTimers();
    const { room, clients, isBotControlled } = await seatedRoom(name, options);
    const last = room.humanSeats[room.humanSeats.length - 1];
    // Colyseus removes a dropped client from room.clients, then onDrop holds the seat for 180 s.
    room.clients.delete(clients[clients.length - 1]);
    void room.onDrop(clients[clients.length - 1]);
    room.startGameIfReady();
    await vi.advanceTimersByTimeAsync(room.START_MS + 10);
    expect(room.game).toBeTruthy();
    expect(isBotControlled(last)).toBe(true);
    for (const seat of room.humanSeats.filter((s: number) => s !== last)) expect(isBotControlled(seat)).toBe(false);
  });

  it('a seat whose holder is still in the reconnect window when a rematch starts is bot controlled', async () => {
    vi.useFakeTimers();
    const { room, clients, isBotControlled } = await seatedRoom(name, options);
    room.startGameIfReady();
    await vi.advanceTimersByTimeAsync(room.START_MS + 10);
    const last = room.humanSeats[room.humanSeats.length - 1];
    room.clients.delete(clients[clients.length - 1]);
    void room.onDrop(clients[clients.length - 1]);
    expect(isBotControlled(last)).toBe(true);
    room.prepareRematchCountdown();          // all seated players voted; new match countdown
    await vi.advanceTimersByTimeAsync(room.START_MS + 10);
    expect(room.game).toBeTruthy();
    expect(isBotControlled(last)).toBe(true);
    expect(isBotControlled(room.humanSeats[0])).toBe(false);
  });

  it('a seat vacated while the entry fee is being collected starts under bot control', async () => {
    vi.useFakeTimers();
    const { room, isBotControlled } = await seatedRoom(name, options);
    let release!: () => void;
    vi.mocked(deductEntry).mockImplementationOnce(() => new Promise(res => { release = () => res({ ok: true, failedSeats: [] }); }));
    room.startGameIfReady();
    await vi.advanceTimersByTimeAsync(room.START_MS + 10);
    expect(room.entryStarting).toBe(true);
    const last = room.humanSeats[room.humanSeats.length - 1];
    room.cleanupSeat(`s${last}`, last);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(room.game).toBeTruthy();
    expect(isBotControlled(last)).toBe(true);
    expect(isBotControlled(room.humanSeats[0])).toBe(false);
  });

  it('a seat emptied during the countdown cancels it, so the next player gets a full countdown', async () => {
    vi.useFakeTimers();
    const { room } = await seatedRoom(name, options);
    room.startGameIfReady();
    expect(room.startTimer).toBeTruthy();
    await vi.advanceTimersByTimeAsync(room.START_MS - 1000);
    const last = room.humanSeats[room.humanSeats.length - 1];
    room.cleanupSeat(`s${last}`, last);
    expect(room.startTimer).toBeNull();
    expect(room.startAt).toBe(0);
    const late = fakeClient('late', 'user-late');
    room.clients.push(late); room.seats.set('late', last); room.seatUsers.set(last, 'user-late');
    room.startGameIfReady();
    await vi.advanceTimersByTimeAsync(room.START_MS - 100);
    expect(room.game).toBeFalsy();
    await vi.advanceTimersByTimeAsync(200);
    expect(room.game).toBeTruthy();
  });
});

describe.each(rooms)('%s same account returning without a reconnection token', (_label, name, options) => {
  it('reclaims the held seat instead of becoming a spectator', async () => {
    const { room, clients, isBotControlled } = await seatedRoom(name, options);
    room.game = null;
    const old = clients[0];
    room.clients.delete(old);
    const drop = room.onDrop(old);
    expect(Object.keys(room._reconnections)).toHaveLength(1);
    const fresh = fakeClient('fresh', old.auth);
    room.clients.push(fresh);
    await room.onJoin(fresh, { populationVersion: 1 });
    expect(room.seats.get('fresh')).toBe(0);
    expect(room.seats.has(old.sessionId)).toBe(false);
    expect(room.spectators.has('fresh')).toBe(false);
    expect(fresh.send).toHaveBeenCalledWith('seat', { seat: 0 });
    await drop;
    expect(Object.keys(room._reconnections)).toHaveLength(0);
    expect(room.seats.get('fresh')).toBe(0);
    expect(room.seatUsers.get(0)).toBe(old.auth);
    expect(clearSeatPresence).not.toHaveBeenCalled();
    if (room.abandoned) expect(isBotControlled(0)).toBe(false);
  });

  it('keeps the spectator behaviour while the original session is still connected', async () => {
    const { room, clients } = await seatedRoom(name, options);
    const fresh = fakeClient('fresh', clients[0].auth);
    room.clients.push(fresh);
    await room.onJoin(fresh, { populationVersion: 1 });
    expect(room.seats.get(clients[0].sessionId)).toBe(0);
    expect(room.seats.has('fresh')).toBe(false);
    expect(room.spectators.has('fresh')).toBe(true);
  });

  it('does not reclaim when the account only asked to watch', async () => {
    const { room, clients } = await seatedRoom(name, options);
    room.game = null;
    room.clients.delete(clients[0]);
    void room.onDrop(clients[0]);
    const fresh = fakeClient('fresh', clients[0].auth);
    room.clients.push(fresh);
    await room.onJoin(fresh, { populationVersion: 1, spectate: true });
    expect(room.seats.get(clients[0].sessionId)).toBe(0);
    expect(room.spectators.has('fresh')).toBe(true);
  });
});

describe('matchmaking room routing', () => {
  const auth = { headers: {}, ip: '127.0.0.1' } as any;
  it('okey variants never share a table, even for clients that only send rules.variant', async () => {
    const klasik = await matchMaker.joinOrCreate('okey', { mode: 'solo', table: 3, rules: '{"variant":"duz"}' }, auth);
    const yuzbir = await matchMaker.joinOrCreate('okey', { mode: 'solo', table: 3, rules: '{"variant":"yuzbir"}' }, auth);
    const klasik2 = await matchMaker.joinOrCreate('okey', { mode: 'solo', table: 3, rules: '{"variant":"duz"}' }, auth);
    expect(yuzbir.roomId).not.toBe(klasik.roomId);
    expect(klasik2.roomId).toBe(klasik.roomId);
  });

  it('51 tables match on mode + table number', async () => {
    const a = await matchMaker.joinOrCreate('ellibir', { mode: 'solo', table: 4 }, auth);
    const b = await matchMaker.joinOrCreate('ellibir', { mode: 'solo', table: 4 }, auth);
    const c = await matchMaker.joinOrCreate('ellibir', { mode: 'duo', table: 4 }, auth);
    expect(b.roomId).toBe(a.roomId);
    expect(c.roomId).not.toBe(a.roomId);
  });
});
