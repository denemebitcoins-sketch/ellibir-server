import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const schema = readFileSync(join(root, 'social-schema.sql'), 'utf8');
const migration = readFileSync(join(root, 'migrations', '20260713_daily_reward_history.sql'), 'utf8');

describe('daily reward weekly history schema', () => {
  it.each([['main schema', schema], ['standalone migration', migration]])(
    '%s keeps every claimed day in the current ISO week',
    (_name, sql) => {
      expect(sql).toMatch(/daily_claim_week\s+text/i);
      expect(sql).toMatch(/daily_claim_mask\s+integer\s+not\s+null\s+default\s+0/i);
      expect(sql).toMatch(/coalesce\s*\(\s*r\.daily_claim_week[\s\S]*?=\s*v_week/i);
      expect(sql).toMatch(/daily_claim_mask\s*=\s*\(\s*v_mask\s*\|\s*v_day_bit\s*\)/i);
      expect(sql).toMatch(/v_normal_claimed\s*:=\s*\(\s*v_mask\s*&\s*v_day_bit\s*\)\s*<>\s*0/i);
    },
  );

  it('protects reward history from ordinary profile upserts', () => {
    expect(migration).toMatch(/new\.daily_claim_week\s*:=\s*old\.daily_claim_week/i);
    expect(migration).toMatch(/new\.daily_claim_mask\s*:=\s*old\.daily_claim_mask/i);
  });

  it('keeps same-day VIP entitlement separate from the normal reward', () => {
    expect(migration).toMatch(/v_vip_only\s*:=\s*true/i);
    expect(migration).toMatch(/vip_last_daily\s*=\s*v_today/i);
    expect(migration).toMatch(/v_vip_claimable\s*:=\s*v_vip_active[\s\S]*?v_mask\s*&/i);
  });
});
