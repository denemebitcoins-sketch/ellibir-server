import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const schema = readFileSync(join(root, 'social-schema.sql'), 'utf8');
const migration = readFileSync(join(root, 'migrations', '20260710_social_runtime_contract.sql'), 'utf8');
const contracts = [['main schema', schema], ['standalone migration', migration]] as const;

describe('active Supabase social runtime contract', () => {
  it.each(contracts)('%s defines every active social REST table', (_name, sql) => {
    for (const table of [
      'invites', 'posts', 'post_likes', 'post_comments',
      'notifications', 'profile_views', 'gifts',
    ]) {
      expect(sql).toMatch(new RegExp('create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.' + table, 'i'));
    }
    for (const column of [
      'table_info', 'table_started', 'table_seat', 'invite_pref', 'avatar_url',
    ]) {
      expect(sql).toMatch(new RegExp('alter\\s+table\\s+public\\.presence\\s+add\\s+column\\s+if\\s+not\\s+exists\\s+' + column, 'i'));
    }
    expect(sql).toMatch(/alter\s+table\s+public\.reports\s+add\s+column\s+if\s+not\s+exists\s+reported_user/i);
    expect(sql).toMatch(/alter\s+table\s+public\.reports\s+add\s+column\s+if\s+not\s+exists\s+context/i);
  });

  it.each(contracts)('%s makes presence and visible identity server-authoritative', (_name, sql) => {
    expect(sql).toMatch(/function\s+public\.presence_enforce_profile\(\)[\s\S]*?new\.last_seen\s*:=\s*now\(\)/i);
    expect(sql).toMatch(/new\.role\s*:=\s*case[\s\S]*?p\.vip_until/i);
    expect(sql).toMatch(/new\.chips\s*:=\s*greatest\s*\(coalesce\s*\(p\.chips/i);
    expect(sql).toMatch(/new\.avatar_url\s*:=\s*case[\s\S]*?p\.avatar_status/i);
    expect(sql).toMatch(/trigger\s+trg_presence_enforce_profile/i);
    expect(sql).toMatch(/trigger\s+trg_lobby_chat_enforce_actor/i);
    expect(sql).toMatch(/trigger\s+trg_invites_enforce_sender/i);
    expect(sql).toMatch(/trigger\s+trg_reports_enforce_sender/i);
  });

  it.each(contracts)('%s enforces chat, invite, notification and gift authority in RLS', (_name, sql) => {
    expect(sql).toMatch(/create\s+policy\s+lobby_chat_insert[\s\S]*?can_write_lobby_chat\(\)/i);
    expect(sql).toMatch(/create\s+policy\s+posts_insert[\s\S]*?can_write_social\(\)/i);
    expect(sql).toMatch(/create\s+policy\s+post_comments_insert[\s\S]*?can_write_social\(\)/i);
    expect(sql).toMatch(/create\s+policy\s+invites_insert[\s\S]*?can_send_invite\s*\(to_user\)/i);
    expect(sql).toMatch(/drop\s+policy\s+if\s+exists\s+notifications_insert/i);
    expect(sql).not.toMatch(/create\s+policy\s+notifications_insert/i);
    expect(sql).toMatch(/drop\s+policy\s+if\s+exists\s+gifts_insert/i);
    expect(sql).not.toMatch(/create\s+policy\s+gifts_insert/i);
  });

  it.each(contracts)('%s bounds transient social data growth', (_name, sql) => {
    expect(sql).toMatch(/function\s+public\.profile_view_dedupe\(\)[\s\S]*?interval\s+'1 hour'/i);
    expect(sql).toMatch(/delete\s+from\s+public\.profile_views\s+where\s+created_at\s+<\s+now\(\)\s+-\s+interval\s+'30 days'/i);
    expect(sql).toMatch(/function\s+public\.gifts_prune\(\)[\s\S]*?delete\s+from\s+public\.gifts/i);
    expect(sql).toMatch(/delete\s+from\s+public\.invites\s+where\s+created_at\s+<\s+now\(\)\s+-\s+interval\s+'1 day'/i);
  });

  it('creates gifts before the earlier gifts RLS block in the main schema', () => {
    expect(schema.indexOf('create table if not exists public.gifts (')).toBeGreaterThanOrEqual(0);
    expect(schema.indexOf('create table if not exists public.gifts ('))
      .toBeLessThan(schema.indexOf('alter table public.gifts enable row level security;'));
  });
});