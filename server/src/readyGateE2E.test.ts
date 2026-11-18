/**
 * 6.9 HAZIR SİSTEMİ — gerçek websocket + Colyseus SDK ile uçtan uca:
 *  - yeni istemciler (readyGate) masa dolunca BEKLER, herkes HAZIR deyince 3 sn'de başlar
 *  - süre dolunca HAZIR demeyen izleyiciye düşer
 *  - masa sahibi bekleyen oyuncuyu atar; atılan 10 dk oturamaz
 *  - masada eski (6.7) istemci varsa eski otomatik başlangıç sürer
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client, Room as ClientRoom } from '@colyseus/sdk';
import { EllibirRoom } from './rooms/EllibirRoom';
import { OkeyRoom } from './rooms/OkeyRoom';
import { TavlaRoom } from './rooms/TavlaRoom';

vi.mock('./supabase', async original => ({
  ...await original<typeof import('./supabase')>(),
  requireVerifiedUser: vi.fn(async (token: string) => {
    const m = /^tok-([A-Za-z0-9]+)$/.exec(String(token ?? ''));
    if (!m) throw new Error('auth_required');
    return `user-${m[1]}`;
  }),
  isGameBanned: vi.fn(async () => false), isChatBanned: vi.fn(async () => false), fetchCanak: vi.fn(async () => 0),
  resolveClientProfileMeta: vi.fn(async () => ({ name: 'Tester', role: 'normal', gender: 'e', adminBadgeHidden: false })),
  keepSeatPresence: vi.fn(async () => {}), clearSeatPresence: vi.fn(async () => {}),
}));

let server: Server, endpoint: string;
let open: ClientRoom[] = [];

beforeAll(async () => {
  process.env.READY_TIMEOUT_MS = '2500';
  const app = express();
  const http = createServer(app);
  server = new Server({ transport: new WebSocketTransport({ server: http }), greet: false });
  server.define('ellibir', EllibirRoom).filterBy(['mode', 'table']);
  server.define('okey', OkeyRoom).filterBy(['mode', 'table', 'variant']);
  server.define('tavla', TavlaRoom).filterBy(['mode', 'table']);
  await server.listen(0, '127.0.0.1');
  endpoint = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}, 30000);
afterEach(async () => {
  for (const c of open) if (c.connection.isOpen) try { await c.leave(true); } catch { /* yoksay */ }
  open = [];
  await Promise.all(matchMaker.disconnectAll());
});
afterAll(async () => { delete process.env.READY_TIMEOUT_MS; await server?.gracefullyShutdown(false); });

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(test: () => boolean, timeout = 15000, label = 'condition') {
  const end = Date.now() + timeout;
  while (!test()) { if (Date.now() > end) throw new Error('timeout: ' + label); await delay(25); }
}

type Game = 'ellibir' | 'okey' | 'tavla';
let tableSeq = 300;

interface P { conn: ClientRoom; msgs: string[]; seat: number; token: string }
async function fullTable(game: Game, readyFlags: boolean[]) {
  const opts: any = { mode: 'solo', table: ++tableSeq };
  if (game === 'okey') opts.variant = 'duz';
  const listing = await matchMaker.handleCreateRoom(game, opts);
  const room: any = matchMaker.getLocalRoomById(listing.roomId);
  const players: P[] = [];
  for (let i = 0; i < readyFlags.length; i++) {
    const token = `tok-rg${game}${tableSeq}p${i}`;
    const client = new Client(endpoint);
    const conn = await client.joinById(listing.roomId, { ...opts, token, populationVersion: 1, ihalePilotVersion: 1, readyGate: readyFlags[i] });
    const msgs: string[] = [];
    conn.onMessage('*', (type: any) => { msgs.push(String(type)); });
    open.push(conn);
    await until(() => room.seats.get(conn.sessionId) != null, 5000, 'seat');
    players.push({ conn, msgs, seat: room.seats.get(conn.sessionId), token });
  }
  return { room, players, opts, roomId: listing.roomId };
}

const SIZES: Record<Game, number> = { ellibir: 4, okey: 4, tavla: 2 };

describe.each(['tavla', 'okey', 'ellibir'] as Game[])('%s hazır sistemi', game => {
  const n = SIZES[game];

  it('masa dolunca bekler; herkes HAZIR deyince 3 sn sonra başlar', async () => {
    const t = await fullTable(game, Array(n).fill(true));
    await until(() => t.players.every(p => p.msgs.includes('tableFull')), 3000, 'tableFull');
    await delay(1200);
    expect(t.room.game).toBeFalsy();
    expect(t.room.startTimer).toBeFalsy();
    for (const p of t.players) p.conn.send('preReady', {});
    await until(() => !!t.room.startTimer, 3000, 'countdown');
    expect(t.room.startDelay).toBe(3000);
    await until(() => !!t.room.game, 6000, 'game start');
  }, 30000);

  it('süre dolunca HAZIR demeyen izleyiciye düşer', async () => {
    const t = await fullTable(game, Array(n).fill(true));
    for (const p of t.players.slice(0, n - 1)) p.conn.send('preReady', {});
    const lazy = t.players[n - 1];
    await until(() => lazy.msgs.includes('readyTimeout'), 6000, 'readyTimeout');
    expect(t.room.seats.get(lazy.conn.sessionId)).toBeUndefined();
    expect(t.room.spectators.has(lazy.conn.sessionId)).toBe(true);
    expect(t.room.game).toBeFalsy();
    expect(t.room.readyGate.ready.size).toBe(0);
  }, 30000);

  it('masa sahibi bekleyeni atar; atılan oturamaz, sahip olmayan atamaz', async () => {
    const t = await fullTable(game, Array(n).fill(true));
    const owner = t.players[0], other = t.players[1];
    other.conn.send('kick', { seat: owner.seat });           // sahip değil → olmaz
    await delay(300);
    expect(t.room.seats.get(owner.conn.sessionId)).toBe(owner.seat);
    owner.conn.send('kick', { seat: other.seat });
    await until(() => other.msgs.includes('kicked'), 3000, 'kicked');
    expect(t.room.spectators.has(other.conn.sessionId)).toBe(true);
    other.conn.send('sit', { seat: other.seat });
    await delay(400);
    expect(t.room.seats.get(other.conn.sessionId)).toBeUndefined();
    expect(other.msgs.filter(m => m === 'sitError').length).toBeGreaterThan(0);
  }, 30000);

  it('masada eski istemci varsa eski otomatik başlangıç sürer', async () => {
    const t = await fullTable(game, [false, ...Array(n - 1).fill(true)]);
    await until(() => !!t.room.startTimer, 3000, 'auto countdown');
    expect(t.room.startDelay).toBe(7000);
    expect(t.players.some(p => p.msgs.includes('tableFull'))).toBe(false);
  }, 30000);
});
