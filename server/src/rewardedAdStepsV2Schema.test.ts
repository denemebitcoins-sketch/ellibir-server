import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const sql = readFileSync(join(root, 'migrations', '20261113_rewarded_ad_steps_v2.sql'), 'utf8');

describe('rewarded ad stepped economy v2', () => {
  it('raises the daily stepped chip rewards to 2500-5000-7500-10000-15000', () => {
    expect(sql).toMatch(/when coalesce\(p_used_before, 0\) <= 0 then 2500/i);
    expect(sql).toMatch(/when p_used_before = 1 then 5000/i);
    expect(sql).toMatch(/when p_used_before = 2 then 7500/i);
    expect(sql).toMatch(/when p_used_before = 3 then 10000/i);
    expect(sql).toMatch(/when p_used_before = 4 then 15000/i);
    expect(sql).toMatch(/alter column reward_chips set default 2500/i);
  });
});
