import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { verifyToken } from './supabase';
import { isDeletedDevice } from './accountDeletion';

const URL = process.env.SUPABASE_URL ?? '';
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const SECRET = process.env.ACCOUNT_PIN_SECRET || SERVICE || 'online-kahvem-local-pin-secret';
const START_CHIPS = Math.max(0, Number(process.env.START_CHIPS || 50_000));
const START_DIAMONDS = Math.max(0, Number(process.env.START_DIAMONDS || 500));

function configured(): boolean {
  return !!(URL && ANON && SERVICE);
}

function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,254}$/.test(email) && email.length <= 254;
}

function cleanPin(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 8);
}

function validPin(pin: string): boolean {
  return /^\d{6,8}$/.test(pin);
}

function normalizeName(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function validName(name: string): boolean {
  if (name.length < 3 || name.length > 16) return false;
  return /^[\p{L}\p{N}_ ]+$/u.test(name);
}

function normalizeGender(value: unknown): string {
  const v = String(value ?? '').trim().toLowerCase();
  return v === 'e' || v === 'k' || v === 'x' ? v : '';
}

function validDeviceHash(value: unknown): string {
  const v = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(v)) throw new Error('device_invalid');
  return v;
}

function derivedPassword(email: string, pin: string): string {
  return 'OK-' + createHmac('sha256', SECRET).update(`password|${email}|${pin}`).digest('hex');
}

