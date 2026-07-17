// Editor'da Unity Services init ~30sn Editor'ı bloklayabiliyor → consume geç kalıp
// "seat reservation expired" oluyor. Rezervasyon penceresini genişlet (import'tan ÖNCE).
process.env.COLYSEUS_SEAT_RESERVATION_TIME = '60';

import './nodeGlobals';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';
import { createServer } from 'http';
import { EllibirRoom } from './rooms/EllibirRoom';
import { OkeyRoom } from './rooms/OkeyRoom';
import { TavlaRoom } from './rooms/TavlaRoom';
import { handleAdMobSsv, verifyPlayPurchase } from './monetization';
import { startPushWorker } from './pushWorker';
import { emailAuthStatus, requestEmailCode, verifyEmailCode } from './emailAuth';

const port = Number(process.env.PORT) || 2567;

const app = express();
app.use(express.json({ limit: '96kb' }));
app.get('/', (_req, res) => res.send('Elli Bir Colyseus sunucusu çalışıyor ✦'));
app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'ellibir-server',
  okey101Deal: true,
  commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'local',
}));
app.get('/auth/email/status', (_req, res) => res.json(emailAuthStatus()));
app.post('/auth/email/send-code', async (req, res) => {
  try {
    res.json(await requestEmailCode(req));
  } catch (error: any) {
    const message = String(error?.message || 'email_code_failed');
    const status = message === 'auth_required' ? 401
      : message === 'email_provider_not_configured' || message === 'server_not_configured' || message === 'email_send_timeout' ? 503
      : message === 'email_not_found' ? 404
      : 400;
    res.status(status).json({ ok: false, error: message });
  }
});
app.post('/auth/email/verify-code', async (req, res) => {
  try {
    res.json(await verifyEmailCode(req));
  } catch (error: any) {
    const message = String(error?.message || 'email_verify_failed');
    const status = message === 'auth_required' ? 401
      : message === 'email_provider_not_configured' || message === 'server_not_configured' || message === 'email_send_timeout' ? 503
      : 400;
    res.status(status).json({ ok: false, error: message });
  }
});
app.get('/monetization/admob/ssv', async (req, res) => {
  try {
    await handleAdMobSsv(req);
    res.status(200).send('ok');
  } catch (error: any) {
    console.error('[admob-ssv]', error?.message);
    res.status(400).send('invalid');
  }
});
app.post('/monetization/google-play/verify', async (req, res) => {
  try {
    const result = await verifyPlayPurchase(req.header('authorization'), String(req.body?.receipt || ''), String(req.body?.product_id || ''));
    res.json(result);
  } catch (error: any) {
    const message = String(error?.message || 'verification_failed');
    const status = message === 'auth_required' ? 401 : message === 'play_verifier_not_configured' ? 503 : 400;
    res.status(status).json({ ok: false, error: message });
  }
});

const httpServer = createServer(app);
// DÜŞME ALGISI HIZLI OLSUN (P1-a): varsayılan ping ~20-60s → oyuncu kopunca onLeave geç tetikleniyor,
// sıra kopmuş insanda donuyordu. pingInterval 5s + 3 deneme ≈ 15s'te kopma sezilir → onLeave/bot
// devralma hızlanır. (Çok agresif yapma: mobil ağ gecikmesinde yanlış kopma sayılmasın.)
const gameServer = new Server({
  transport: new WebSocketTransport({
    server: httpServer,
    pingInterval: 5000,    // her 5sn ping
    pingMaxRetries: 3,     // 3 yanıtsız ping → kopuk (≈15sn)
  }),
});

// "ellibir" odası — masa. Matchmaking: joinOrCreate("ellibir", { mode, table }).
// filterBy(mode,table): aynı mod + aynı masa no → AYNI odada buluşur ("Masa 3'te buluşalım").
gameServer.define('ellibir', EllibirRoom).filterBy(['mode', 'table']);
// "okey" odası — aynı matchmaking modeli: joinOrCreate("okey", { mode, table, variant }).
gameServer.define('okey', OkeyRoom).filterBy(['mode', 'table', 'variant']);
// "tavla" odası — 2 kişilik: joinOrCreate("tavla", { mode, table }).
gameServer.define('tavla', TavlaRoom).filterBy(['mode', 'table']);

try { (matchMaker as any).controller.seatReservationTime = 60; } catch {}

gameServer.listen(port);
startPushWorker();
console.log(`[Elli Bir] Colyseus dinleniyor: ws://localhost:${port} (seatRes=60s)`);
