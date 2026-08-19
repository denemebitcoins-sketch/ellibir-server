import type { Request } from 'express';

const URL = process.env.SUPABASE_URL ?? '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const recent = new Map<string, number>();

function configured(): boolean {
  return !!(URL && SERVICE);
}

function clean(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,254}$/.test(email) && email.length <= 254;
}

function validDeviceHash(value: unknown): string {
  const v = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(v) ? v : '';
}

function clientKey(req: Request, deviceHash: string): string {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  return deviceHash || ip || 'unknown';
}

function rateLimit(req: Request, deviceHash: string): void {
  const key = clientKey(req, deviceHash);
  const now = Date.now();
  const prev = recent.get(key) || 0;
  if (now - prev < 60_000) throw new Error('too_many_requests');
  recent.set(key, now);
}

async function serviceFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${URL}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE,
      authorization: `Bearer ${SERVICE}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

export async function submitPreAuthSupport(req: Request): Promise<Record<string, unknown>> {
  if (!configured()) throw new Error('server_not_configured');

  const contactEmail = clean(req.body?.contact_email, 254).toLowerCase();
  const message = clean(req.body?.message, 1000);
  const source = clean(req.body?.source, 80) || 'pre_auth';
  const deviceHash = validDeviceHash(req.body?.device_hash);
  const platform = clean(req.body?.platform, 80);
  const appVersion = clean(req.body?.app_version, 40);
  const deviceModel = clean(req.body?.device_model, 160);

  if (!validEmail(contactEmail)) throw new Error('email_invalid');
  if (message.length < 6) throw new Error('message_required');
  rateLimit(req, deviceHash);

  const text = [
    '[Bağlantı / hesap giriş sorunu]',
    message,
    '',
    `İletişim: ${contactEmail}`,
    `Kaynak: ${source}`,
    `Cihaz kodu: ${deviceHash || '-'}`,
    `Platform: ${platform || '-'}`,
    `Sürüm: ${appVersion || '-'}`,
    `Model: ${deviceModel || '-'}`,
  ].join('\n');

  const response = await serviceFetch('/rest/v1/reports', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      name: `Giriş Desteği - ${contactEmail}`,
      type: 'baglanti',
      text,
      context: JSON.stringify({ source, contact_email: contactEmail, device_hash: deviceHash, platform, app_version: appVersion, device_model: deviceModel }),
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`support_insert_${response.status}${body ? '_' + body.slice(0, 80) : ''}`);
  }

  return { ok: true, message: 'Bildirim yönetime ulaştı.' };
}
