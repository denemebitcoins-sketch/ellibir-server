// Yönetim web sayfası (online-kahvem.web.app/masa-…) için WEB PUSH bildirimleri.
// - Yeni rapor gelince DB tetikleyicisi admin_web_push_outbox'a satır yazar (migrations/20261117_admin_web_push.sql).
// - Bu işçi kuyruğu okur, sayfada "Bildirimleri aç" demiş yöneticilerin tarayıcılarına (admin_web_push_subs) gönderir.
// - VAPID anahtar çifti ilk açılışta burada üretilir ve server_secrets'ta saklanır (RLS açık, politika yok → yalnız service role).
// Bağımlılık yok: RFC 8291 (aes128gcm) şifreleme + RFC 8292 (VAPID, ES256) Node crypto ile.
import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'crypto';

const URL = process.env.SUPABASE_URL ?? '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const SUBJECT = 'mailto:destek@online-kahvem.web.app';

type Vapid = { publicKey: string; privateJwk: Record<string, string> };
type Sub = { endpoint: string; p256dh: string; auth: string };
type OutboxRow = { id: number; title: string; body: string; url: string | null; extra: number };

const b64u = (b: Buffer) => b.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64u = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function rest(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`rest_${response.status}:${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export function generateVapid(): Vapid {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  const pub = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  return { publicKey: b64u(pub), privateJwk: jwk };
}

let vapidCache: Vapid | null = null;
async function vapid(): Promise<Vapid> {
  if (vapidCache) return vapidCache;
  const read = async () => {
    const rows = await rest('server_secrets?key=eq.admin_web_push_vapid&select=value');
    return Array.isArray(rows) && rows.length ? (rows[0].value as Vapid) : null;
  };
  let v = await read();
  if (!v) {
    await rest('server_secrets', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'admin_web_push_vapid', value: generateVapid() }),
    });
    v = await read();
  }
  if (!v) throw new Error('vapid_unavailable');
  vapidCache = v;
  return v;
}

function vapidAuth(endpoint: string, v: Vapid): string {
  const aud = new globalThis.URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
  const key = createPrivateKey({ key: v.privateJwk as any, format: 'jwk' });
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** RFC 8291 aes128gcm şifreli gövde (tek kayıt). */
export function encryptPayload(sub: Sub, plaintext: Buffer, salt: Buffer, ecdh: ReturnType<typeof createECDH>): Buffer {
  const asPublic = ecdh.getPublicKey();
  const uaPublic = fromB64u(sub.p256dh);
  const authSecret = fromB64u(sub.auth);
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

async function sendOne(sub: Sub, payload: object, v: Vapid): Promise<number> {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const body = encryptPayload(sub, Buffer.from(JSON.stringify(payload)), randomBytes(16), ecdh);
  const response = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high', Authorization: vapidAuth(sub.endpoint, v) },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  return response.status;
}

let running = false;
async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const rows: OutboxRow[] = await rest('admin_web_push_outbox?sent_at=is.null&created_at=lt.' + encodeURIComponent(new Date(Date.now() - 20000).toISOString()) + '&order=id.asc&limit=10&select=id,title,body,url,extra');
    if (!rows.length) return;
    const subs: Sub[] = await rest('admin_web_push_subs?select=endpoint,p256dh,auth');
    const v = subs.length ? await vapid() : null;
    for (const row of rows) {
      await rest('admin_web_push_outbox?id=eq.' + row.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ sent_at: new Date().toISOString() }) });
      if (!v) continue;
      const payload = {
        title: row.title,
        body: row.extra > 0 ? `${row.body} (+${row.extra} rapor daha)` : row.body,
        url: row.url || '/masa-k7q3x9',
        tag: 'admin-report',
      };
      for (const sub of subs) {
        try {
          const status = await sendOne(sub, payload, v);
          if (status === 404 || status === 410) await rest('admin_web_push_subs?endpoint=eq.' + encodeURIComponent(sub.endpoint), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
          else if (status >= 200 && status < 300) await rest('admin_web_push_subs?endpoint=eq.' + encodeURIComponent(sub.endpoint), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_ok_at: new Date().toISOString(), fail_count: 0 }) });
          else console.warn('[AdminWebPush] gönderim durumu', status);
        } catch (e: any) { console.warn('[AdminWebPush] gönderilemedi:', e?.message || e); }
      }
    }
  } catch (e: any) {
    console.warn('[AdminWebPush] tick:', e?.message || e);
  } finally {
    running = false;
  }
}

export function startAdminWebPush(): void {
  if (!URL || !SERVICE) { console.log('[AdminWebPush] Supabase yapılandırılmadı, kapalı'); return; }
  vapid().then(() => console.log('[AdminWebPush] hazır')).catch(e => console.warn('[AdminWebPush] VAPID:', e?.message || e));
  setInterval(() => { void tick(); }, 10_000);
}
