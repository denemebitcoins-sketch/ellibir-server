import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const schema = readFileSync(join(root, 'social-schema.sql'), 'utf8');
const migration = readFileSync(join(root, 'migrations', '20260712_diamond_shop_purchase.sql'), 'utf8');

describe('server-authoritative mock diamond shop schema', () => {
  it.each([['main schema', schema], ['standalone migration', migration]])('%s persists the caller wallet', (_name, sql) => {
    expect(sql).toMatch(/function\s+public\.buy_diamond_package_mock\s*\(\s*p_package\s+int\s*\)/i);
    expect(sql).toMatch(/auth\.uid\s*\(\s*\)/i);
    expect(sql).toMatch(/from\s+public\.profiles[\s\S]*for\s+update/i);
    expect(sql).toMatch(/set\s+diamonds\s*=\s*v_diamonds/i);
    expect(sql).toMatch(/grant\s+execute\s+on\s+function\s+public\.buy_diamond_package_mock\(int\)\s+to\s+authenticated/i);
  });

  it('keeps all package rewards in the server catalog', () => {
    expect(migration).toMatch(/when\s+1\s+then\s+v_diamond_delta\s*:=\s*10/i);
    expect(migration).toMatch(/when\s+2\s+then\s+v_diamond_delta\s*:=\s*50/i);
    expect(migration).toMatch(/when\s+3\s+then\s+v_diamond_delta\s*:=\s*150/i);
    expect(migration).toMatch(/invalid_package/i);
  });
});
