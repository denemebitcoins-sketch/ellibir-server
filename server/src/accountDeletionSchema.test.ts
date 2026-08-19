import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const migration = readFileSync(resolve(root, 'migrations/20260820_account_delete_device_fingerprint.sql'), 'utf8');
const accountDeletion = readFileSync(resolve(root, 'src/accountDeletion.ts'), 'utf8');
const recovery = readFileSync(resolve(root, 'src/recoveryAuth.ts'), 'utf8');
const index = readFileSync(resolve(root, 'src/index.ts'), 'utf8');

describe('account deletion and deleted-device guard', () => {
  it('stores only an anonymous deleted-device fingerprint in Supabase', () => {
    expect(migration).toMatch(/create table if not exists public\.deleted_device_fingerprints/i);
    expect(migration).toMatch(/fingerprint_hash text primary key/i);
    expect(migration).not.toMatch(/last_deleted_user|email text|device_hash text|user_id uuid/i);
    expect(migration).toMatch(/revoke all on public\.deleted_device_fingerprints from public,\s*anon,\s*authenticated/i);
  });

  it('exposes an authenticated account deletion endpoint and validates PIN', () => {
    expect(index).toMatch(/post\('\/auth\/account\/delete'/i);
    expect(accountDeletion).toMatch(/verifyToken\(authHeader\(req\)\)/i);
    expect(accountDeletion).toMatch(/pinHash\(recovery\.email,\s*userId,\s*pin\)/i);
    expect(accountDeletion).toMatch(/deleteKnownUserData\(userId\)/i);
    expect(accountDeletion).toMatch(/\/rest\/v1\/profiles\?id=eq\.\$\{u\}/i);
    expect(accountDeletion).toMatch(/\/rest\/v1\/push_devices\?user_id=eq\.\$\{u\}/i);
    expect(accountDeletion).toMatch(/deleteAuthUser\(userId\)/i);
  });

  it('blocks new account creation on devices that previously deleted an account', () => {
    expect(recovery).toMatch(/import \{ isDeletedDevice \} from '\.\/accountDeletion'/i);
    expect(recovery).toMatch(/if \(await isDeletedDevice\(deviceHash\)\) throw new Error\('device_deleted'\)/i);
    expect(index).toMatch(/message === 'device_deleted'/i);
  });

  it('does not break new-account creation if the migration has not been applied yet', () => {
    expect(accountDeletion).toMatch(/response\.status === 404/i);
    expect(accountDeletion).toMatch(/schema cache\|does not exist\|PGRST/i);
    expect(accountDeletion).toMatch(/return false/i);
  });
});
