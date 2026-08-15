import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(__dirname, '../migrations/20260813_profile_auth_identity_guard.sql'), 'utf8');

describe('profile auth identity guard schema', () => {
  it('only allows authenticated clients to insert their own profile row', () => {
    expect(migration).toMatch(/alter table public\.profiles enable row level security/i);
    expect(migration).toMatch(/create policy profiles_insert_own on public\.profiles/i);
    expect(migration).toMatch(/for insert to authenticated/i);
    expect(migration).toMatch(/with check \(id::text = auth\.uid\(\)::text\)/i);
  });

  it('only allows authenticated clients to update their own profile row', () => {
    expect(migration).toMatch(/create policy profiles_update_own on public\.profiles/i);
    expect(migration).toMatch(/for update to authenticated/i);
    expect(migration).toMatch(/using \(id::text = auth\.uid\(\)::text\)/i);
    expect(migration).toMatch(/with check \(id::text = auth\.uid\(\)::text\)/i);
  });

  it('binds an install/device hash to one auth user before profile writes', () => {
    expect(migration).toMatch(/create table if not exists public\.device_accounts/i);
    expect(migration).toMatch(/function public\.bind_device_account\(p_device_hash text\)/i);
    expect(migration).toMatch(/p_device_hash !~ '\^\[0-9a-f\]\{64\}\$'/i);
    expect(migration).toMatch(/v_owner is not null and v_owner <> v_uid/i);
    expect(migration).toMatch(/'device_registered'/i);
    expect(migration).toMatch(/grant execute on function public\.bind_device_account\(text\) to authenticated/i);
  });
});
