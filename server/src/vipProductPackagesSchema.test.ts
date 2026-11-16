import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const monetization = readFileSync(join(root, 'src', 'monetization.ts'), 'utf8');
const migration = readFileSync(join(root, 'migrations', '20260717_shop_product_packages.sql'), 'utf8');
const scale = readFileSync(join(root, 'migrations', '20261116_shop_amounts_scale.sql'), 'utf8');

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
    // 2026-11-16: miktarlar büyütüldü (fiyat/ürün kimliği aynı) → 20261116_shop_amounts_scale.sql
    expect(monetization).toMatch(/onlinekahvem\.chips\.100k'[^\n]*chips:\s*500_000/i);
    expect(monetization).toMatch(/onlinekahvem\.chips\.4000k'[^\n]*chips:\s*20_000_000/i);
    expect(monetization).toMatch(/onlinekahvem\.diamond\.100'[^\n]*diamonds:\s*750/i);
    expect(monetization).toMatch(/onlinekahvem\.diamond\.4000'[^\n]*diamonds:\s*30_000/i);
    expect(scale).toContain("'onlinekahvem.chips.1500k' then v_chip_delta := 7500000;");
    expect(scale).toContain("'onlinekahvem.diamond.1750' then v_diamonds := 13000;");
    expect(scale).toContain('v_chips_delta := v_chips_delta + 50000;');
    expect(scale).toContain('v_diamonds_delta := v_diamonds_delta + 40;');
    expect(migration).toMatch(/onlinekahvem\.chips\.1500k' then v_chip_delta := 1500000/i);
    expect(migration).toMatch(/onlinekahvem\.diamond\.1750' then v_diamonds := 1750/i);
  });
});
