import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EllibirRoom } from './rooms/EllibirRoom';
import { IhaleRoom } from './rooms/IhaleRoom';
import { OkeyRoom } from './rooms/OkeyRoom';
import { TavlaRoom } from './rooms/TavlaRoom';
import { keepSeatPresence, clearSeatPresence } from './supabase';
import { createIhaleGame, applyIhaleCommand, ihaleBotCommand, ihaleController } from '../../packages/engine/src/ihale';
import { ihaleRuntime, ihaleClientView } from './cardRoomRuntime';

vi.mock('./supabase', async importOriginal => ({
  ...await importOriginal<object>(), keepSeatPresence: vi.fn(async () => {}), clearSeatPresence: vi.fn(async () => {}),
}));

const rooms = [['51', EllibirRoom, 'duo'], ['ihale', IhaleRoom, 'ihale-duo'],
  ['okey', OkeyRoom, 'okey-duo'], ['tavla', TavlaRoom, 'tavla-duo']] as const;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000000); vi.clearAllMocks(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function fixture(Type: typeof EllibirRoom | typeof OkeyRoom | typeof TavlaRoom) {
  const r: any = new Type();
  Object.defineProperty(r, 'metadata', { value: { table: 12, mode: 'duo' } });
  r.seats.set('a', 0); r.seats.set('b', 1); r.seatUsers.set(0, 'user-a'); r.seatNames.set(0, 'Ayse');
  r.game = { players: [{ seat: 0, name: 'Ayse' }], matchLog: [], phase: 'action' };
  r.humanSeats = [0, 1, 2, 3];
  r.runEngine = vi.fn(); r.afterChange = vi.fn(); r.pushViews = vi.fn();
  let resolve!: (client: any) => void, reject!: (reason: Error) => void;
  r.allowReconnection = vi.fn(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
  const client = { sessionId: 'a', send: vi.fn() };
  const abandoned = () => r.abandoned ? r.abandoned.has(0) : r.game.abandoned?.includes(0) === true;
  return { r, client, abandoned, resolve: () => resolve(client), reject: () => reject(new Error('expired')) };
}

describe.each(rooms)('%s seat recovery', (_name, Type, mode) => {
  it('does not ignore a real second drop immediately after reconnect', async () => {
    const f = fixture(Type); f.r.onReconnect(f.client);
    const drop = f.r.onDrop(f.client);
    expect(f.r.allowReconnection).toHaveBeenCalledOnce(); expect(f.abandoned()).toBe(true);
    f.resolve(); await drop; expect(f.abandoned()).toBe(false); f.r.onDispose();
  });
  it('ignores an old socket close only while a different live socket owns the session', async () => {
    const f = fixture(Type);
    f.r.clients.push({ ...f.client, readyState: 1 });
    await f.r.onDrop(f.client); f.r.onLeave(f.client, 4002);
    expect(f.r.allowReconnection).not.toHaveBeenCalled(); expect(f.r.seats.get('a')).toBe(0);
    expect(clearSeatPresence).not.toHaveBeenCalled(); f.r.onDispose();
  });
  it('marks takeover immediately, restores the same seat, and cancels presence keepalive', async () => {
    const f = fixture(Type); const drop = f.r.onDrop(f.client);
    expect(f.abandoned()).toBe(true);
    expect(f.r.allowReconnection).toHaveBeenCalledWith(f.client, 180);
    expect(keepSeatPresence).toHaveBeenLastCalledWith('user-a', 12, mode, false, true);
    await vi.advanceTimersByTimeAsync(50000);
    f.r.onReconnect(f.client); f.resolve(); await drop;
    expect(f.abandoned()).toBe(false); expect(f.r.seats.get('a')).toBe(0);
    expect(keepSeatPresence).toHaveBeenLastCalledWith('user-a', 12, mode, true, true);
    const count = vi.mocked(keepSeatPresence).mock.calls.length;
    await vi.advanceTimersByTimeAsync(100000);
    expect(keepSeatPresence).toHaveBeenCalledTimes(count);
    expect(clearSeatPresence).not.toHaveBeenCalled(); f.r.onDispose();
  });
  it('expires to a permanent bot and releases the salon seat', async () => {
    const f = fixture(Type); const drop = f.r.onDrop(f.client);
    f.reject(); await drop;
    expect(f.abandoned()).toBe(true); expect(f.r.seats.has('a')).toBe(false);
    expect(clearSeatPresence).toHaveBeenCalledWith('user-a', 12, mode);
    const count = vi.mocked(keepSeatPresence).mock.calls.length;
    await vi.advanceTimersByTimeAsync(100000);
    expect(keepSeatPresence).toHaveBeenCalledTimes(count); f.r.onDispose();
  });
  it('a late reservation rejection cannot leave a live returned player under bot control', async () => {
    const f = fixture(Type); const drop = f.r.onDrop(f.client);
    f.r.clients.push({ ...f.client, readyState: 1 }); f.reject(); await drop;
    expect(f.abandoned()).toBe(false); expect(f.r.seats.get('a')).toBe(0);
    expect(clearSeatPresence).not.toHaveBeenCalled(); f.r.onDispose();
  });
  it('explicit exit cancels a pending reservation and late reconnect cannot reclaim it', async () => {
    const f = fixture(Type); const drop = f.r.onDrop(f.client);
    f.r.onLeave(f.client, 4000); f.resolve(); await drop;
    expect(f.abandoned()).toBe(true); expect(f.r.seats.has('a')).toBe(false);
    expect(clearSeatPresence).toHaveBeenCalledOnce();
    const count = vi.mocked(keepSeatPresence).mock.calls.length;
    await vi.advanceTimersByTimeAsync(100000);
    expect(keepSeatPresence).toHaveBeenCalledTimes(count); f.r.onDispose();
  });
  it('waiting reservation does not incorrectly mark the table as started', async () => {
    const f = fixture(Type); f.r.game = null; const drop = f.r.onDrop(f.client);
    expect(keepSeatPresence).toHaveBeenLastCalledWith('user-a', 12, mode, false, false);
    f.reject(); await drop; expect(f.r.seats.has('a')).toBe(false); f.r.onDispose();
  });
});

it('Ihale bot plays the bidder and dummy on disconnect, then yields both to the returning bidder', async () => {
  const f = fixture(IhaleRoom);
  let s = createIhaleGame({ seed: 4, rules: { teamMode: true, totalHands: 1 } });
  s = applyIhaleCommand(s, { t: 'ihaleBid', revision: 0, bid: 13 }, 0);
  s = applyIhaleCommand(s, { t: 'ihaleTrump', revision: 1, suit: 'S' }, 0);
  for (let n = 0; n < 2; n++) s = applyIhaleCommand(s, ihaleBotCommand(s), ihaleController(s));
  f.r.game = s; expect(s.currentSeat).toBe(2);
  const drop = f.r.onDrop(f.client);
  expect(ihaleClientView(f.r.game, 1).seats[0].abandoned).toBe(true);
  expect(ihaleRuntime.step(f.r.game, seat => f.r.isHumanTurn(seat)).moved).toBe(true);
  f.r.onReconnect(f.client); f.resolve(); await drop;
  expect(ihaleRuntime.step(f.r.game, seat => f.r.isHumanTurn(seat)).moved).toBe(false);
  expect(ihaleClientView(f.r.game, 0).yourTurn).toBe(true); f.r.onDispose();
});
