import { describe, expect, it } from 'vitest';
import { analyzeCards, analyzeRun, analyzeSet, meldPoints } from '../src/melds';
import { DEFAULT_RULES } from '../src/rules';
import { c, joker } from './helpers';

const R = DEFAULT_RULES;

describe('küt (set)', () => {
  it('3 farklı renk aynı rank geçerlidir', () => {
    const a = analyzeSet([c('S', 9), c('H', 9), c('D', 9)], R);
    expect(a?.type).toBe('set');
    expect(a?.points).toBe(27);
  });

  it('aynı renkten iki kart geçersizdir', () => {
    expect(analyzeSet([c('S', 9), c('S', 9), c('D', 9)], R)).toBeNull();
  });

  it('farklı rank geçersizdir', () => {
    expect(analyzeSet([c('S', 9), c('H', 8), c('D', 9)], R)).toBeNull();
  });

  it('4 kartlık küt geçerli, 5 geçersizdir', () => {
    expect(analyzeSet([c('S', 5), c('H', 5), c('D', 5), c('C', 5)], R)?.points).toBe(20);
    expect(analyzeCards([c('S', 5, 0), c('H', 5, 0), c('D', 5, 0), c('C', 5, 0), c('S', 5, 1)], R)).toBeNull();
  });

  it('joker eksik rengi doldurur ve temsil ettiği kartın puanını alır', () => {
    const a = analyzeSet([c('S', 12), c('H', 12), joker()], R);
    expect(a?.points).toBe(30); // Q=10, joker da 10 sayılır
    expect(a?.jokers[0]?.rank).toBe(12);
    expect(a?.jokers[0]?.suits.sort()).toEqual(['C', 'D']);
  });

  it('as kütü as değerinden sayılır', () => {
    expect(analyzeSet([c('S', 1), c('H', 1), c('D', 1)], R)?.points).toBe(33);
  });
});

describe('seri (run)', () => {
  it('A-2-3 GEÇERSİZDİR — As alttan oynamaz (ARA DÜZELTME)', () => {
    expect(analyzeRun([c('H', 1), c('H', 2), c('H', 3)], R)).toBeNull();
    expect(analyzeCards([c('H', 1), c('H', 2), c('H', 3)], R)).toBeNull();
  });

  it('2-3-4 geçerlidir (serinin en küçük kartı 2)', () => {
    const a = analyzeRun([c('H', 2), c('H', 3), c('H', 4)], R);
    expect(a?.type).toBe('run');
    expect(a?.points).toBe(2 + 3 + 4);
  });

  it('Q-K-A geçerlidir (as yalnız üstten)', () => {
    const a = analyzeRun([c('S', 12), c('S', 13), c('S', 1)], R);
    expect(a?.points).toBe(10 + 10 + R.acePoints);
  });

  it('K-A-2 (başa dönüş) geçersizdir', () => {
    expect(analyzeRun([c('S', 13), c('S', 1), c('S', 2)], R)).toBeNull();
    expect(analyzeCards([c('S', 13), c('S', 1), c('S', 2)], R)).toBeNull();
  });

  it('farklı renk seri bozar, 2 kart yetmez', () => {
    expect(analyzeRun([c('S', 4), c('H', 5), c('S', 6)], R)).toBeNull();
    expect(analyzeRun([c('S', 4), c('S', 5)], R)).toBeNull();
  });

  it('joker boşluğu doldurur ve yerine geçtiği kartın puanını alır', () => {
    const a = analyzeRun([c('D', 4), joker(), c('D', 6)], R);
    expect(a?.points).toBe(4 + 5 + 6);
    expect(a?.jokers[0]).toMatchObject({ rank: 5, suits: ['D'] });
  });

  it('analyzeCards karışık verilen kartları kendisi dizer', () => {
    const a = analyzeCards([c('C', 7), c('C', 5), c('C', 6), c('C', 8)], R);
    expect(a?.type).toBe('run');
    expect(a?.points).toBe(26);
    expect(a?.cards.map((card) => (card.joker ? 0 : card.rank))).toEqual([5, 6, 7, 8]);
  });

  it('analyzeCards as içeren seriyi yalnız ÜSTTEN dizer', () => {
    expect(meldPoints([c('H', 2), c('H', 1), c('H', 3)], R)).toBeNull(); // A-2-3 yok
    expect(meldPoints([c('H', 13), c('H', 1), c('H', 12)], R)).toBe(20 + R.acePoints);
  });

  it('artan joker uca eklenir, 14 pozisyonu aşılamaz', () => {
    // Q-K + joker: joker ancak As (yüksek) olabilir → 10+10+11
    const a = analyzeCards([c('S', 12), c('S', 13), joker()], R);
    expect(a?.points).toBe(10 + 10 + R.acePoints);
    expect(a?.jokers[0]?.rank).toBe(1);
  });

  it('okey+2+3 dizisinde okey AS YERİNE GEÇEMEZ — ancak üst uca (4) oturur', () => {
    // [★,2,3] verilen sırada: ★ pozisyon 1 (As altı) olurdu → geçersiz.
    expect(analyzeRun([joker(), c('D', 2), c('D', 3)], R)).toBeNull();
    // Otomatik dizmede okey 4 olur: 2-3-★(4) = 9 puan.
    const a = analyzeCards([joker(), c('D', 2), c('D', 3)], R);
    expect(a?.points).toBe(2 + 3 + 4);
    expect(a?.jokers[0]?.rank).toBe(4);
  });

  it('tek gerçek kart + 2 okey GEÇERLİDİR; sıfır gerçek kart geçersizdir (RULES.md 1.3)', () => {
    // Okey sınırı yok: [7♠,★,★] geçerli per (puan önceliğiyle 7-8-9 = 24).
    const a = analyzeCards([c('S', 7), joker(0), joker(1)], R);
    expect(a).not.toBeNull();
    expect(a?.points).toBe(24);
    // Rank/renk kaynağı yok: yalnız okeylerden per kurulamaz.
    expect(analyzeCards([joker(0), joker(1)], R)).toBeNull();
  });
});