function pinHash(email: string, userId: string, pin: string): string {
  return createHmac('sha256', SECRET).update(`pin|${userId}|${email}|${pin}`).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const ba = Buffer.from(a || '', 'hex');
  const bb = Buffer.from(b || '', 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

function authHeader(req: Request): string {
  return String(req.header('authorization') || '').replace(/^Bearer\s+/i, '');
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

async function passwordSession(email: string, password: string): Promise<any> {
  const response = await anonFetch('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(10_000),
  });
  const json: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('credentials_invalid');
  return json;
}

async function passwordSessionForRecovery(userId: string, email: string, pin: string): Promise<any> {
  const password = derivedPassword(email, pin);
  try {
    return await passwordSession(email, password);
  } catch {
    await updateAuthCredentials(userId, email, password);
    return await passwordSession(email, password);
  }
}

async function updateAuthCredentials(userId: string, email: string, password: string): Promise<void> {
  const response = await serviceFetch(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { ok_recovery_secured_at: new Date().toISOString() },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text();
    if (/already|registered|exists|duplicate/i.test(text)) throw new Error('email_already_used');
    throw new Error(`auth_update_${response.status}`);
  }
}

async function createAuthUser(email: string, password: string): Promise<string> {
  const response = await serviceFetch('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { ok_guest: true, ok_created_at: new Date().toISOString() },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const json: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    const text = JSON.stringify(json);
    if (/already|registered|exists|duplicate/i.test(text)) throw new Error('email_already_used');
    throw new Error(`auth_create_${response.status}`);
  }
  const id = String(json?.id || json?.user?.id || '');
  if (!id) throw new Error('auth_create_invalid');
  return id;
}

async function deleteAuthUser(userId: string): Promise<void> {
  await serviceFetch(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

async function deleteProfile(userId: string): Promise<void> {
  await serviceFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

async function recoveryByEmail(email: string): Promise<any | null> {
  const response = await serviceFetch(`/rest/v1/account_recovery_credentials?email=eq.${encodeURIComponent(email)}&select=user_id,email,pin_hash,password_fingerprint&limit=1`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`recovery_lookup_${response.status}`);
  const rows: any = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function recoveryByUserId(userId: string): Promise<any | null> {
  const response = await serviceFetch(`/rest/v1/account_recovery_credentials?user_id=eq.${encodeURIComponent(userId)}&select=user_id,email&limit=1`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`recovery_lookup_${response.status}`);
  const rows: any = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function userIdByDeviceHash(deviceHash: string): Promise<string> {
  const response = await serviceFetch(`/rest/v1/device_accounts?device_hash=eq.${encodeURIComponent(deviceHash)}&select=user_id&limit=1`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`device_lookup_${response.status}`);
  const rows: any[] = await response.json();
  const userId = Array.isArray(rows) && rows.length ? String(rows[0]?.user_id || '') : '';
  if (!userId) throw new Error('device_account_not_found');
  return userId;
}

async function profileRole(userId: string): Promise<string> {
  const response = await serviceFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role&limit=1`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`admin_profile_lookup_${response.status}`);
  const rows: any[] = await response.json();
  const role = Array.isArray(rows) && rows.length ? String(rows[0]?.role || '') : '';
  return role.trim().toLowerCase();
}

async function profileExists(userId: string): Promise<boolean> {
  const response = await serviceFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id&limit=1`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`profile_lookup_${response.status}`);
  const rows: any[] = await response.json();
  return Array.isArray(rows) && rows.length > 0;
}

function isPlayableProfileName(name: string): boolean {
  const normalized = normalizeName(name);
  if (!validName(normalized)) return false;
  if (/^Oyuncu_[0-9A-F]{6}$/i.test(normalized)) return false;
  return normalized !== 'Oyuncu' && normalized !== 'Sen';
}

async function fallbackProfileName(userId: string): Promise<string> {
  const compact = userId.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  const base = compact.slice(0, 6).padEnd(6, '0');
  let name = `Misafir_${base}`;
  if (!(await profileNameTaken(name, userId))) return name;
  for (let i = 1; i <= 9; i += 1) {
    name = `Misafir_${base.slice(0, 5)}${i}`;
    if (!(await profileNameTaken(name, userId))) return name;
  }
  return `Misafir_${Date.now().toString().slice(-6)}`;
}

async function ensureProfilePlayableForRecovery(userId: string): Promise<void> {
  const response = await serviceFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=name,gender&limit=1`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`profile_lookup_${response.status}`);
  const rows: any[] = await response.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('profile_missing');

  const currentName = normalizeName(rows[0]?.name);
  const currentGender = normalizeGender(rows[0]?.gender);
  const patch: Record<string, unknown> = { recovery_secured_at: new Date().toISOString() };
  if (!isPlayableProfileName(currentName)) patch.name = await fallbackProfileName(userId);
  if (!currentGender) patch.gender = 'x';

  const update = await serviceFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(10_000),
  });
  if (!update.ok) {
    const text = await update.text();
    throw new Error(profileWriteErrorToCode(update.status, text));
  }
}

async function profileNameTaken(name: string, exceptUserId = ''): Promise<boolean> {
  const response = await serviceFetch(`/rest/v1/profiles?name=ilike.${encodeURIComponent(name)}&select=id&limit=2`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`profile_name_lookup_${response.status}`);
  const rows: any[] = await response.json();
  return Array.isArray(rows) && rows.some((r) => String(r?.id || '') !== exceptUserId);
}

async function upsertRecovery(userId: string, email: string, pin: string): Promise<void> {
  const hash = pinHash(email, userId, pin);
  const fingerprint = createHmac('sha256', SECRET).update(`password-fingerprint|${email}|${pin}`).digest('hex');
  const response = await serviceFetch('/rest/v1/account_recovery_credentials', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: userId,
      email,
      pin_hash: hash,
      password_fingerprint: fingerprint,
      updated_at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text();
    if (/duplicate|unique/i.test(text)) throw new Error('email_already_used');
    throw new Error(`recovery_store_${response.status}`);
  }
}

async function bindDevice(userId: string, deviceHash: string, allowReassign: boolean): Promise<void> {
  const existing = await serviceFetch(`/rest/v1/device_accounts?device_hash=eq.${encodeURIComponent(deviceHash)}&select=user_id&limit=1`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (!existing.ok) throw new Error(`device_lookup_${existing.status}`);
  const rows: any[] = await existing.json();
  const owner = Array.isArray(rows) && rows.length ? String(rows[0]?.user_id || '') : '';
  if (owner && owner !== userId && !allowReassign) throw new Error('device_registered');

  const response = await serviceFetch('/rest/v1/device_accounts', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ device_hash: deviceHash, user_id: userId, last_seen_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`device_bind_${response.status}`);
}

function profileWriteErrorToCode(status: number, text: string): string {
  if (/profiles_name_lower_uniq/i.test(text)) return 'name_taken';
  return `profile_insert_${status}`;
}

function legacyDeviceEmail(userId: string): string {
  return `legacy-${userId.replace(/[^a-zA-Z0-9-]/g, '')}@device.online-kahvem.invalid`.toLowerCase();
}

function legacyDevicePassword(userId: string, deviceHash: string): string {
  return 'OK-LEGACY-' + createHmac('sha256', SECRET).update(`legacy-device-login|${userId}|${deviceHash}`).digest('hex');
}

async function upsertProfile(userId: string, name: string, gender: string): Promise<void> {
  const response = await serviceFetch('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      id: userId,
      name,
      gender,
      avatar: 0,
      chips: START_CHIPS,
      diamonds: START_DIAMONDS,
      matches: 0,
      wins: 0,
      best_streak: 0,
      recovery_secured_at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(profileWriteErrorToCode(response.status, text));
  }
}

async function markProfileSecured(userId: string): Promise<void> {
  await serviceFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ recovery_secured_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function recordRecovery(userId: string): Promise<void> {
  const lookup = await serviceFetch(`/rest/v1/account_recovery_credentials?user_id=eq.${encodeURIComponent(userId)}&select=recovery_count&limit=1`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  let count = 0;
  if (lookup?.ok) {
    const rows: any[] = await lookup.json().catch(() => []);
    count = Math.max(0, Number(Array.isArray(rows) && rows.length ? rows[0]?.recovery_count : 0) || 0);
  }
  await serviceFetch(`/rest/v1/account_recovery_credentials?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ last_recovered_at: new Date().toISOString(), recovery_count: count + 1 }),
  }).catch(() => undefined);
}

export async function createPinAccount(req: Request): Promise<Record<string, unknown>> {
  if (!configured()) throw new Error('server_not_configured');
  const email = normalizeEmail(req.body?.email);
  const pin = cleanPin(req.body?.pin);
  const name = normalizeName(req.body?.name);
  const gender = normalizeGender(req.body?.gender);
  const deviceHash = validDeviceHash(req.body?.device_hash);
  if (!validEmail(email)) throw new Error('email_invalid');
  if (!validPin(pin)) throw new Error('pin_invalid');
  if (!validName(name)) throw new Error('name_invalid');
  if (!gender) throw new Error('gender_invalid');
  if (await isDeletedDevice(deviceHash)) throw new Error('device_deleted');
  if (await recoveryByEmail(email)) throw new Error('email_already_used');
  if (await profileNameTaken(name)) throw new Error('name_taken');

  const password = derivedPassword(email, pin);
  let userId = '';
  try {
    userId = await createAuthUser(email, password);
    await upsertProfile(userId, name, gender);
    await upsertRecovery(userId, email, pin);
    await bindDevice(userId, deviceHash, false);
    const session = await passwordSession(email, password);
    return { ok: true, email, user_id: userId, ...session };
  } catch (error) {
    if (userId) {
      await deleteProfile(userId);
      await deleteAuthUser(userId);
    }
    throw error;
  }
}

export async function setupPinRecovery(req: Request): Promise<Record<string, unknown>> {
  if (!configured()) throw new Error('server_not_configured');
  const userId = await verifyToken(authHeader(req));
  if (!userId) throw new Error('auth_required');
  const email = normalizeEmail(req.body?.email);
  const pin = cleanPin(req.body?.pin);
  const deviceHash = validDeviceHash(req.body?.device_hash);
  if (!validEmail(email)) throw new Error('email_invalid');
  if (!validPin(pin)) throw new Error('pin_invalid');
  const existing = await recoveryByEmail(email);
  if (existing && String(existing.user_id) !== userId) throw new Error('email_already_used');

  const password = derivedPassword(email, pin);
  await updateAuthCredentials(userId, email, password);
  await upsertRecovery(userId, email, pin);
  await bindDevice(userId, deviceHash, false);
  await markProfileSecured(userId);
  return { ok: true, email, message: 'Hesap mail ve PIN ile guvene alindi.' };
}

export async function loginPinRecovery(req: Request): Promise<Record<string, unknown>> {
  if (!configured()) throw new Error('server_not_configured');
  const email = normalizeEmail(req.body?.email);
  const pin = cleanPin(req.body?.pin);
  const deviceHash = validDeviceHash(req.body?.device_hash);
  if (!validEmail(email) || !validPin(pin)) throw new Error('credentials_invalid');
  const row = await recoveryByEmail(email);
  if (!row) throw new Error('credentials_invalid');
  const userId = String(row.user_id || '');
  if (!sameHash(String(row.pin_hash || ''), pinHash(email, userId, pin))) throw new Error('credentials_invalid');
  const session = await passwordSessionForRecovery(userId, email, pin);
  await bindDevice(userId, deviceHash, true);
  await ensureProfilePlayableForRecovery(userId);
  await recordRecovery(userId);
  return { ok: true, email, user_id: userId, message: 'Hesap geri yuklendi.', ...session };
}

export async function loginLegacyDeviceAccount(req: Request): Promise<Record<string, unknown>> {
  if (!configured()) throw new Error('server_not_configured');
  const deviceHash = validDeviceHash(req.body?.device_hash);
  if (await isDeletedDevice(deviceHash)) throw new Error('device_deleted');

  const userId = await userIdByDeviceHash(deviceHash);
  if (await recoveryByUserId(userId)) throw new Error('pin_recovery_required');
  if (!(await profileExists(userId))) throw new Error('profile_missing');

  const email = legacyDeviceEmail(userId);
  const password = legacyDevicePassword(userId, deviceHash);
  await updateAuthCredentials(userId, email, password);
  await bindDevice(userId, deviceHash, true);
  const session = await passwordSession(email, password);
  return {
    ok: true,
    user_id: userId,
    legacy_device_login: true,
    needs_pin_setup: true,
    message: 'Cihazdaki eski hesap geri baglandi. Lutfen hesabini e-posta ve PIN ile guvene al.',
    ...session,
  };
}

export async function pinRecoveryStatus(req: Request): Promise<Record<string, unknown>> {
  if (!configured()) throw new Error('server_not_configured');
  const userId = await verifyToken(authHeader(req));
  if (!userId) throw new Error('auth_required');
  const response = await serviceFetch(`/rest/v1/account_recovery_credentials?user_id=eq.${encodeURIComponent(userId)}&select=email&limit=1`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`recovery_status_${response.status}`);
  const rows: any[] = await response.json();
  const email = Array.isArray(rows) && rows.length ? String(rows[0]?.email || '') : '';
  return { ok: true, secured: !!email, email };
}

export async function adminResetPinRecovery(req: Request): Promise<Record<string, unknown>> {
  if (!configured()) throw new Error('server_not_configured');
  const adminId = await verifyToken(authHeader(req));
  if (!adminId) throw new Error('auth_required');
  if ((await profileRole(adminId)) !== 'admin') throw new Error('admin_required');

  const email = normalizeEmail(req.body?.email);
  const pin = cleanPin(req.body?.pin ?? req.body?.new_pin);
  if (!validEmail(email)) throw new Error('email_invalid');
  if (!validPin(pin)) throw new Error('pin_invalid');

  const row = await recoveryByEmail(email);
  if (!row) throw new Error('email_not_found');
  const userId = String(row.user_id || '');
  if (!userId) throw new Error('recovery_row_invalid');

  const password = derivedPassword(email, pin);
  await updateAuthCredentials(userId, email, password);
  await upsertRecovery(userId, email, pin);
  return { ok: true, email, user_id: userId, message: 'PIN yenilendi.' };
}

export async function adminSecureDeviceRecovery(req: Request): Promise<Record<string, unknown>> {
  if (!configured()) throw new Error('server_not_configured');
  const adminId = await verifyToken(authHeader(req));
  if (!adminId) throw new Error('auth_required');
  if ((await profileRole(adminId)) !== 'admin') throw new Error('admin_required');

  const deviceHash = validDeviceHash(req.body?.device_hash);
  const email = normalizeEmail(req.body?.email);
  const pin = cleanPin(req.body?.pin ?? req.body?.new_pin);
  if (!validEmail(email)) throw new Error('email_invalid');
  if (!validPin(pin)) throw new Error('pin_invalid');

  const userId = await userIdByDeviceHash(deviceHash);
  if (!(await profileExists(userId))) throw new Error('profile_missing');
  const existingEmail = await recoveryByEmail(email);
  if (existingEmail && String(existingEmail.user_id) !== userId) throw new Error('email_already_used');

  const password = derivedPassword(email, pin);
  await updateAuthCredentials(userId, email, password);
  await upsertRecovery(userId, email, pin);
  await bindDevice(userId, deviceHash, true);
  await ensureProfilePlayableForRecovery(userId);
  return { ok: true, email, user_id: userId, message: 'Cihazdaki hesap e-posta ve PIN ile guvene alindi.' };
}

export const _test = { normalizeEmail, validEmail, cleanPin, validPin, normalizeName, validName, normalizeGender, derivedPassword, pinHash, sameHash, profileWriteErrorToCode, isPlayableProfileName };
