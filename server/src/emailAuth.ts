import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import dns from 'dns';
import type { Request } from 'express';
import nodemailer from 'nodemailer';
import { verifyToken } from './supabase';

const URL = process.env.SUPABASE_URL ?? '';
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const OTP_SECRET = process.env.EMAIL_OTP_SECRET || SERVICE || 'online-kahvem-local-email-secret';
const FROM = process.env.EMAIL_FROM || 'Online Kahvem <noreply@onlinekahvem.app>';
const TTL_MINUTES = Math.max(3, Math.min(30, Number(process.env.EMAIL_OTP_TTL_MINUTES || 10)));
const MAIL_TIMEOUT_MS = Math.max(3_000, Math.min(20_000, Number(process.env.EMAIL_SEND_TIMEOUT_MS || 8_000)));

type Mode = 'link' | 'login';

function configured(): boolean {
  return !!(URL && ANON && SERVICE);
}

function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,254}$/.test(email) && email.length <= 254;
}

function cleanCode(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 6);
}

function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(email: string, userId: string, code: string, purpose: Mode): string {
  return createHmac('sha256', OTP_SECRET).update(`${purpose}|${userId}|${email}|${code}`).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const ba = Buffer.from(a || '', 'hex');
  const bb = Buffer.from(b || '', 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
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

async function anonFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${URL}${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

function htmlMail(code: string, mode: Mode): string {
  const title = mode === 'link' ? 'E-posta hesabini bagla' : 'Online Kahvem giris kodun';
  const body = mode === 'link'
    ? 'Bu kodu Online Kahvem icinde girerek mevcut oyuncu kimligini, cuzdani ve ilerlemeyi bu e-posta adresine baglayabilirsin.'
    : 'Bu kodu Online Kahvem icinde girerek e-posta hesabina giris yapabilirsin.';
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#101316;color:#f4ead2;font-family:Arial,sans-serif">
  <div style="max-width:560px;margin:auto;border:1px solid #c89b45;border-radius:18px;padding:28px;background:#17120d">
    <h1 style="margin:0 0 12px;color:#ffd56a;font-size:26px">Online Kahvem</h1>
    <h2 style="margin:0 0 18px;font-size:20px">${title}</h2>
    <p style="line-height:1.5;color:#e8dcc4">${body}</p>
    <div style="font-size:42px;letter-spacing:8px;font-weight:bold;text-align:center;margin:28px 0;padding:18px;border-radius:14px;background:#0f2f29;color:#5ff0d2">${code}</div>
    <p style="color:#b8aa8e">Kod ${TTL_MINUTES} dakika gecerlidir. Bu islemi sen baslatmadiysan bu e-postayi yok sayabilirsin.</p>
  </div></body></html>`;
}

function textMail(code: string, mode: Mode): string {
  const title = mode === 'link' ? 'E-posta hesabini bagla' : 'Online Kahvem giris kodun';
  return `Online Kahvem\n\n${title}\n\nKodun: ${code}\n\nKod ${TTL_MINUTES} dakika gecerlidir. Bu islemi sen baslatmadiysan bu e-postayi yok sayabilirsin.`;
}

async function sendMail(email: string, code: string, mode: Mode): Promise<void> {
  const subject = mode === 'link' ? 'Online Kahvem e-posta baglama kodun' : 'Online Kahvem giris kodun';
  const resendKey = process.env.RESEND_API_KEY || '';
  if (resendKey) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [email], subject, html: htmlMail(code, mode), text: textMail(code, mode) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`resend_${response.status}:${(await response.text()).slice(0, 180)}`);
    return;
  }

  const host = process.env.SMTP_HOST || '';
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  if (!host || !user || !pass) throw new Error('email_provider_not_configured');
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    family: 4,
    lookup: (hostname: string, _options: unknown, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
      dns.lookup(hostname, { family: 4 }, callback);
    },
    connectionTimeout: MAIL_TIMEOUT_MS,
    greetingTimeout: MAIL_TIMEOUT_MS,
    socketTimeout: MAIL_TIMEOUT_MS,
  } as any);
  try {
    await transporter.sendMail({ from: FROM, to: email, subject, html: htmlMail(code, mode), text: textMail(code, mode) });
  } catch (error: any) {
    const msg = String(error?.message || error || '');
    if (/timeout|timed out|greeting never received|etimedout|esocket/i.test(msg)) throw new Error('email_send_timeout');
    throw error;
  }
}

async function generateLoginCode(email: string): Promise<string> {
  const response = await serviceFetch('/auth/v1/admin/generate_link', {
    method: 'POST',
    body: JSON.stringify({ type: 'magiclink', email }),
    signal: AbortSignal.timeout(10_000),
  });
  const json: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 422 || response.status === 404 ? 'email_not_found' : `generate_link_${response.status}`);
  const code = String(json?.properties?.email_otp || json?.email_otp || '').replace(/\D/g, '').slice(0, 6);
  if (code.length !== 6) throw new Error('login_code_unavailable');
  return code;
}

async function saveLinkCode(userId: string, email: string, code: string): Promise<void> {
  await serviceFetch(`/rest/v1/email_link_codes?user_id=eq.${encodeURIComponent(userId)}&purpose=eq.link&consumed_at=is.null`, {
    method: 'PATCH',
    body: JSON.stringify({ consumed_at: new Date().toISOString() }),
  }).catch(() => undefined);
  const expires = new Date(Date.now() + TTL_MINUTES * 60_000).toISOString();
  const response = await serviceFetch('/rest/v1/email_link_codes', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, email, purpose: 'link', code_hash: hashCode(email, userId, code, 'link'), expires_at: expires }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`email_code_store_${response.status}`);
}

async function findLinkCode(userId: string, email: string): Promise<any | null> {
  const now = encodeURIComponent(new Date().toISOString());
  const response = await serviceFetch(`/rest/v1/email_link_codes?user_id=eq.${encodeURIComponent(userId)}&email=eq.${encodeURIComponent(email)}&purpose=eq.link&consumed_at=is.null&expires_at=gt.${now}&select=id,code_hash,attempts&order=created_at.desc&limit=1`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`email_code_lookup_${response.status}`);
  const rows: any = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function patchCode(id: string, patch: Record<string, unknown>): Promise<void> {
  await serviceFetch(`/rest/v1/email_link_codes?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(patch), signal: AbortSignal.timeout(10_000),
  });
}

async function updateAuthEmail(userId: string, email: string): Promise<void> {
  const response = await serviceFetch(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    body: JSON.stringify({ email, email_confirm: true, user_metadata: { email_linked_at: new Date().toISOString() } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text();
    if (/already|registered|exists|duplicate/i.test(text)) throw new Error('email_already_used');
    throw new Error(`email_update_${response.status}`);
  }
}

async function verifyLogin(email: string, code: string): Promise<any> {
  const response = await anonFetch('/auth/v1/verify', {
    method: 'POST',
    body: JSON.stringify({ email, token: code, type: 'magiclink' }),
    signal: AbortSignal.timeout(10_000),
  });
  const json: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(/expired|invalid/i.test(JSON.stringify(json)) ? 'code_invalid' : `login_verify_${response.status}`);
  return json;
}

function authHeader(req: Request): string {
  return String(req.header('authorization') || '').replace(/^Bearer\s+/i, '');
}

export async function requestEmailCode(req: Request): Promise<Record<string, unknown>> {
  if (!configured()) throw new Error('server_not_configured');
  const mode: Mode = req.body?.mode === 'login' ? 'login' : 'link';
  const email = normalizeEmail(req.body?.email);
  if (!validEmail(email)) throw new Error('email_invalid');

  if (mode === 'login') {
    const code = await generateLoginCode(email);
    await sendMail(email, code, 'login');
    return { ok: true, message: 'Giris kodu e-posta adresine gonderildi.' };
  }

  const userId = await verifyToken(authHeader(req));
  if (!userId) throw new Error('auth_required');
  const code = newCode();
  await saveLinkCode(userId, email, code);
  await sendMail(email, code, 'link');
  return { ok: true, message: 'Dogrulama kodu e-posta adresine gonderildi.' };
}

export async function verifyEmailCode(req: Request): Promise<Record<string, unknown>> {
  if (!configured()) throw new Error('server_not_configured');
  const mode: Mode = req.body?.mode === 'login' ? 'login' : 'link';
  const email = normalizeEmail(req.body?.email);
  const code = cleanCode(req.body?.code);
  if (!validEmail(email) || code.length !== 6) throw new Error('code_invalid');

  if (mode === 'login') {
    const session = await verifyLogin(email, code);
    return { ok: true, message: 'E-posta hesabina giris yapildi.', ...session };
  }

  const userId = await verifyToken(authHeader(req));
  if (!userId) throw new Error('auth_required');
  const row = await findLinkCode(userId, email);
  if (!row) throw new Error('code_invalid');
  const attempts = Number(row.attempts || 0);
  if (attempts >= 5) throw new Error('code_too_many_attempts');
  if (!sameHash(String(row.code_hash || ''), hashCode(email, userId, code, 'link'))) {
    await patchCode(String(row.id), { attempts: attempts + 1 }).catch(() => undefined);
    throw new Error('code_invalid');
  }
  await updateAuthEmail(userId, email);
  await patchCode(String(row.id), { consumed_at: new Date().toISOString(), attempts: attempts + 1 }).catch(() => undefined);
  return { ok: true, email, message: 'E-posta hesabina baglandi. Cuzdanin ve ilerlemen korundu.' };
}

export function emailAuthStatus(): Record<string, unknown> {
  return {
    ok: true,
    configured: configured() && !!(process.env.RESEND_API_KEY || (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)),
    provider: process.env.RESEND_API_KEY ? 'resend' : process.env.SMTP_HOST ? 'smtp' : 'none',
  };
}

export const _test = { normalizeEmail, validEmail, cleanCode, hashCode, sameHash, textMail, htmlMail };
