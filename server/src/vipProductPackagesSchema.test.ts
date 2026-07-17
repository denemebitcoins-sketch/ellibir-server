import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const monetization = readFileSync(join(root, 'src', 'monetization.ts'), 'utf8');
const migration = readFileSync(join(root, 'migrations', '20260717_shop_product_packages.sql'), 'utf8');

describe('VIP package ids', () => {
  it('uses 1, 6 and 12 month subscription product ids server-side', () => {
    expect(monetization).toMatch(/onlinekahvem\.vip\.1month[\s\S]*vipMonths:\s*1/i);
    expect(monetization).toMatch(/onlinekahvem\.vip\.6month[\s\S]*vipMonths:\s*6/i);
    expect(monetization).toMatch(/onlinekahvem\.vip\.12month[\s\S]*vipMonths:\s*12/i);
    expect(monetization).not.toMatch(/onlinekahvem\.vip\.3month/i);
  });

  it('updates the database purchase finalizer for the 6 month VIP product', () => {
    expect(migration).toMatch(/onlinekahvem\.vip\.6month' then v_months := 6/i);
    expect(migration).not.toMatch(/onlinekahvem\.vip\.3month/i);
  });

  it('maps the production chip and diamond consumable packages', () => {
    expect(monetization).toMatch(/onlinekahvem\.chips\.100k[\s\S]*chips:\s*100_000/i);
    expect(monetization).toMatch(/onlinekahvem\.chips\.4000k[\s\S]*chips:\s*4_000_000/i);
    expect(monetization).toMatch(/onlinekahvem\.diamond\.100[\s\S]*diamonds:\s*100/i);
    expect(monetization).toMatch(/onlinekahvem\.diamond\.4000[\s\S]*diamonds:\s*4000/i);
    expect(migration).toMatch(/onlinekahvem\.chips\.1500k' then v_chip_delta := 1500000/i);
    expect(migration).toMatch(/onlinekahvem\.diamond\.1750' then v_diamonds := 1750/i);
  });
});
