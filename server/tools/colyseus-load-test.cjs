#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

try {
  const NodeWebSocket = require('ws');
  if (typeof global.WebSocket === 'undefined') global.WebSocket = NodeWebSocket;
  if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = NodeWebSocket;
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
} catch {}

function requireColyseus() {
  try { return require('@colyseus/sdk'); } catch {}
  if (process.env.COLYSEUS_SDK_PATH) return require(process.env.COLYSEUS_SDK_PATH);
  const tmp = path.join(process.env.LOCALAPPDATA || process.env.TEMP || '', 'Temp', 'ok-load-client', 'node_modules', '@colyseus', 'sdk');
  try { return require(tmp); } catch {}
  throw new Error('Missing @colyseus/sdk. Install it outside the repo or set COLYSEUS_SDK_PATH.');
}

const { Client } = requireColyseus();

function args(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const n = argv[i + 1];
    if (!n || n.startsWith('--')) out[k] = true;
    else { out[k] = n; i++; }
  }
  return out;
}

const opt = args(process.argv);
const URL = String(opt.url || 'ws://localhost:2567');
const ROOMS = Math.max(1, Number(opt.rooms || 10));
const DURATION_MS = Math.max(5000, Number(opt.duration || 60) * 1000);
const RAMP_MS = Math.max(0, Number(opt.ramp || 20) * 1000);
const DROP_RATE = Math.max(0, Math.min(0.7, Number(opt.dropRate || 0.08)));
const OUT = opt.out ? String(opt.out) : '';

const stats = {
  url: URL,
  requestedRooms: ROOMS,
  startedAt: new Date().toISOString(),
  durationSec: DURATION_MS / 1000,
  rampSec: RAMP_MS / 1000,
  dropRate: DROP_RATE,
  roomsCreated: 0,
  clientsTarget: 0,
  clientsJoined: 0,
  joinErrors: 0,
  leaves: 0,
  drops: 0,
  reconnectAttempts: 0,
  views: 0,
  viewBytes: 0,
  commands: 0,
  commandErrors: 0,
  parseErrors: 0,
  latencies: [],
  byGame: {},
  errorKinds: {},
  snapshots: [],
  errors: [],
};

const sessions = [];
const start = performance.now();

function incGame(game, field, n = 1) {
  stats.byGame[game] = stats.byGame[game] || { rooms: 0, clients: 0, joined: 0, views: 0, commands: 0, errors: 0 };
  stats.byGame[game][field] += n;
}

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeJson(raw) {
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { stats.parseErrors++; return null; }
}
function send(session, payload) {
  if (!session.room || session.closed) return;
  session.pending = true;
  session.lastCommandAt = performance.now();
  stats.commands++;
  incGame(session.game, 'commands');
  try { session.room.send('cmd', JSON.stringify(payload)); }
  catch (e) {
    stats.commandErrors++;
    incGame(session.game, 'errors');
    session.pending = false;
    rememberError(session, 'send', e);
  }
  setTimeout(() => { session.pending = false; }, 1200).unref?.();
}
function rememberError(session, where, e) {
  const msg = `${session?.label || '?'} ${where}: ${e?.message || e}`;
  if (stats.errors.length < 50) stats.errors.push(msg);
}
function countErrorKind(session, code, message) {
  const key = `${session.game}:${code || 'err'}:${String(message || '').slice(0, 96)}`;
  stats.errorKinds[key] = (stats.errorKinds[key] || 0) + 1;
}

