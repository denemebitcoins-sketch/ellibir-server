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
});
