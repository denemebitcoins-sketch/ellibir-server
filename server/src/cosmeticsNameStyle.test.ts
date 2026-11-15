import { describe, expect, it } from 'vitest';
import { NAME_STYLE_IDS, normalizeNameStyle, _test } from './cosmetics';

describe('name styles and paid themes catalog', () => {
  it('lists six name styles with tiered prices', () => {
    expect(NAME_STYLE_IDS).toHaveLength(6);
    const price = (id: string) => _test.COSMETICS[id]?.priceDiamonds;
    for (const id of ['name_style_silver', 'name_style_copper', 'name_style_fire', 'name_style_ice']) expect(price(id)).toBe(250);
    expect(price('name_style_gold_shimmer')).toBe(600);
    expect(price('name_style_rainbow')).toBe(1200);
    for (const id of NAME_STYLE_IDS) expect(_test.COSMETICS[id].category).toBe('name_style');
  });
  it('prices only the three paid themes', () => {
    for (const id of ['ui_theme_zumrut', 'ui_theme_sutlu_kahve', 'ui_theme_bordo_kadife']) {
      expect(_test.COSMETICS[id]).toMatchObject({ category: 'ui_theme', priceDiamonds: 150 });
    }
    expect(_test.COSMETICS.ui_theme_grafit).toBeUndefined();
  });
  it('drops unknown or spoofed styles', () => {
    expect(normalizeNameStyle('name_style_rainbow')).toBe('name_style_rainbow');
    expect(normalizeNameStyle('admin')).toBe('');
    expect(normalizeNameStyle(undefined)).toBe('');
  });
});