function scenarioFor(i) {
  const baseTable = 900000 + Math.floor(Date.now() % 10000) * 100 + i;
  const cycle = i % 12;
  // Current production policy:
  // - table 1 keeps the bot-assisted test flow.
  // - numbered/real tables wait for all human seats before starting.
  // The load profile must mirror that, otherwise Okey/51 rooms sit idle and only Tavla is stressed.
  if (cycle === 0 && i < 12) return { room: 'ellibir', game: '51-bot-table1', mode: 'solo', humans: 1, table: 1, bet: 100 };
  if (cycle === 0) return { room: 'ellibir', game: '51-solo-4p', mode: 'solo', humans: 4, table: baseTable, bet: 100 };
  if (cycle === 1) return { room: 'ellibir', game: '51-solo-4p', mode: 'solo', humans: 4, table: baseTable, bet: 100 };
  if (cycle === 2) return { room: 'ellibir', game: '51-duo-4p', mode: 'duo', humans: 4, table: baseTable, bet: 100 };
  if (cycle === 3 && i < 12) return { room: 'okey', game: 'okey-duz-bot-table1', mode: 'solo', humans: 1, table: 1, variant: 'duz', bet: 500 };
  if (cycle === 3) return { room: 'okey', game: 'okey-duz-4p', mode: 'solo', humans: 4, table: baseTable, variant: 'duz', bet: 500 };
  if (cycle === 4) return { room: 'okey', game: 'okey-101-4p', mode: 'solo', humans: 4, table: baseTable, variant: 'yuzbir', bet: 500 };
  if (cycle === 5) return { room: 'tavla', game: 'tavla-duo', mode: 'duo', humans: 2, table: baseTable, bet: 500 };
  if (cycle === 6 && i < 12) return { room: 'okey', game: 'okey-banko-bot-table1', mode: 'solo', humans: 1, table: 1, variant: 'banko', bet: 500 };
  if (cycle === 6) return { room: 'okey', game: 'okey-banko-4p', mode: 'solo', humans: 4, table: baseTable, variant: 'banko', bet: 500 };
  if (cycle === 7 && i < 12) return { room: 'tavla', game: 'tavla-bot-table1', mode: 'solo', humans: 1, table: 1, bet: 500 };
  if (cycle === 7) return { room: 'tavla', game: 'tavla-duo', mode: 'duo', humans: 2, table: baseTable, bet: 500 };
  if (cycle === 8) return { room: 'okey', game: 'okey-duz-duo-4p', mode: 'duo', humans: 4, table: baseTable, variant: 'duz', bet: 500 };
  if (cycle === 9) return { room: 'okey', game: 'okey-101-duo-4p', mode: 'duo', humans: 4, table: baseTable, variant: 'yuzbir', bet: 500 };
  if (cycle === 10) return { room: 'okey', game: 'okey-quad-4p', mode: 'quad', humans: 4, table: baseTable, variant: 'duz', bet: 500 };
  return { room: 'tavla', game: 'tavla-duo', mode: 'duo', humans: 2, table: baseTable, bet: 500 };
}

function optionsFor(sc, seatIndex) {
  const name = `LT_${sc.game}_${sc.table}_${seatIndex}`;
  const common = { mode: sc.mode, table: sc.table, playerName: name, gender: seatIndex % 2 ? 'female' : 'male', role: 'normal', bet: sc.bet || 0 };
  if (sc.room === 'ellibir') {
    return { ...common, rules: { totalHands: 2, turnTimerSeconds: 8 } };
  }
  if (sc.room === 'okey') {
    return {
      ...common,
      variant: sc.variant,
      rules: { variant: sc.variant, totalEls: sc.variant === 'banko' ? 2 : 1, turnTimerSeconds: 8, scoring: { startScore: sc.variant === 'yuzbir' ? 0 : 500 } },
    };
  }
  return { ...common, rules: { targetScore: 2, turnTimerSeconds: 8 } };
}

async function joinScenario(sc) {
  stats.roomsCreated++;
  incGame(sc.game, 'rooms');
  const promises = [];
  for (let h = 0; h < sc.humans; h++) {
    stats.clientsTarget++;
    incGame(sc.game, 'clients');
    promises.push(joinOne(sc, h));
    await sleep(20 + Math.random() * 60);
  }
  await Promise.allSettled(promises);
}

