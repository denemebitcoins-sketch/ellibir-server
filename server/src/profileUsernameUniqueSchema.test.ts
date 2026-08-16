import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(__dirname, '../migrations/20260816_profile_username_unique.sql'),
  'utf8',
);
const clientContracts = readFileSync(resolve(__dirname, 'clientRecoveryContracts.test.ts'), 'utf8');

describe('profile username uniqueness contract', () => {
  it('adds a case-insensitive unique index for completed visible usernames', () => {
    expect(migration).toMatch(/create\s+unique\s+index\s+if\s+not\s+exists\s+profiles_name_lower_uniq/i);
    expect(migration).toMatch(/lower\s*\(\s*btrim\s*\(\s*name\s*\)\s*\)/i);
    expect(migration).toMatch(/btrim\s*\(\s*name\s*\)\s*!~\s*'\^Oyuncu_\[0-9A-F\]\{6,10\}\$'/i);
  });

  it('keeps the Unity onboarding contract tied to backend availability and save-time conflict handling', () => {
    expect(clientContracts).toContain('SupabaseProfile.IsNameTaken');
    expect(clientContracts).toContain('SupabaseProfile.PushWithResult');
    expect(clientContracts).toContain('Bu kullanıcı adı kullanılıyor.');
  });
});
