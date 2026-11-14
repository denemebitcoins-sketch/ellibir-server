/**
 * GERÇEK websocket + Colyseus SDK ile kopma / geri bağlanma / bot masası kapanma senaryoları.
 * Supabase ve kimlik doğrulama sahte; oda mantığı canlıdakiyle aynı. Geri dönme penceresi testte 3 sn.
 *   - ağ kopması / arka plan: anormal kopuş → token ile aynı koltuğa dönüş, bot kontrolü bırakır
 *   - uygulamayı kapatıp açma: token'sız yeni oturum, aynı hesap → koltuğu geri alır (izleyiciye düşmez)
 *   - herkes çıkar / herkes kopup süre dolar → oda kapanır
 *   - bir kişinin süresi dolar, diğerleri sürer → oda açık; son insan çıkınca kapanır
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client, Room as ClientRoom } from '@colyseus/sdk';
import { EllibirRoom } from './rooms/EllibirRoom';
import { IhaleRoom } from './rooms/IhaleRoom';
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

const WINDOW_SEC = 3;
let server: Server, endpoint: string;
let open: ClientRoom[] = [];

beforeAll(async () => {
  process.env.RECONNECT_WINDOW_SEC = String(WINDOW_SEC);
  const app = express(); app.get('/health', (_q, r) => r.json({ ok: true }));
  const http = createServer(app);
  server = new Server({ transport: new WebSocketTransport({ server: http }), greet: false });
  server.define('ellibir', EllibirRoom).filterBy(['mode', 'table']);
  server.define('ihale', IhaleRoom).filterBy(['mode', 'table']);
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
afterAll(async () => { delete process.env.RECONNECT_WINDOW_SEC; await server?.gracefullyShutdown(false); });

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(test: () => boolean, timeout = 15000, label = 'condition') {
  const end = Date.now() + timeout;
  while (!test()) { if (Date.now() > end) throw new Error('timeout: ' + label); await delay(25); }
}

type Game = 'ellibir' | 'ihale' | 'okey' | 'tavla';
const GAMES: Game[] = ['ellibir', 'ihale', 'okey', 'tavla'];
let tableSeq = 20;

interface Table { room: any; roomId: string; players: { token: string; client: Client; conn: ClientRoom; seat: number }[] }

function seatOf(room: any, sessionId: string): number | undefined { return room.seats.get(sessionId); }
function abandoned(game: Game, room: any, seat: number): boolean {
  return game === 'ellibir' || game === 'ihale' ? !!room.game?.abandoned?.includes(seat) : !!room.abandoned?.has(seat);
}
const disposed = (roomId: string) => !matchMaker.getLocalRoomById(roomId);

async function startedTable(game: Game): Promise<Table> {
  const n = game === 'tavla' ? 2 : 4;
  const opts: any = { mode: 'solo', table: ++tableSeq };
  if (game === 'okey') opts.variant = 'duz';
  const listing = await matchMaker.handleCreateRoom(game, opts);
  const room: any = matchMaker.getLocalRoomById(listing.roomId);
  const players: Table['players'] = [];
  for (let i = 0; i < n; i++) {
    const token = `tok-${game}${tableSeq}p${i}`;
    const client = new Client(endpoint);
    const conn = await client.joinById(listing.roomId, { ...opts, token, populationVersion: 1, ihalePilotVersion: 1 });
    conn.onMessage('*', () => {});
    open.push(conn);
    await until(() => seatOf(room, conn.sessionId) != null, 5000, 'seat');
    players.push({ token, client, conn, seat: seatOf(room, conn.sessionId)! });
  }
  await until(() => !!room.game, 20000, 'game start');
  return { room, roomId: listing.roomId, players };
}

/** Anormal kopuş (ağ / arka plan): SDK'nın kendi yeniden bağlanması kapalı. */
function drop(t: Table, i: number) {
  const p = t.players[i];
  p.conn.reconnection.enabled = false;
  open = open.filter(c => c !== p.conn);
  p.conn.connection.close(4010, 'test network drop');
}

