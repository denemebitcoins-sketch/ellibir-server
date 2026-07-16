import { describe, expect, it } from 'vitest';
import {
  SPECIAL_FINISH_CHANCE,
  TAVLA_MARS_CHANCE,
  ellibirCanakChance,
  okeyCanakChance,
  tavlaCanakChance,
} from './canakPolicy';

describe('canak olasilik politikasi', () => {
  it('Okey turlerinde yalniz ozel bitisleri yuzde bir kabul eder', () => {
    expect(SPECIAL_FINISH_CHANCE).toBe(0.01);
    expect(okeyCanakChance('normal')).toBe(0);
    expect(okeyCanakChance('')).toBe(0);
    expect(okeyCanakChance('okey')).toBe(0.01);
    expect(okeyCanakChance('pairs')).toBe(0.01);
    expect(okeyCanakChance('pairsOkey')).toBe(0.01);
  });

  it('51 ozel bitislerini yuzde bir kabul eder', () => {
    expect(ellibirCanakChance(false, false)).toBe(0);
    expect(ellibirCanakChance(true, false)).toBe(0.01);
    expect(ellibirCanakChance(false, true)).toBe(0.01);
    expect(ellibirCanakChance(true, true)).toBe(0.01);
  });

  it('Tavlada yalniz Mars icin binde bes kullanir', () => {
    expect(TAVLA_MARS_CHANCE).toBe(0.005);
    expect(tavlaCanakChance(false)).toBe(0);
    expect(tavlaCanakChance(true)).toBe(0.005);
  });
});
