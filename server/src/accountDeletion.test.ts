import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ verifyToken: vi.fn(async (token: string) => (token === 'good-token' ? USER : null)) }));

const USER = '11111111-2222-3333-4444-555555555555';
const DEVICE = 'a'.repeat(64);
const OTHER_DEVICE = 'b'.repeat(64);
const SECRET = 'pin-secret';
const EMAIL = 'oyuncu@example.com';

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

type Setup = { pinHash?: string; boundDevices?: string[]; avatarStatus?: number; avatarBody?: unknown };

function installFetch(setup: Setup) {
  const calls: { url: string; method: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = String(init?.method || 'GET');
    calls.push({ url, method });
    if (url.includes('/rest/v1/account_recovery_credentials') && method === 'GET') {
      return json(setup.pinHash ? [{ email: EMAIL, pin_hash: setup.pinHash }] : []);
    }
    if (url.includes('/rest/v1/device_accounts') && method === 'GET') {
      const bound = setup.boundDevices || [];
      const m = /device_hash=eq\.([0-9a-f]{64})/.exec(url);
      const rows = bound.filter((h) => !m || h === m[1]).map((h) => ({ device_hash: h, user_id: USER }));
      return json(rows);
    }
    if (url.includes('/storage/v1/object/avatars/')) return json(setup.avatarBody ?? {}, setup.avatarStatus ?? 200);
    if (url.includes('/rest/v1/deleted_device_fingerprints') && method === 'GET') return json([]);
    return json({}, method === 'POST' ? 201 : 200);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function req(body: Record<string, unknown>, token = 'good-token') {
  return { header: (name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined), body } as any;
}

async function load() {
  const mod = await import('./accountDeletion');
  mod.resetAccountDeletionAttempts();
  return mod;
}

describe('deleteAccount', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    process.env.ACCOUNT_PIN_SECRET = SECRET;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ACCOUNT_PIN_SECRET;
  });

  it('deletes a device-only account with a bound device hash and SİL confirmation', async () => {
    const calls = installFetch({ boundDevices: [DEVICE, OTHER_DEVICE] });
    const { deleteAccount } = await load();
    const result = await deleteAccount(req({ device_hash: DEVICE, confirmation: 'SİL' }));
    expect(result).toMatchObject({ ok: true, deleted: true, method: 'device_confirmation' });

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(deletes.some((u) => u.endsWith(`/storage/v1/object/avatars/${USER}.jpg`))).toBe(true);
    expect(deletes.some((u) => u.includes(`/auth/v1/admin/users/${USER}`))).toBe(true);
    expect(deletes.some((u) => u.includes(`/rest/v1/canak_events?user_id=eq.${USER}`))).toBe(true);
    expect(deletes.some((u) => u.includes(`/rest/v1/email_link_codes?user_id=eq.${USER}`))).toBe(true);
    expect(deletes.some((u) => u.includes('/rest/v1/game_events?'))).toBe(true);
    expect(deletes.some((u) => u.includes(`/rest/v1/reports?from_user=is.null&context=like.*${DEVICE}*`))).toBe(true);
    expect(deletes.some((u) => u.includes(`/rest/v1/reports?from_user=is.null&context=like.*${OTHER_DEVICE}*`))).toBe(true);
    expect(deletes.some((u) => u.includes(`/rest/v1/profiles?id=eq.${USER}`))).toBe(true);
    expect(calls.some((c) => c.url.includes('/rest/v1/deleted_device_fingerprints') && c.method === 'POST')).toBe(true);
  });

  it.each(['SIL', 'sil', 'sİl', ' Sil '])('accepts confirmation spelling %j', async (word) => {
    installFetch({ boundDevices: [DEVICE] });
    const { deleteAccount } = await load();
    await expect(deleteAccount(req({ device_hash: DEVICE, confirmation: word }))).resolves.toMatchObject({ ok: true });
  });

  it('rejects a device hash that is not bound to the account and deletes nothing', async () => {
    const calls = installFetch({ boundDevices: [OTHER_DEVICE] });
    const { deleteAccount } = await load();
    await expect(deleteAccount(req({ device_hash: DEVICE, confirmation: 'SİL' }))).rejects.toThrow('device_mismatch');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('rejects a device-only deletion without the typed confirmation', async () => {
    const calls = installFetch({ boundDevices: [DEVICE] });
    const { deleteAccount } = await load();
    await expect(deleteAccount(req({ device_hash: DEVICE }))).rejects.toThrow('confirmation_required');
    await expect(deleteAccount(req({ device_hash: DEVICE, confirmation: 'evet' }))).rejects.toThrow('confirmation_required');
    // Eski istemci PIN gönderir → ayırt edilebilir hata, istemci onay adımına geçer.
    await expect(deleteAccount(req({ device_hash: DEVICE, pin: '123456' }))).rejects.toThrow('pin_not_configured');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('requires an authenticated session', async () => {
    const calls = installFetch({ boundDevices: [DEVICE] });
    const { deleteAccount } = await load();
    await expect(deleteAccount(req({ device_hash: DEVICE, confirmation: 'SİL' }, 'bad'))).rejects.toThrow('auth_required');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('tolerates a missing avatar object (404 / not found)', async () => {
    installFetch({ boundDevices: [DEVICE], avatarStatus: 400, avatarBody: { statusCode: '404', error: 'not_found', message: 'Object not found' } });
    const { deleteAccount } = await load();
    await expect(deleteAccount(req({ device_hash: DEVICE, confirmation: 'SİL' }))).resolves.toMatchObject({ ok: true });
  });

  it('keeps requiring the PIN for PIN accounts', async () => {
    const pinHash = createHmac('sha256', SECRET).update(`pin|${USER}|${EMAIL}|123456`).digest('hex');
    const calls = installFetch({ pinHash, boundDevices: [DEVICE] });
    const { deleteAccount } = await load();

    await expect(deleteAccount(req({ device_hash: DEVICE, confirmation: 'SİL' }))).rejects.toThrow('pin_required');
    await expect(deleteAccount(req({ device_hash: DEVICE, pin: '654321', confirmation: 'SİL' }))).rejects.toThrow('pin_invalid');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    const result = await deleteAccount(req({ device_hash: OTHER_DEVICE, pin: '123456' }));
    expect(result).toMatchObject({ ok: true, method: 'pin' });
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/storage/v1/object/avatars/${USER}.jpg`))).toBe(true);
  });

  it('rate limits repeated failed attempts', async () => {
    installFetch({ boundDevices: [OTHER_DEVICE] });
    const { deleteAccount } = await load();
    for (let i = 0; i < 5; i++) {
      await expect(deleteAccount(req({ device_hash: DEVICE, confirmation: 'SİL' }))).rejects.toThrow('device_mismatch');
    }
    await expect(deleteAccount(req({ device_hash: DEVICE, confirmation: 'SİL' }))).rejects.toThrow('too_many_requests');
  });
});
