import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const schema = readFileSync(join(root, 'social-schema.sql'), 'utf8');
const migration = readFileSync(join(root, 'migrations', '20260710_profile_dm_authority_hardening.sql'), 'utf8');

describe('profile and direct-message authority schema', () => {
  it.each([['main schema', schema], ['standalone migration', migration]])(
    '%s protects sensitive profile fields without a SECURITY DEFINER trigger bypass',
    (_name, sql) => {
      expect(sql).toMatch(/add\s+column\s+if\s+not\s+exists\s+message_banned_until\s+timestamptz/i);
      expect(sql).toMatch(/security\s+invoker[\s\S]*?new\.chips\s*:=\s*old\.chips/i);
      expect(sql).toMatch(/new\.message_banned_until\s*:=\s*old\.message_banned_until/i);
      expect(sql).toMatch(/new\.role\s*:=\s*old\.role/i);
      expect(sql).toMatch(/public\.is_current_user_admin\(\)/i);
    },
  );

  it.each([['main schema', schema], ['standalone migration', migration]])(
    '%s enforces DM, friendship, privacy and block rules in Postgres',
    (_name, sql) => {
      expect(sql).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.blocks/i);
      expect(sql).toMatch(/function\s+public\.can_send_direct_message\s*\(p_to\s+uuid\)/i);
      expect(sql).toMatch(/message_banned_until[\s\S]*?>\s*now\(\)/i);
      expect(sql).toMatch(/coalesce\s*\(p\.allow_dm,\s*true\)/i);
      expect(sql).toMatch(/f\.status\s*=\s*'accepted'/i);
      expect(sql).toMatch(/from\s+public\.blocks\s+b/i);
      expect(sql).toMatch(/create\s+policy\s+dm_insert[\s\S]*?can_send_direct_message\s*\(to_user\)/i);
      expect(sql).toMatch(/create\s+policy\s+friendships_insert[\s\S]*?can_send_friend_request\s*\(addressee\)/i);
    },
  );

  it.each([['main schema', schema], ['standalone migration', migration]])(
    '%s supports the admin message-ban type',
    (_name, sql) => {
      expect(sql).toMatch(/check\s*\(type\s+in\s*\(\s*'chat'\s*,\s*'message'\s*,\s*'game'\s*\)\s*\)/i);
      expect(sql).toMatch(/add\s+column\s+if\s+not\s+exists\s+created_by_name\s+text/i);
      expect(sql).toMatch(/create\s+policy\s+reports_delete[\s\S]*?is_current_user_admin\(\)/i);
    },
  );
});