async function joinOne(sc, seatIndex) {
  const client = new Client(URL);
  const label = `${sc.game}#${sc.table}/${seatIndex}`;
  const session = {
    client, room: null, scenario: sc, game: sc.game, label, seat: -99,
    closed: false, pending: false, lastCommandAt: 0, views: 0, commands: 0,
    bankoPhaseKey: '',
  };
  sessions.push(session);
  try {
    const room = await client.joinOrCreate(sc.room, optionsFor(sc, seatIndex));
    session.room = room;
    stats.clientsJoined++;
    incGame(sc.game, 'joined');
    room.onMessage('seat', (m) => { if (m && typeof m.seat === 'number') session.seat = m.seat; });
    room.onMessage('moveError', (m) => {
      stats.commandErrors++;
      incGame(sc.game, 'errors');
      countErrorKind(session, m?.code, m?.message);
      if (session.lastCommandAt) {
        stats.latencies.push(performance.now() - session.lastCommandAt);
        if (stats.latencies.length > 5000) stats.latencies.splice(0, stats.latencies.length - 5000);
        session.lastCommandAt = 0;
      }
      session.pending = false;
      if (session.game.startsWith('okey') && m?.message && String(m.message).includes('soldan')) send(session, { t: 'returnLeft' });
    });
    room.onMessage('view', (raw) => {
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      stats.views++;
      stats.viewBytes += Buffer.byteLength(text);
      incGame(sc.game, 'views');
      session.views++;
      if (session.lastCommandAt) {
        stats.latencies.push(performance.now() - session.lastCommandAt);
        if (stats.latencies.length > 5000) stats.latencies.splice(0, stats.latencies.length - 5000);
        session.lastCommandAt = 0;
      }
      session.pending = false;
      const view = safeJson(raw);
      if (view) drive(session, view);
    });
    room.onError((code, message) => {
      stats.commandErrors++;
      incGame(sc.game, 'errors');
      rememberError(session, `roomError ${code}`, { message });
    });
    room.onLeave((code) => {
      session.closed = true;
      if (code === 4000) stats.leaves++;
      else stats.drops++;
    });
    maybeScheduleDrop(session);
  } catch (e) {
    stats.joinErrors++;
    incGame(sc.game, 'errors');
    rememberError(session, 'join', e);
  }
}

function maybeScheduleDrop(session) {
  if (Math.random() >= DROP_RATE) return;
  const after = 15000 + Math.random() * Math.max(5000, DURATION_MS - 20000);
  setTimeout(() => {
    if (!session.room || session.closed) return;
    try {
      if (Math.random() < 0.55 && session.room.connection?.close) session.room.connection.close();
      else session.room.leave();
    } catch {}
  }, after).unref?.();
}

function drive(session, v) {
  if (session.closed || session.pending || session.seat < 0 || v.spectator) return;
  if (session.game.startsWith('51')) return drive51(session, v);
  if (session.game.startsWith('okey')) return driveOkey(session, v);
  if (session.game.startsWith('tavla')) return driveTavla(session, v);
}

function delayed(session, fn) {
  session.pending = true;
  setTimeout(() => {
    session.pending = false;
    if (!session.closed) fn();
  }, 40 + Math.random() * 220).unref?.();
}

function drive51(session, v) {
  if (v.sorguActive) {
    const s = v.seat;
    if (v.sorguAsama === 'ortakGorus' && s === v.sorguPartnerSeat)
      return delayed(session, () => send(session, { t: 'move', move: { type: 'sorguOrtakGorus', gorus: Math.random() < 0.7 ? 'ver' : 'verme' } }));
    if (v.sorguAsama === 'cevap' && s === v.sorguSorulanSeat)
      return delayed(session, () => send(session, { t: 'move', move: { type: 'sorguCevap', cevap: Math.random() < 0.6 ? 'ver' : 'verme' } }));
    if (v.sorguAsama === 'sonuc' && s === v.sorguAskerSeat)
      return delayed(session, () => send(session, { t: 'move', move: { type: 'sorguSonuc', al: Math.random() < 0.35 } }));
    return;
  }
  if (!v.yourTurn) return;
  if (v.phase === 'draw') {
    const take = v.hasDiscard && !v.discardLocked && Math.random() < 0.18;
    return delayed(session, () => send(session, { t: 'move', move: { type: take ? 'pickupDiscard' : 'drawStock' } }));
  }
  if (v.phase !== 'action') return;
  const hand = Array.isArray(v.myHand) ? v.myHand : [];
  if (v.canCancelPickup && Math.random() < 0.12) return delayed(session, () => send(session, { t: 'move', move: { type: 'cancelPickup' } }));
  const islek = hand.find((c) => c && Array.isArray(c.targets) && c.targets.length > 0);
  if (islek && Math.random() < 0.2) return delayed(session, () => send(session, { t: 'isle', cardId: islek.id }));
  if (!v.hasOpened && Math.random() < 0.05) return delayed(session, () => send(session, { t: Math.random() < 0.5 ? 'autoOpenSeri' : 'autoOpenCift' }));
  const card = rand(hand.filter((c) => c && c.id));
  if (card) delayed(session, () => send(session, { t: 'move', move: { type: 'discard', cardId: card.id } }));
}

