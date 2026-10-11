import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { verifyToken } from './supabase';

const URL = process.env.SUPABASE_URL ?? '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const SECRET = process.env.ACCOUNT_PIN_SECRET || SERVICE || 'online-kahvem-local-pin-secret';

function configured(): boolean {
  return !!(URL && SERVICE);
}

function authHeader(req: Request): string {
  return String(req.header('authorization') || '').replace(/^Bearer\s+/i, '');
}

function cleanPin(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 8);
}

function validPin(pin: string): boolean {
  return /^\d{6,8}$/.test(pin);
}

function validDeviceHash(value: unknown): string {
  const v = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(v)) throw new Error('device_invalid');
  return v;
}

const DELETE_CONFIRMATION = 'SIL';
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const failures = new Map<string, number[]>();

/** "SİL", "SIL", "sil", "sİl" (Turkish İ / ı dahil) → "SIL". */
export function normalizeDeleteConfirmation(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0130\u0131]/g, (c) => (c === '\u0130' ? 'I' : 'i'))
    .replace(/\u0307/g, '')
    .trim()
    .toUpperCase();
}

function validConfirmation(value: unknown): boolean {
  return normalizeDeleteConfirmation(value) === DELETE_CONFIRMATION;
}

function recentFailures(userId: string): number[] {
  const now = Date.now();
  const list = (failures.get(userId) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (list.length) failures.set(userId, list); else failures.delete(userId);
  return list;
}

function assertAttemptBudget(userId: string): void {
  if (recentFailures(userId).length >= MAX_FAILURES) throw new Error('too_many_requests');
}

function recordFailure(userId: string): void {
  const list = recentFailures(userId);
  list.push(Date.now());
  failures.set(userId, list);
}

/** Test yardımcısı: hatalı deneme sayaçlarını sıfırlar. */
export function resetAccountDeletionAttempts(): void {
  failures.clear();
}

function pinHash(email: string, userId: string, pin: string): string {
  return createHmac('sha256', SECRET).update(`pin|${userId}|${email}|${pin}`).digest('hex');
}

function deletedDeviceFingerprint(deviceHash: string): string {
  return createHmac('sha256', SECRET).update(`deleted-device|${deviceHash}`).digest('hex');
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

async function recoveryByUser(userId: string): Promise<{ email: string; pin_hash: string } | null> {
  const response = await serviceFetch(`/rest/v1/account_recovery_credentials?user_id=eq.${encodeURIComponent(userId)}&select=email,pin_hash&limit=1`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`recovery_lookup_${response.status}`);
  const rows: any[] = await response.json();
  if (!Array.isArray(rows) || !rows.length) return null;
  return { email: String(rows[0]?.email || ''), pin_hash: String(rows[0]?.pin_hash || '') };
}

async function safeDelete(path: string): Promise<void> {
  await serviceFetch(path, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

async function recordDeletedDevice(deviceHash: string): Promise<void> {
  const fingerprint = deletedDeviceFingerprint(deviceHash);
  const lookup = await serviceFetch(`/rest/v1/deleted_device_fingerprints?fingerprint_hash=eq.${encodeURIComponent(fingerprint)}&select=delete_count&limit=1`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (lookup.ok) {
    const rows: any[] = await lookup.json().catch(() => []);
    if (Array.isArray(rows) && rows.length) {
      const count = Math.max(1, Number(rows[0]?.delete_count || 1));
      const update = await serviceFetch(`/rest/v1/deleted_device_fingerprints?fingerprint_hash=eq.${encodeURIComponent(fingerprint)}`, {
        method: 'PATCH',
        body: JSON.stringify({ delete_count: count + 1, updated_at: new Date().toISOString() }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!update.ok) throw new Error(`deleted_device_update_${update.status}`);
      return;
    }
  }

  const insert = await serviceFetch('/rest/v1/deleted_device_fingerprints', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      fingerprint_hash: fingerprint,
      delete_count: 1,
      updated_at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!insert.ok) throw new Error(`deleted_device_insert_${insert.status}`);
}

async function deviceHashesForUser(userId: string): Promise<string[]> {
  const response = await serviceFetch(`/rest/v1/device_accounts?user_id=eq.${encodeURIComponent(userId)}&select=device_hash`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`device_lookup_${response.status}`);
  const rows: any[] = await response.json().catch(() => []);
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => String(row?.device_hash || '').trim().toLowerCase())
    .filter((hash) => /^[0-9a-f]{64}$/.test(hash));
}

/** Herkese açık avatar dosyası: storage bucket "avatars", nesne "<uid>.jpg". Yoksa (404) sorun değil. */
async function deleteAvatarObjects(userId: string): Promise<void> {
  const objectPath = `avatars/${encodeURIComponent(userId)}.jpg`;
  const response = await serviceFetch(`/storage/v1/object/${objectPath}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.ok || response.status === 404) return;
  const text = await response.text().catch(() => '');
  // Supabase Storage bazı sürümlerde "not found" için 400 döner.
  if (/not.?found/i.test(text)) return;
  throw new Error(`avatar_delete_${response.status}`);
}

async function deleteKnownUserData(userId: string, deviceHashes: string[] = []): Promise<void> {
  const u = encodeURIComponent(userId);
  const supportDeletes = Array.from(new Set(deviceHashes))
    .filter((hash) => /^[0-9a-f]{64}$/.test(hash))
    // Giriş öncesi destek bildirimleri (preAuthSupport) kullanıcı kimliği taşımaz; cihaz kodu context içindedir.
    .map((hash) => safeDelete(`/rest/v1/reports?from_user=is.null&context=like.*${hash}*`));
  await Promise.all([
    ...supportDeletes,
    safeDelete(`/rest/v1/canak_events?user_id=eq.${u}`),
    safeDelete(`/rest/v1/email_link_codes?user_id=eq.${u}`),
    // Eski host-relay oda olayları kullanıcı kolonu taşımaz; uid'i içeren payload'lar en iyi çabayla silinir.
    safeDelete(`/rest/v1/game_events?payload=like.*${u}*`),
    safeDelete(`/rest/v1/direct_messages?or=(from_user.eq.${u},to_user.eq.${u})`),
    safeDelete(`/rest/v1/friendships?or=(requester.eq.${u},addressee.eq.${u})`),
    safeDelete(`/rest/v1/blocks?or=(blocker.eq.${u},blocked.eq.${u})`),
    safeDelete(`/rest/v1/invites?or=(from_user.eq.${u},to_user.eq.${u})`),
    safeDelete(`/rest/v1/gifts?or=(from_user.eq.${u},to_user.eq.${u})`),
    safeDelete(`/rest/v1/notifications?or=(user_id.eq.${u},actor_id.eq.${u})`),
    safeDelete(`/rest/v1/profile_views?or=(viewer_id.eq.${u},target_id.eq.${u})`),
    safeDelete(`/rest/v1/post_likes?user_id=eq.${u}`),
    safeDelete(`/rest/v1/post_comments?user_id=eq.${u}`),
    safeDelete(`/rest/v1/posts?user_id=eq.${u}`),
    safeDelete(`/rest/v1/lobby_chat?user_id=eq.${u}`),
    safeDelete(`/rest/v1/reports?or=(from_user.eq.${u},reported_user.eq.${u})`),
    safeDelete(`/rest/v1/presence?user_id=eq.${u}`),
    safeDelete(`/rest/v1/admin_rewards?user_id=eq.${u}`),
    safeDelete(`/rest/v1/bans?or=(target_user.eq.${u},created_by.eq.${u})`),
    safeDelete(`/rest/v1/direct_message_daily_usage?user_id=eq.${u}`),
    safeDelete(`/rest/v1/game_interest?user_id=eq.${u}`),
    safeDelete(`/rest/v1/promo_redemptions?user_id=eq.${u}`),
    safeDelete(`/rest/v1/push_devices?user_id=eq.${u}`),
    safeDelete(`/rest/v1/push_outbox?user_id=eq.${u}`),
    safeDelete(`/rest/v1/rewarded_ad_sessions?user_id=eq.${u}`),
    safeDelete(`/rest/v1/play_purchase_receipts?user_id=eq.${u}`),
    safeDelete(`/rest/v1/account_xp_events?user_id=eq.${u}`),
    safeDelete(`/rest/v1/daily_quest_progress?user_id=eq.${u}`),
    safeDelete(`/rest/v1/training_access_windows?user_id=eq.${u}`),
    safeDelete(`/rest/v1/training_rewarded_ad_sessions?user_id=eq.${u}`),
    safeDelete(`/rest/v1/training_legacy_access_grants?user_id=eq.${u}`),
    safeDelete(`/rest/v1/device_accounts?user_id=eq.${u}`),
    safeDelete(`/rest/v1/beta_welcome_claims?user_id=eq.${u}`),
    safeDelete(`/rest/v1/legal_acceptances?user_id=eq.${u}`),
    safeDelete(`/rest/v1/account_recovery_credentials?user_id=eq.${u}`),
    safeDelete(`/rest/v1/profiles?id=eq.${u}`),
  ]);
}

async function deleteAuthUser(userId: string): Promise<void> {
  const response = await serviceFetch(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok && response.status !== 404) throw new Error(`auth_delete_${response.status}`);
}

export async function isDeletedDevice(deviceHash: string): Promise<boolean> {
  if (!configured()) throw new Error('server_not_configured');
  const fingerprint = deletedDeviceFingerprint(deviceHash);
  const response = await serviceFetch(`/rest/v1/deleted_device_fingerprints?fingerprint_hash=eq.${encodeURIComponent(fingerprint)}&select=fingerprint_hash&limit=1`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 404 || /schema cache|does not exist|PGRST/i.test(text)) return false;
    throw new Error(`deleted_device_lookup_${response.status}`);
  }
  const rows: any[] = await response.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function deviceBoundToUser(deviceHash: string, userId: string): Promise<boolean> {
  const response = await serviceFetch(`/rest/v1/device_accounts?device_hash=eq.${encodeURIComponent(deviceHash)}&user_id=eq.${encodeURIComponent(userId)}&select=user_id&limit=1`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`device_lookup_${response.status}`);
  const rows: any[] = await response.json().catch(() => []);
  return Array.isArray(rows) && rows.some((row) => String(row?.user_id || '') === userId);
}

/**
 * PIN'li hesap: PIN zorunlu.
 * Yalnız cihaz hesabı (PIN yok): geçerli oturum + bu hesaba bağlı cihaz kodu + açık "SİL" onayı.
 */
export async function deleteAccount(req: Request): Promise<Record<string, unknown>> {
  if (!configured()) throw new Error('server_not_configured');
  const userId = await verifyToken(authHeader(req));
  if (!userId) throw new Error('auth_required');
  const deviceHash = validDeviceHash(req.body?.device_hash);
  assertAttemptBudget(userId);

  const pin = cleanPin(req.body?.pin);
  const hasConfirmation = validConfirmation(req.body?.confirmation);
  const recovery = await recoveryByUser(userId);
  const pinConfigured = !!(recovery && recovery.email && recovery.pin_hash);

  if (pinConfigured && recovery) {
    if (!pin && hasConfirmation) throw new Error('pin_required');
    if (!validPin(pin)) throw new Error('pin_invalid');
    if (!sameHash(recovery.pin_hash, pinHash(recovery.email, userId, pin))) {
      recordFailure(userId);
      throw new Error('pin_invalid');
    }
  } else {
    // Eski istemciler PIN gönderir; onlara cihaz onayı adımını göstermesi için ayırt edilebilir hata.
    if (!hasConfirmation) throw new Error(pin ? 'pin_not_configured' : 'confirmation_required');
    if (!(await deviceBoundToUser(deviceHash, userId))) {
      recordFailure(userId);
      throw new Error('device_mismatch');
    }
  }

  const deviceHashes = await deviceHashesForUser(userId).catch(() => [] as string[]);
  if (!deviceHashes.includes(deviceHash)) deviceHashes.push(deviceHash);

  await deleteAvatarObjects(userId);
  await recordDeletedDevice(deviceHash);
  await deleteKnownUserData(userId, deviceHashes);
  await deleteAuthUser(userId);
  failures.delete(userId);

  return {
    ok: true,
    deleted: true,
    device_fingerprint_recorded: true,
    method: pinConfigured ? 'pin' : 'device_confirmation',
  };
}
