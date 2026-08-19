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
import { createPinAccount, loginPinRecovery, pinRecoveryStatus, setupPinRecovery } from './recoveryAuth';
import { submitPreAuthSupport } from './preAuthSupport';
import { deleteAccount } from './accountDeletion';

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
function recoveryStatusCode(message: string): number {
  if (message === 'auth_required') return 401;
  if (message === 'server_not_configured') return 503;
  if (message === 'email_already_used' || message === 'name_taken' || message === 'device_registered' || message === 'device_deleted') return 409;
  if (message === 'credentials_invalid') return 401;
  return 400;
}
app.post('/auth/recovery/create', async (req, res) => {
  try {
    res.json(await createPinAccount(req));
  } catch (error: any) {
    const message = String(error?.message || 'account_create_failed');
    res.status(recoveryStatusCode(message)).json({ ok: false, error: message });
  }
});
app.post('/auth/recovery/setup', async (req, res) => {
  try {
    res.json(await setupPinRecovery(req));
  } catch (error: any) {
    const message = String(error?.message || 'account_setup_failed');
    res.status(recoveryStatusCode(message)).json({ ok: false, error: message });
  }
});
app.post('/auth/recovery/login', async (req, res) => {
  try {
    res.json(await loginPinRecovery(req));
  } catch (error: any) {
    const message = String(error?.message || 'account_login_failed');
    res.status(recoveryStatusCode(message)).json({ ok: false, error: message });
  }
});
app.get('/auth/recovery/status', async (req, res) => {
  try {
    res.json(await pinRecoveryStatus(req));
  } catch (error: any) {
    const message = String(error?.message || 'account_status_failed');
    res.status(recoveryStatusCode(message)).json({ ok: false, error: message });
  }
});
app.post('/auth/account/delete', async (req, res) => {
  try {
    res.json(await deleteAccount(req));
  } catch (error: any) {
    const message = String(error?.message || 'account_delete_failed');
    const status = message === 'auth_required' ? 401
      : message === 'server_not_configured' ? 503
      : message === 'pin_invalid' || message === 'pin_not_configured' ? 401
      : 400;
    res.status(status).json({ ok: false, error: message });
  }
});
app.post('/support/preauth/report', async (req, res) => {
  try {
    res.json(await submitPreAuthSupport(req));
  } catch (error: any) {
    const message = String(error?.message || 'support_failed');
    const status = message === 'too_many_requests' ? 429
      : message === 'server_not_configured' ? 503
      : message === 'email_invalid' || message === 'message_required' ? 400
      : 500;
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

// GÜNLÜK ÖDÜL HATIRLATMASI: her gün 19:00'da (yerel) ödülünü almamış + push cihazı açık
// kullanıcılara bildirim kuyrukla. SQL: migrations/20260726_game_interest_and_daily_reminders.sql
import { rpcService } from './supabase';
let lastDailyReminderDay = '';
setInterval(() => {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (now.getHours() !== 19 || day === lastDailyReminderDay) return;
  lastDailyReminderDay = day;
  rpcService('enqueue_daily_reminders', {})
    .then((n) => console.log('[daily-reminder] kuyruklandı:', n))
    .catch((e: any) => console.error('[daily-reminder]', e?.message || e));
}, 10 * 60 * 1000).unref?.();

console.log(`[Elli Bir] Colyseus dinleniyor: ws://localhost:${port} (seatRes=60s)`);