function driveOkey(session, v) {
  if (v.bankoPhase) {
    if (Array.isArray(v.bankoChoice) && v.bankoChoice[v.seat] !== -1) return;
    const key = `${v.elNumber}:${v.seat}`;
    if (session.bankoPhaseKey !== key) {
      session.bankoPhaseKey = key;
      delayed(session, () => send(session, { t: Math.random() < 0.25 ? 'banko' : 'pas' }));
    }
    return;
  }
  if (v.elEnded || v.matchEnded || v.waitingForPlayers || v.starting || v.turn !== v.seat) return;
  if (v.phase === 'draw') {
    const leftSeat = (v.seat + 3) % 4;
    const left = v[`disc${leftSeat}`] || [];
    const from = Array.isArray(left) && left.length > 0 && Math.random() < 0.12 ? 'left' : 'pile';
    return delayed(session, () => send(session, { t: 'draw', from }));
  }
  if (v.phase !== 'discard') return;
  if (v.myPendingLeft && Math.random() < 0.35) return delayed(session, () => send(session, { t: 'returnLeft' }));
  const hand = Array.isArray(v.myHand) ? v.myHand : [];
  const tile = rand(hand.filter((t) => t && t.id));
  if (tile) delayed(session, () => send(session, { t: 'discard', tileId: tile.id }));
}

function ownCount(v, pl, i) {
  const n = Number(v.points?.[i] || 0);
  return pl === 0 ? Math.max(0, n) : Math.max(0, -n);
}
function oppCount(v, pl, i) { return ownCount(v, 1 - pl, i); }
function allHome(v, pl) {
  if ((pl === 0 ? v.bar0 : v.bar1) > 0) return false;
  for (let i = 0; i < 24; i++) {
    const home = pl === 0 ? i <= 5 : i >= 18;
    if (!home && ownCount(v, pl, i) > 0) return false;
  }
  return true;
}
function stepFor(v, pl, from, die) {
  if (die < 1 || die > 6) return null;
  const bar = pl === 0 ? v.bar0 : v.bar1;
  if (bar > 0) {
    if (from !== -1) return null;
    const to = pl === 0 ? 24 - die : die - 1;
    if (oppCount(v, pl, to) >= 2) return null;
    return { from: -1, to, die };
  }
  if (from < 0 || from > 23 || ownCount(v, pl, from) === 0) return null;
  const to = pl === 0 ? from - die : from + die;
  if (to >= 0 && to <= 23) {
    if (oppCount(v, pl, to) >= 2) return null;
    return { from, to, die };
  }
  if (!allHome(v, pl)) return null;
  const exact = pl === 0 ? from === die - 1 : from === 24 - die;
  if (exact) return { from, to: -1, die };
  if (pl === 0) {
    if (to >= 0) return null;
    for (let i = from + 1; i <= 5; i++) if (ownCount(v, pl, i) > 0) return null;
    return { from, to: -1, die };
  }
  if (to <= 23) return null;
  for (let i = from - 1; i >= 18; i--) if (ownCount(v, pl, i) > 0) return null;
  return { from, to: -1, die };
}
function legalSteps(v, pl) {
  const out = [];
  const dies = [...new Set(Array.isArray(v.movesLeft) ? v.movesLeft : [])];
  for (const die of dies) {
    const bar = pl === 0 ? v.bar0 : v.bar1;
    if (bar > 0) {
      const s = stepFor(v, pl, -1, die);
      if (s) out.push(s);
      continue;
    }
    for (let i = 0; i < 24; i++) {
      const s = stepFor(v, pl, i, die);
      if (s) out.push(s);
    }
  }
  return out;
}
function driveTavla(session, v) {
  if (v.gameEnded || v.matchEnded || v.waitingForPlayers || v.starting) return;
  if (v.pendingResign >= 0 && v.seat === 1 - v.pendingResign)
    return delayed(session, () => send(session, { t: Math.random() < 0.65 ? 'acceptResign' : 'declineResign' }));
  if (v.pendingDouble >= 0 && v.seat === 1 - v.pendingDouble)
    return delayed(session, () => send(session, { t: Math.random() < 0.75 ? 'takeDouble' : 'dropDouble' }));
  if (v.turn !== v.seat) return;
  if (v.phase === 'roll') {
    if (Math.random() < 0.03 && Number(v.cubeValue || 1) < 8) return delayed(session, () => send(session, { t: 'double' }));
    return delayed(session, () => send(session, { t: 'roll' }));
  }
  if (v.phase === 'move') {
    const steps = legalSteps(v, v.seat);
    const step = rand(steps);
    if (step) delayed(session, () => send(session, { t: 'move', from: step.from, die: step.die }));
  }
}

