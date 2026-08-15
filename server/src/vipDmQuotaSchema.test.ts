import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(__dirname, '..', 'migrations', '20260717_vip_dm_quota.sql'),
  'utf8',
);

describe('VIP direct-message quota', () => {
  it('creates a daily usage table and exposes VIP/admin expanded limits', () => {
    expect(sql).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.direct_message_daily_usage/i);
    expect(sql).toMatch(/then\s+5000/i);
    expect(sql).toMatch(/else\s+20/i);
    expect(sql).toMatch(/p\.role\s*=\s*'admin'/i);
    expect(sql).toMatch(/p\.vip_until\s+is\s+not\s+null\s+and\s+p\.vip_until\s*>\s*now\(\)/i);
  });

  it('enforces the quota from the direct_messages insert trigger', () => {
    expect(sql).toMatch(/function\s+public\.direct_messages_enforce_daily_quota[\s\S]*raise\s+exception\s+'dm_daily_limit:%'/i);
    expect(sql).toMatch(/create\s+trigger\s+trg_direct_messages_daily_quota[\s\S]*before\s+insert\s+on\s+public\.direct_messages/i);
    expect(sql).toMatch(/on\s+conflict\s+\(user_id,\s*usage_day\)[\s\S]*sent_count\s*=\s*public\.direct_message_daily_usage\.sent_count\s*\+\s*1/i);
  });
});
