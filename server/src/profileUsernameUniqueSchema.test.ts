import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(__dirname, '../migrations/20260816_profile_username_unique.sql'),
  'utf8',
);
const clientContracts = readFileSync(resolve(__dirname, 'clientRecoveryContracts.test.ts'), 'utf8');

describe('profile username uniqueness contract', () => {
  it('guards future completed visible usernames case-insensitively without requiring old data cleanup', () => {
    expect(migration).toMatch(/create\s+index\s+if\s+not\s+exists\s+profiles_name_lower_lookup_idx/i);
    expect(migration).toMatch(/lower\s*\(\s*btrim\s*\(\s*name\s*\)\s*\)/i);
    expect(migration).toMatch(/btrim\s*\(\s*name\s*\)\s*!~\s*'\^Oyuncu_\[0-9A-F\]\{6,10\}\$'/i);
    expect(migration).toMatch(/function\s+public\.guard_profile_name_unique\(\)/i);
    expect(migration).toMatch(/pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*v_norm,\s*0\s*\)\s*\)/i);
    expect(migration).toMatch(/raise exception 'profiles_name_lower_uniq'[\s\S]*errcode = '23505'/i);
    expect(migration).toMatch(/create trigger trg_profiles_name_unique[\s\S]*before insert or update of name on public\.profiles/i);
  });

  it('keeps the Unity onboarding contract tied to backend availability and save-time conflict handling', () => {
    expect(clientContracts).toContain('SupabaseProfile.IsNameTaken');
    expect(clientContracts).toContain('SupabaseProfile.PushWithResult');
    expect(clientContracts).toContain('Bu kullanıcı adı kullanılıyor.');
  });
});
