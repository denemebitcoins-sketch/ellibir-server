import { Server } from '@colyseus/core';
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

// "ellibir" odası — masa. Matchmaking: joinOrCreate("ellibir", {...}).
gameServer.define('ellibir', EllibirRoom);

gameServer.listen(port);
console.log(`[Elli Bir] Colyseus dinleniyor: ws://localhost:${port}`);
