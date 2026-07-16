import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const migration = readFileSync(
  join(root, 'migrations', '20260716_admin_social_access.sql'),
  'utf8',
);

describe('administrator social access matrix', () => {
  it('lets administrators bypass privacy and requires accepted friendship for admin targets', () => {
    const body = migration.match(
      /function\s+public\.can_view_profile_social[\s\S]*?\$\$;/i,
    )?.[0] ?? '';
    expect(body).toMatch(/or\s+public\.is_current_user_admin\s*\(\s*\)/i);
    expect(body).toMatch(/admin_target\.role\s*=\s*'admin'/i);
    expect(body).toMatch(/f\.status\s*=\s*'accepted'/i);
    expect(body).toMatch(/profile_visibility\s*=\s*'friends'/i);
  });

  it('allows administrator DMs and accepted-friend replies with block controls', () => {
    const body = migration.match(
      /function\s+public\.can_send_direct_message[\s\S]*?\$\$;/i,
    )?.[0] ?? '';
    expect(body).toMatch(/public\.is_current_user_admin\s*\(\s*\)\s+or/i);
    expect(body).toMatch(/f\.status\s*=\s*'accepted'/i);
    expect(body).toMatch(/coalesce\s*\(p\.allow_dm,\s*true\)/i);
    expect(body).toMatch(/from\s+public\.blocks/i);
  });

  it('applies the same directionality to friend requests and keeps RLS authoritative', () => {
    const body = migration.match(
      /function\s+public\.can_send_friend_request[\s\S]*?\$\$;/i,
    )?.[0] ?? '';
    expect(body).toMatch(/public\.is_current_user_admin\s*\(\s*\)\s+or/i);
    expect(body).toMatch(/admin_target\.role\s*=\s*'admin'/i);
    expect(migration).toMatch(/create\s+policy\s+dm_insert[\s\S]*can_send_direct_message\s*\(to_user\)/i);
    expect(migration).toMatch(/create\s+policy\s+friendships_insert[\s\S]*can_send_friend_request\s*\(addressee\)/i);
  });
});
