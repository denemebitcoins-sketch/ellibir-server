import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const migration = readFileSync(
  join(root, 'migrations', '20260716_beta_feature_flags.sql'),
  'utf8',
);

describe('free beta economy feature gates', () => {
  it('starts shop and daily disabled and exposes only boolean client flags', () => {
    expect(migration).toMatch(/\('shop',\s*false\)/i);
    expect(migration).toMatch(/\('daily',\s*false\)/i);
    expect(migration).toMatch(/function\s+public\.get_client_feature_flags\s*\(\s*\)/i);
    expect(migration).toMatch(/'shop',\s*public\.has_app_feature\('shop'\)/i);
    expect(migration).toMatch(/'daily',\s*public\.has_app_feature\('daily'\)/i);
    expect(migration).toMatch(/revoke\s+all\s+on\s+table\s+public\.app_features/i);
  });

  it('allows a feature only globally, for its tester list, or for admins', () => {
    expect(migration).toMatch(/p\.role\s*=\s*'admin'/i);
    expect(migration).toMatch(/select\s+f\.enabled\s+from\s+public\.app_features/i);
    expect(migration).toMatch(/from\s+public\.app_feature_testers\s+t[\s\S]*t\.feature_key\s*=\s*p_key/i);
  });

  it.each([
    ['chip exchange', 'buy_chip_package', 'shop'],
    ['daily claim', 'claim_daily', 'daily'],
    ['receipt-free diamonds', 'buy_diamond_package_mock', 'economy_test'],
  ])('%s is guarded inside the authoritative RPC', (_name, fn, feature) => {
    const body = migration.match(new RegExp(
      `function\\s+public\\.${fn}[\\s\\S]*?end;\\s*\\$\\$`,
      'i',
    ))?.[0] ?? '';
    expect(body).toMatch(new RegExp(`not\\s+public\\.has_app_feature\\('${feature}'\\)`, 'i'));
    expect(body).toMatch(/beta_locked/i);
  });

  it('keeps mock VIP purchases unavailable to authenticated clients', () => {
    expect(migration).toMatch(
      /revoke\s+execute\s+on\s+function\s+public\.buy_vip_mock\(int\)\s+from\s+public,\s*anon,\s*authenticated/i,
    );
  });
});
