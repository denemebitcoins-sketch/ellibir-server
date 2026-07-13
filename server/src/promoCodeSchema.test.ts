import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const schema = readFileSync(join(root, 'social-schema.sql'), 'utf8');
const migration = readFileSync(join(root, 'migrations', '20260713_promo_codes.sql'), 'utf8');

describe('promotion code schema', () => {
  it.each([['main schema', schema], ['standalone migration', migration]])(
    '%s redeems a hidden catalog code atomically',
    (_name, sql) => {
      expect(sql).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.promo_codes/i);
      expect(sql).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.promo_redemptions/i);
      expect(sql).toMatch(/primary\s+key\s*\(\s*code\s*,\s*user_id\s*\)/i);
      expect(sql).toMatch(/function\s+public\.redeem_promo_code\s*\(\s*p_code\s+text\s*\)/i);
      expect(sql).toMatch(/from\s+public\.promo_codes[\s\S]*?for\s+update/i);
      expect(sql).toMatch(/from\s+public\.profiles[\s\S]*?for\s+update/i);
      expect(sql).toMatch(/insert\s+into\s+public\.promo_redemptions/i);
      expect(sql).toMatch(/set\s+chips\s*=\s*coalesce\s*\(\s*chips\s*,\s*0\s*\)\s*\+\s*c\.chip_reward/i);
      expect(sql).toMatch(/grant\s+execute\s+on\s+function\s+public\.redeem_promo_code\(text\)\s+to\s+authenticated/i);
    },
  );

  it('does not expose a direct authenticated read policy for the code catalog', () => {
    expect(migration).not.toMatch(/create\s+policy[\s\S]*?on\s+public\.promo_codes/i);
    expect(migration).toMatch(/alter\s+table\s+public\.promo_codes\s+enable\s+row\s+level\s+security/i);
  });
});