function snapshot() {
  const now = performance.now();
  const elapsed = (now - start) / 1000;
  const mem = process.memoryUsage();
  stats.snapshots.push({
    t: Number(elapsed.toFixed(1)),
    joined: stats.clientsJoined,
    views: stats.views,
    commands: stats.commands,
    errors: stats.commandErrors + stats.joinErrors,
    rssMb: Math.round(mem.rss / 1024 / 1024),
    heapMb: Math.round(mem.heapUsed / 1024 / 1024),
  });
}

function summarize() {
  const elapsed = (performance.now() - start) / 1000;
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const pct = (p) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]) : 0;
  const result = { ...stats };
  delete result.latencies;
  return {
    ...result,
    finishedAt: new Date().toISOString(),
    elapsedSec: Number(elapsed.toFixed(2)),
    viewsPerSec: Number((stats.views / Math.max(1, elapsed)).toFixed(2)),
    commandsPerSec: Number((stats.commands / Math.max(1, elapsed)).toFixed(2)),
    avgViewBytes: stats.views ? Math.round(stats.viewBytes / stats.views) : 0,
    latencyMs: { samples: sorted.length, p50: pct(0.5), p90: pct(0.9), p95: pct(0.95), p99: pct(0.99) },
  };
}

async function main() {
  console.log(`[load] url=${URL} rooms=${ROOMS} duration=${DURATION_MS / 1000}s ramp=${RAMP_MS / 1000}s dropRate=${DROP_RATE}`);
  const scenarios = Array.from({ length: ROOMS }, (_, i) => scenarioFor(i));
  const interval = ROOMS > 1 ? RAMP_MS / (ROOMS - 1) : 0;
  const snap = setInterval(snapshot, 5000);
  snap.unref?.();

  for (let i = 0; i < scenarios.length; i++) {
    joinScenario(scenarios[i]).catch((e) => {
      stats.joinErrors++;
      if (stats.errors.length < 50) stats.errors.push(`scenario ${i}: ${e?.message || e}`);
    });
    if (interval > 0) await sleep(interval);
  }
  await sleep(DURATION_MS);
  for (const s of sessions) {
    if (!s.room || s.closed) continue;
    try { await s.room.leave(); } catch {}
  }
  await sleep(1000);
  clearInterval(snap);
  snapshot();
  const result = summarize();
  const json = JSON.stringify(result, null, 2);
  if (OUT) fs.writeFileSync(OUT, json);
  console.log(json);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
