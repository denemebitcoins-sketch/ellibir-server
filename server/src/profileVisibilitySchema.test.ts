import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const schema = readFileSync(join(root, 'social-schema.sql'), 'utf8');
const migration = readFileSync(join(root, 'migrations', '20260713_profile_visibility.sql'), 'utf8');
const contracts = [['main schema', schema], ['standalone migration', migration]] as const;

describe('profile social visibility schema', () => {
  it.each(contracts)('%s defines the three visibility levels and access RPCs', (_name, sql) => {
    expect(sql).toMatch(/profile_visibility\s+text\s+not\s+null\s+default\s+'open'/i);
    expect(sql).toMatch(/profile_visibility\s+in\s*\(\s*'open'\s*,\s*'friends'\s*,\s*'hidden'\s*\)/i);
    expect(sql).toMatch(/function\s+public\.can_view_profile_social\s*\(p_target\s+text\)/i);
    expect(sql).toMatch(/function\s+public\.profile_social_access\s*\(p_user\s+text\)/i);
    expect(sql).toMatch(/function\s+public\.profile_friends\s*\(p_user\s+text\)/i);
  });

  it.each(contracts)('%s only exposes friend counts and lists to permitted viewers', (_name, sql) => {
    expect(sql).toMatch(/function\s+public\.friend_count\s*\(p_user\s+text\)[\s\S]*?return\s+-1/i);
    expect(sql).toMatch(/profile_visibility\s*=\s*'friends'[\s\S]*?f\.status\s*=\s*'accepted'/i);
    expect(sql).toMatch(/profile_friends[\s\S]*?can_view_profile_social\s*\(p_user\)/i);
  });

  it.each(contracts)('%s protects posts, likes and comments at RLS level', (_name, sql) => {
    expect(sql).toMatch(/create\s+policy\s+posts_select[\s\S]*?can_view_profile_social\s*\(user_id::text\)/i);
    expect(sql).toMatch(/create\s+policy\s+post_likes_select[\s\S]*?can_view_post_social\s*\(post_id\)/i);
    expect(sql).toMatch(/create\s+policy\s+post_comments_select[\s\S]*?can_view_post_social\s*\(post_id\)/i);
    expect(sql).toMatch(/create\s+policy\s+post_comments_insert[\s\S]*?can_view_post_social\s*\(post_id\)/i);
  });
});