describe.each(GAMES)('%s gerçek bağlantı senaryoları', game => {
  it('ağ kopması / arka plan: token ile aynı koltuğa döner, bot kontrolü bırakır', async () => {
    const t = await startedTable(game);
    const p = t.players[0];
    const token = p.conn.reconnectionToken;
    drop(t, 0);
    await until(() => abandoned(game, t.room, p.seat), 5000, 'abandoned after drop');
    const back = await p.client.reconnect(token);
    back.onMessage('*', () => {}); open.push(back);
    await until(() => !abandoned(game, t.room, p.seat), 5000, 'control back');
    expect(seatOf(t.room, back.sessionId)).toBe(p.seat);
    expect(t.room.spectators?.has?.(back.sessionId) ?? false).toBe(false);
    expect(disposed(t.roomId)).toBe(false);
  }, 40000);

  it('uygulamayı kapatıp açma: token olmadan aynı hesap koltuğunu geri alır', async () => {
    const t = await startedTable(game);
    const p = t.players[1];
    drop(t, 1);
    await until(() => abandoned(game, t.room, p.seat), 5000, 'abandoned after drop');
    const fresh = new Client(endpoint);
    const conn = await fresh.joinById(t.roomId, { mode: 'solo', table: t.room.metadata?.table, variant: 'duz', token: p.token, populationVersion: 1, ihalePilotVersion: 1 });
    conn.onMessage('*', () => {}); open.push(conn);
    await until(() => seatOf(t.room, conn.sessionId) === p.seat, 5000, 'seat reclaimed');
    await until(() => !abandoned(game, t.room, p.seat), 5000, 'control back');
    expect(t.room.spectators?.has?.(conn.sessionId) ?? false).toBe(false);
  }, 40000);

  it('herkes masadan çıkınca oda kapanır', async () => {
    const t = await startedTable(game);
    for (const p of t.players) { open = open.filter(c => c !== p.conn); await p.conn.leave(true); }
    await until(() => disposed(t.roomId), 8000, 'room disposed');
  }, 40000);

  it('herkes kopup geri dönme süresi dolunca oda kapanır', async () => {
    const t = await startedTable(game);
    for (let i = 0; i < t.players.length; i++) drop(t, i);
    await until(() => disposed(t.roomId), (WINDOW_SEC + 6) * 1000, 'room disposed after expiry');
  }, 40000);

  it('ağ değişimi: sunucu eski bağlantıyı henüz düşürmemişken aynı hesap yeniden girer → koltuğu alır', async () => {
    const t = await startedTable(game);
    const p = t.players[2 % t.players.length];
    // Eski bağlantı sunucuda hâlâ AÇIK (telefon ağı değiştirdi / uygulama yeniden açıldı, eski soket ölmedi).
    p.conn.reconnection.enabled = false;
    const fresh = new Client(endpoint);
    const conn = await fresh.joinById(t.roomId, { mode: 'solo', table: t.room.metadata?.table, variant: 'duz', token: p.token, populationVersion: 1, ihalePilotVersion: 1 });
    conn.onMessage('*', () => {}); open.push(conn);
    await until(() => seatOf(t.room, conn.sessionId) === p.seat, 12000, 'seat taken over by new session');
    await until(() => !abandoned(game, t.room, p.seat), 12000, 'control with new session');
    expect(t.room.spectators?.has?.(conn.sessionId) ?? false).toBe(false);
  }, 40000);

  it('hızlı dönüş: sunucu kopmayı fark etmeden token ile geri bağlanma koltuğu korur', async () => {
    const t = await startedTable(game);
    const p = t.players[1];
    const token = p.conn.reconnectionToken;
    // Eski soket sunucuda açık kalır (uygulama arka plandan hızla döndü, ağ değişti).
    p.conn.reconnection.enabled = false;
    // Unity istemcisi gibi: "failed to reconnect" süre dolması sayılmaz, birkaç saniyede bir yeniden denenir.
    let back: ClientRoom | null = null;
    const end = Date.now() + 25000;
    while (!back && Date.now() < end) {
      try { back = await new Client(endpoint).reconnect(token); }
      catch (e: any) { expect(String(e?.message)).not.toMatch(/reservation expired|reconnection expired/i); await delay(1500); }
    }
    expect(back).not.toBeNull();
    back!.onMessage('*', () => {}); open.push(back!);
    await until(() => seatOf(t.room, back!.sessionId) === p.seat, 12000, 'seat kept on fast token return');
    await until(() => !abandoned(game, t.room, p.seat), 12000, 'control after fast return');
  }, 40000);

  it('masa başlamadan önce kopup dönen oyuncu koltuğunu korur ve oyun onunla başlar', async () => {
    const n = game === 'tavla' ? 2 : 4;
    const opts: any = { mode: 'solo', table: ++tableSeq };
    if (game === 'okey') opts.variant = 'duz';
    const listing = await matchMaker.handleCreateRoom(game, opts);
    const room: any = matchMaker.getLocalRoomById(listing.roomId);
    const conns: { client: Client; conn: ClientRoom; seat: number }[] = [];
    for (let i = 0; i < n - 1; i++) {
      const client = new Client(endpoint);
      const conn = await client.joinById(listing.roomId, { ...opts, token: `tok-w${tableSeq}p${i}`, populationVersion: 1, ihalePilotVersion: 1 });
      conn.onMessage('*', () => {}); open.push(conn);
      await until(() => seatOf(room, conn.sessionId) != null, 5000, 'seat');
      conns.push({ client, conn, seat: seatOf(room, conn.sessionId)! });
    }
    const w = conns[0];
    const token = w.conn.reconnectionToken;
    w.conn.reconnection.enabled = false; open = open.filter(c => c !== w.conn);
    w.conn.connection.close(4010, 'waiting drop');
    await delay(800);
    const back = await w.client.reconnect(token);
    back.onMessage('*', () => {}); open.push(back);
    await until(() => seatOf(room, back.sessionId) === w.seat, 5000, 'waiting seat kept');
    const last = new Client(endpoint);
    const lc = await last.joinById(listing.roomId, { ...opts, token: `tok-w${tableSeq}last`, populationVersion: 1, ihalePilotVersion: 1 });
    lc.onMessage('*', () => {}); open.push(lc);
    await until(() => !!room.game, 20000, 'game start');
    expect(abandoned(game, room, w.seat)).toBe(false);
  }, 40000);

  it('masa başlamadan kopan oyuncunun süresi dolarsa koltuk boşalır; bekleyen herkes çıkınca oda kapanır', async () => {
    const opts: any = { mode: 'solo', table: ++tableSeq };
    if (game === 'okey') opts.variant = 'duz';
    const listing = await matchMaker.handleCreateRoom(game, opts);
    const room: any = matchMaker.getLocalRoomById(listing.roomId);
    const a = await new Client(endpoint).joinById(listing.roomId, { ...opts, token: `tok-x${tableSeq}a`, populationVersion: 1, ihalePilotVersion: 1 });
    const b = await new Client(endpoint).joinById(listing.roomId, { ...opts, token: `tok-x${tableSeq}b`, populationVersion: 1, ihalePilotVersion: 1 });
    a.onMessage('*', () => {}); b.onMessage('*', () => {}); open.push(a, b);
    await until(() => room.seats.size === 2, 5000, 'two seated');
    a.reconnection.enabled = false; open = open.filter(c => c !== a);
    a.connection.close(4010, 'waiting drop');
    await until(() => room.seats.size === 1, (WINDOW_SEC + 4) * 1000, 'seat freed after expiry');
    expect(disposed(listing.roomId)).toBe(false);
    open = open.filter(c => c !== b); await b.leave(true);
    await until(() => disposed(listing.roomId), 8000, 'empty waiting room disposed');
  }, 40000);

  it('bir kişinin süresi dolar, diğerleri sürer; son insan çıkınca oda kapanır', async () => {
    const t = await startedTable(game);
    const p = t.players[0];
    drop(t, 0);
    await delay((WINDOW_SEC + 1.5) * 1000);
    expect(disposed(t.roomId)).toBe(false);
    expect(abandoned(game, t.room, p.seat)).toBe(true); // kalıcı bot
    for (const q of t.players.slice(1)) { open = open.filter(c => c !== q.conn); await q.conn.leave(true); }
    await until(() => disposed(t.roomId), 8000, 'room disposed when last human left');
  }, 40000);
});
