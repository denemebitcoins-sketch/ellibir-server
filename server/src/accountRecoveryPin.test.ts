import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { _test } from './recoveryAuth';

const root = join(__dirname, '..');
const migration = readFileSync(join(root, 'migrations', '20260819_account_recovery_pin.sql'), 'utf8');

describe('mail + pin account recovery', () => {
  it('adds the private recovery credential table and profile marker', () => {
    expect(migration).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.account_recovery_credentials/i);
    expect(migration).toMatch(/email\s+text\s+not\s+null\s+unique/i);
    expect(migration).toMatch(/pin_hash\s+text\s+not\s+null/i);
    expect(migration).toMatch(/alter\s+table\s+public\.account_recovery_credentials\s+enable\s+row\s+level\s+security/i);
    expect(migration).toMatch(/revoke\s+all\s+on\s+public\.account_recovery_credentials\s+from\s+public,\s+anon,\s+authenticated/i);
    expect(migration).toMatch(/recovery_secured_at\s+timestamptz/i);
  });

  it('normalizes public inputs without accepting weak credentials', () => {
    expect(_test.normalizeEmail('  USER@Example.COM ')).toBe('user@example.com');
    expect(_test.validEmail('user@example.com')).toBe(true);
    expect(_test.validEmail('bad-email')).toBe(false);
    expect(_test.cleanPin('12 a34 56789')).toBe('12345678');
    expect(_test.validPin('123456')).toBe(true);
    expect(_test.validPin('12345')).toBe(false);
    expect(_test.validName('Bilgisayar Khvm')).toBe(true);
    expect(_test.validName('ab')).toBe(false);
    expect(_test.normalizeGender('K')).toBe('k');
  });

  it('ties pin hashes to both the email and user id', () => {
    const a = _test.pinHash('a@example.com', 'u1', '123456');
    const b = _test.pinHash('a@example.com', 'u2', '123456');
    const c = _test.pinHash('b@example.com', 'u1', '123456');

    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(_test.sameHash(a, a)).toBe(true);
    expect(_test.sameHash(a, b)).toBe(false);
  });

  it('does not report generic profile id duplicates as username conflicts', () => {
    expect(_test.profileWriteErrorToCode(409, 'profiles_name_lower_uniq')).toBe('name_taken');
    expect(_test.profileWriteErrorToCode(409, 'duplicate key value violates unique constraint "profiles_pkey"'))
      .toBe('profile_insert_409');
  });

  it('exposes an admin-only pin reset endpoint', () => {
    const recovery = readFileSync(join(root, 'src', 'recoveryAuth.ts'), 'utf8');
    const index = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
    expect(recovery).toMatch(/export\s+async\s+function\s+adminResetPinRecovery/i);
    expect(recovery).toMatch(/verifyToken\(authHeader\(req\)\)/i);
    expect(recovery).toMatch(/profileRole\(adminId\)[\s\S]*!==\s*'admin'/i);
    expect(recovery).toMatch(/updateAuthCredentials\(userId,\s*email,\s*password\)/i);
    expect(recovery).toMatch(/upsertRecovery\(userId,\s*email,\s*pin\)/i);
    expect(index).toMatch(/\/auth\/recovery\/admin-reset-pin/i);
    expect(index).toMatch(/admin_required[\s\S]*403/i);
  });

  it('allows legacy device recovery only before mail pin recovery is configured', () => {
    const recovery = readFileSync(join(root, 'src', 'recoveryAuth.ts'), 'utf8');
    const index = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
    expect(recovery).toMatch(/export\s+async\s+function\s+loginLegacyDeviceAccount/i);
    expect(recovery).toMatch(/userIdByDeviceHash\(deviceHash\)/i);
    expect(recovery).toMatch(/recoveryByUserId\(userId\)[\s\S]*pin_recovery_required/i);
    expect(recovery).toMatch(/legacyDeviceEmail\(userId\)/i);
    expect(recovery).toMatch(/needs_pin_setup:\s*true/i);
    expect(index).toMatch(/\/auth\/recovery\/device-login/i);
    expect(index).toMatch(/pin_recovery_required[\s\S]*409/i);
  });

  it('lets old clients secure device-bound accounts when their legacy JWT was not cached', () => {
    const recovery = readFileSync(join(root, 'src', 'recoveryAuth.ts'), 'utf8');
    expect(recovery).toMatch(/let\s+userId\s*=\s*await\s+verifyToken\(authHeader\(req\)\)/i);
    expect(recovery).toMatch(/if\s*\(!userId\)\s*{[\s\S]*userId\s*=\s*await\s+userIdByDeviceHash\(deviceHash\)/i);
    expect(recovery).toMatch(/recoveryByUserId\(userId\)[\s\S]*pin_recovery_required/i);
    expect(recovery).toMatch(/await\s+bindDevice\(userId,\s*deviceHash,\s*legacyDeviceSetup\)/i);
    expect(recovery).toMatch(/await\s+ensureProfilePlayableForRecovery\(userId\)/i);
    expect(recovery).toMatch(/const\s+session\s*=\s*await\s+passwordSession\(email,\s*password\)/i);
  });

  it('lets admins secure legacy device-bound accounts with contact email and pin', () => {
    const recovery = readFileSync(join(root, 'src', 'recoveryAuth.ts'), 'utf8');
    const index = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
    expect(recovery).toMatch(/export\s+async\s+function\s+adminSecureDeviceRecovery/i);
    expect(recovery).toMatch(/profileRole\(adminId\)[\s\S]*!==\s*'admin'/i);
    expect(recovery).toMatch(/userIdByDeviceHash\(deviceHash\)/i);
    expect(recovery).toMatch(/recoveryByEmail\(email\)[\s\S]*email_already_used/i);
    expect(recovery).toMatch(/markProfileSecured\(userId\)/i);
    expect(index).toMatch(/\/auth\/recovery\/admin-secure-device/i);
  });

  it('repairs auth credentials when a valid recovery pin cannot open a session', () => {
    const recovery = readFileSync(join(root, 'src', 'recoveryAuth.ts'), 'utf8');
    expect(recovery).toMatch(/async\s+function\s+passwordSessionForRecovery/i);
    expect(recovery).toMatch(/catch\s*{\s*await\s+updateAuthCredentials\(userId,\s*email,\s*password\)/i);
    expect(recovery).toMatch(/const\s+session\s*=\s*await\s+passwordSessionForRecovery\(userId,\s*email,\s*pin\)/i);
  });

  it('keeps recovered legacy profiles playable for old clients', () => {
    expect(_test.isPlayableProfileName('Samet')).toBe(true);
    expect(_test.isPlayableProfileName('Oyuncu_A1B2C3')).toBe(false);
    expect(_test.isPlayableProfileName('Oyuncu')).toBe(false);

    const recovery = readFileSync(join(root, 'src', 'recoveryAuth.ts'), 'utf8');
    expect(recovery).toMatch(/async\s+function\s+ensureProfilePlayableForRecovery/i);
    expect(recovery).toMatch(/patch\.gender\s*=\s*'x'/i);
    expect(recovery).toMatch(/await\s+ensureProfilePlayableForRecovery\(userId\)/i);
  });
});
