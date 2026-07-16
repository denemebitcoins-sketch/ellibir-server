import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(__dirname, '..', 'migrations', '20260717_admin_friend_access.sql'),
  'utf8',
);

describe('accepted administrator friendship access', () => {
  it('grants social access only through an accepted friendship with the admin target', () => {
    const body = sql.match(/function\s+public\.can_view_profile_social[\s\S]*?\$\$;/i)?.[0] ?? '';
    expect(body).toMatch(/admin_target\.role\s*=\s*'admin'/i);
    expect(body).toMatch(/f\.status\s*=\s*'accepted'/i);
    expect(body).toMatch(/public\.is_current_user_vip\s*\(\s*\)/i);
  });

  it('allows DMs from an accepted friend while preserving target and block controls', () => {
    const body = sql.match(/function\s+public\.can_send_direct_message[\s\S]*?\$\$;/i)?.[0] ?? '';
    expect(body).toMatch(/coalesce\s*\(p\.allow_dm,\s*true\)/i);
    expect(body).toMatch(/f\.status\s*=\s*'accepted'/i);
    expect(body).toMatch(/from\s+public\.blocks/i);
  });
});
