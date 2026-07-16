import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const migration = readFileSync(
  join(root, 'migrations', '20260716_vip_entitlements.sql'),
  'utf8',
);

describe('VIP storefront entitlements', () => {
  it('derives VIP from the authoritative expiry and treats administrators as VIP', () => {
    const body = migration.match(
      /function\s+public\.is_current_user_vip[\s\S]*?\$\$;/i,
    )?.[0] ?? '';
    expect(body).toMatch(/p\.role\s*=\s*'admin'/i);
    expect(body).toMatch(/p\.vip_until\s*>\s*now\s*\(\s*\)/i);
    expect(migration).toMatch(/revoke\s+execute[\s\S]*is_current_user_vip\(\)[\s\S]*public,\s*anon/i);
  });

  it('requires VIP for another player social surface while preserving admin rules', () => {
    const body = migration.match(
      /function\s+public\.can_view_profile_social[\s\S]*?\$\$;/i,
    )?.[0] ?? '';
    expect(body).toMatch(/p_target\s*=\s*auth\.uid\(\)::text/i);
    expect(body).toMatch(/or\s+public\.is_current_user_admin\s*\(\s*\)/i);
    expect(body).toMatch(/public\.is_current_user_vip\s*\(\s*\)/i);
    expect(body).toMatch(/admin_target\.role\s*=\s*'admin'/i);
    expect(body).toMatch(/profile_visibility\s*=\s*'friends'/i);
  });

  it('keeps direct like and comment writes behind social access policies', () => {
    expect(migration).toMatch(
      /create\s+policy\s+post_likes_insert[\s\S]*can_view_post_social\s*\(post_id\)/i,
    );
    expect(migration).toMatch(
      /create\s+policy\s+post_comments_insert[\s\S]*can_write_social\(\)[\s\S]*can_view_post_social\s*\(post_id\)/i,
    );
  });
});
