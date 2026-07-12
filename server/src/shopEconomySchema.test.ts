import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const schema = readFileSync(join(root, 'social-schema.sql'), 'utf8');
const migration = readFileSync(join(root, 'migrations', '20260712_chip_shop_exchange.sql'), 'utf8');

describe('authoritative chip shop schema', () => {
  it.each([['main schema', schema], ['standalone migration', migration]])('%s locks and updates the caller wallet', (_name, sql) => {
    expect(sql).toMatch(/function\s+public\.buy_chip_package\s*\(\s*p_package\s+int\s*\)/i);
    expect(sql).toMatch(/auth\.uid\s*\(\s*\)/i);
    expect(sql).toMatch(/from\s+public\.profiles[\s\S]*for\s+update/i);
    expect(sql).toMatch(/set\s+chips\s*=\s*v_chips\s*,\s*diamonds\s*=\s*v_diamonds/i);
    expect(sql).toMatch(/grant\s+execute\s+on\s+function\s+public\.buy_chip_package\(int\)\s+to\s+authenticated/i);
  });

  it('accepts only the three catalog packages', () => {
    expect(migration).toMatch(/when\s+1\s+then\s+v_chip_delta\s*:=\s*1000;\s*v_diamond_cost\s*:=\s*2/i);
    expect(migration).toMatch(/when\s+2\s+then\s+v_chip_delta\s*:=\s*3000;\s*v_diamond_cost\s*:=\s*5/i);
    expect(migration).toMatch(/when\s+3\s+then\s+v_chip_delta\s*:=\s*8000;\s*v_diamond_cost\s*:=\s*10/i);
    expect(migration).toMatch(/invalid_package/i);
  });
});
