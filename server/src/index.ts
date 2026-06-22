// Editor'da Unity Services init ~30sn Editor'ı bloklayabiliyor → consume geç kalıp
// "seat reservation expired" oluyor. Rezervasyon penceresini genişlet (import'tan ÖNCE).
process.env.COLYSEUS_SEAT_RESERVATION_TIME = '60';

import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';
import { createServer } from 'http';
import { EllibirRoom } from './rooms/EllibirRoom';

const port = Number(process.env.PORT) || 2567;

const app = express();
app.get('/', (_req, res) => res.send('Elli Bir Colyseus sunucusu çalışıyor ✦'));

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// "ellibir" odası — masa. Matchmaking: joinOrCreate("ellibir", { mode, table }).
// filterBy(mode,table): aynı mod + aynı masa no → AYNI odada buluşur ("Masa 3'te buluşalım").
gameServer.define('ellibir', EllibirRoom).filterBy(['mode', 'table']);

try { (matchMaker as any).controller.seatReservationTime = 60; } catch {}

gameServer.listen(port);
console.log(`[Elli Bir] Colyseus dinleniyor: ws://localhost:${port} (seatRes=60s)`);
