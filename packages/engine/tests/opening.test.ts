import { describe, expect, it } from 'vitest';
import { canOpen } from '../src/game';
import { DEFAULT_RULES, makeRules } from '../src/rules';
import { c, joker } from './helpers';

const R = DEFAULT_RULES;

describe('açma sınırı (temel 81)', () => {
  it('tam 81 puan açar', () => {
    // Q-Q-Q (30) + K-K-K (30) + 6-7-8 (21) = 81
    const melds = [
      [c('S', 12), c('H', 12), c('D', 12)],
      [c('S', 13), c('H', 13), c('D', 13)],
      [c('C', 6), c('C', 7), c('C', 8)],
    ];
    expect(canOpen(melds, R)).not.toBeNull();
  });

  it('80 puan açamaz', () => {
    // Q-Q-Q (30) + K-K-K (30) + 2-3-4-5-6 (20) = 80
    const melds = [
      [c('S', 12), c('H', 12), c('D', 12)],
      [c('S', 13), c('H', 13), c('D', 13)],
      [c('H', 2), c('H', 3), c('H', 4), c('H', 5), c('H', 6)],
    ];
    expect(canOpen(melds, R)).toBeNull();
  });

  it('joker, temsil ettiği kartın değeriyle 81 hesabına katılır', () => {
    // Q-Q-joker (30) + K-K-K (30) + 6-7-8 (21) = 81
    const melds = [
      [c('S', 12), c('H', 12), joker()],
      [c('S', 13), c('H', 13), c('D', 13)],
      [c('C', 6), c('C', 7), c('C', 8)],
    ];
    expect(canOpen(melds, R)).not.toBeNull();
  });

  it('joker düşük kartı temsil ederse açmaya yetmeyebilir', () => {
    // 2-joker-4 (9) + Q-Q-Q (30) + K-K-K (30) = 69 < 81
    const melds = [
      [c('H', 2), joker(), c('H', 4)],
      [c('S', 12), c('D', 12), c('C', 12)],
      [c('S', 13), c('D', 13), c('C', 13)],
    ];
    expect(canOpen(melds, R)).toBeNull();
  });

  it('grup geçersizse toplam yetse bile açılmaz', () => {
    const melds = [
      [c('S', 12), c('S', 12, 99), c('D', 12)], // aynı renk iki Q → geçersiz küt
      [c('S', 13), c('H', 13), c('D', 13)],
      [c('S', 1), c('H', 1), c('D', 1)],
    ];
    expect(canOpen(melds, R)).toBeNull();
  });

  it('dinamik sınır parametreyle doğrulanır (81 yeter, 101 yetmez)', () => {
    // 92 puanlık açış: A-A-A (33) + K-K-K (30) + 9-10-J (29)
    const melds = [
      [c('S', 1), c('H', 1), c('D', 1)],
      [c('S', 13), c('H', 13), c('D', 13)],
      [c('D', 9), c('D', 10), c('D', 11)],
    ];
    expect(canOpen(melds, R, 81)).not.toBeNull();
    expect(canOpen(melds, R, 101)).toBeNull();
  });

  it('açma sınırı konfigüre edilebilir', () => {
    const low = makeRules({ openingMinPoints: 21 });
    expect(canOpen([[c('C', 6), c('C', 7), c('C', 8)]], low)).not.toBeNull();
    expect(canOpen([[c('C', 6), c('C', 7), c('C', 8)]], R)).toBeNull();
  });
});
