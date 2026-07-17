import { createSign } from 'crypto';
import { rpcService, supabaseConfigured } from './supabase';

type OutboxRow = {
  id: number;
  user_id: string;
  kind: 'dm' | 'system';
  title: string;
  body: string;
  data?: Record<string, unknown>;
  attempts: number;
};

const URL = process.env.SUPABASE_URL ?? '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const PROJECT = process.env.FIREBASE_PROJECT_ID ?? '';
const EMAIL = process.env.FIREBASE_SERVICE_ACCOUNT_EMAIL ?? '';
const PRIVATE_KEY = (process.env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');

let oauthCache: { token: string; expiresAt: number } | null = null;
let running = false;
let timer: NodeJS.Timeout | null = null;

function configured(): boolean {
  return supabaseConfigured() && !!(PROJECT && EMAIL && PRIVATE_KEY);
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function firebaseAccessToken(): Promise<string> {
  if (oauthCache && oauthCache.expiresAt > Date.now() + 60_000) return oauthCache.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  const assertion = `${header}.${claims}.${b64url(signer.sign(PRIVATE_KEY))}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`firebase_oauth_${response.status}`);
  const result: any = await response.json();
  if (!result?.access_token) throw new Error('firebase_oauth_token_missing');
  oauthCache = { token: result.access_token, expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000 };
  return oauthCache.token;
}

async function tokensFor(userId: string): Promise<string[]> {
  const response = await fetch(`${URL}/rest/v1/push_devices?user_id=eq.${encodeURIComponent(userId)}&enabled=eq.true&select=token`, {
    headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`push_devices_${response.status}`);
  const rows: any = await response.json();
  return Array.isArray(rows) ? rows.map((r) => String(r?.token || '')).filter(Boolean) : [];
}

async function sendOne(access: string, token: string, row: OutboxRow): Promise<'ok' | 'invalid'> {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.data || {})) data[key] = String(value ?? '');
  data.kind = row.kind;
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(PROJECT)}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: {
      token,
      notification: { title: row.title, body: row.body },
      data,
      android: {
        priority: 'high',
        notification: { channel_id: 'online_kahvem_messages', sound: 'default' },
      },
    } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.ok) return 'ok';
  const body = await response.text();
  if (response.status === 404 || /UNREGISTERED|registration-token-not-registered/i.test(body)) return 'invalid';
  throw new Error(`fcm_${response.status}:${body.slice(0, 180)}`);
}

async function processRow(row: OutboxRow): Promise<void> {
  try {
    const tokens = await tokensFor(row.user_id);
    if (!tokens.length) {
      await rpcService('finish_push_outbox', { p_id: row.id, p_success: true, p_error: 'no_active_device' });
      return;
    }
    const access = await firebaseAccessToken();
    let delivered = 0;
    for (const token of tokens) {
      const status = await sendOne(access, token, row);
      if (status === 'ok') delivered++;
      else await rpcService('disable_push_token', { p_token: token });
    }
    await rpcService('finish_push_outbox', {
      p_id: row.id,
      p_success: delivered > 0 || tokens.length > 0,
      p_error: delivered > 0 ? '' : 'all_tokens_invalid',
    });
  } catch (error: any) {
    await rpcService('finish_push_outbox', {
      p_id: row.id, p_success: false, p_error: String(error?.message || 'push_failed'),
    }).catch(() => undefined);
  }
}

export async function drainPushOutbox(): Promise<number> {
  if (!configured() || running) return 0;
  running = true;
  try {
    const result = await rpcService('claim_push_outbox', { p_limit: 25 });
    const rows: OutboxRow[] = Array.isArray(result) ? result : [];
    for (const row of rows) await processRow(row);
    return rows.length;
  } finally {
    running = false;
  }
}

export function startPushWorker(): void {
  if (!configured()) {
    console.warn('[push] disabled: Firebase service account environment is incomplete');
    return;
  }
  const tick = async () => {
    await drainPushOutbox().catch((error: any) => console.error('[push]', error?.message));
    timer = setTimeout(tick, 4_000);
    timer.unref?.();
  };
  void tick();
}

export const _test = { configured, b64url };
