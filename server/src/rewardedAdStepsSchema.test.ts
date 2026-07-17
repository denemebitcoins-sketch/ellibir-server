import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const sql = readFileSync(join(root, 'migrations', '20260717_rewarded_ad_steps.sql'), 'utf8');

describe('rewarded ad stepped economy', () => {
  it('credits the daily stepped chip rewards and exposes the next reward', () => {
    expect(sql).toMatch(/when coalesce\(p_used_before, 0\) <= 0 then 1000/i);
    expect(sql).toMatch(/when p_used_before = 1 then 1250/i);
    expect(sql).toMatch(/when p_used_before = 2 then 1500/i);
    expect(sql).toMatch(/when p_used_before = 3 then 1750/i);
    expect(sql).toMatch(/when p_used_before = 4 then 2000/i);
    expect(sql).toMatch(/insert into public\.rewarded_ad_sessions\(user_id, device_hash, reward_chips\)/i);
    expect(sql).toMatch(/reward_chips', public\.rewarded_ad_chips_for_index\(v_used\)/i);
  });
});
