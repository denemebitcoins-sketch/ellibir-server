import { describe, expect, it } from 'vitest';
import { entryCanakShare, entryHouseAmount } from './supabase';

describe('pot + komisyon + çanak', () => {
  it('4 koltuk tekli masada komisyon potun %10udur', () => {
    const house = entryHouseAmount({ bet: 1000, totalSeats: 4, teamMode: false, realSeats: 4 });
    expect(house).toBe(400);
    expect(entryCanakShare(house)).toBe(200);
  });

  it('4 koltuk eşli masada komisyon potun %10udur', () => {
    const house = entryHouseAmount({ bet: 1000, totalSeats: 4, teamMode: true, realSeats: 4 });
    expect(house).toBe(400);
    expect(entryCanakShare(house)).toBe(200);
  });

  it('tavlada (2 koltuk) komisyon potun %10udur', () => {
    const house = entryHouseAmount({ bet: 2500, totalSeats: 2, teamMode: false, realSeats: 2 });
    expect(house).toBe(500);
    expect(entryCanakShare(house)).toBe(250);
  });

  it('101 tekli de dahil tüm oyunlarda komisyon potun %10udur', () => {
    const house = entryHouseAmount({ bet: 1000, totalSeats: 4, teamMode: false, gameVariant: 'yuzbir', realSeats: 4 });
    expect(house).toBe(400);
    expect(entryCanakShare(house)).toBe(200);
  });

  it('komisyonun yarısı yanar, yarısı çanağa gider', () => {
    const house = entryHouseAmount({ bet: 500, totalSeats: 4, teamMode: false, realSeats: 4 });
    expect(house).toBe(200);
    expect(entryCanakShare(house)).toBe(100);
    expect(house - entryCanakShare(house)).toBe(100);
  });
});

describe('kazanç matematiği (yorumlu)', () => {
  it('4 kişi 1000 bahis: kazanan 3600 çip alır (pot 4000 - %10 komisyon)', () => {
    const pot = 4 * 1000;
    const prize = pot - Math.floor(pot * 0.1);
    expect(prize).toBe(3600);
  });

  it('4 kişi eşli: kazanan takım toplam 3600 alır, her eş 1800', () => {
    const pot = 4 * 1000;
    const prize = pot - Math.floor(pot * 0.1);
    expect(Math.floor(prize / 2)).toBe(1800);
  });

  it('tavla 1v1 1000 bahis: kazanan 1800 çip alır', () => {
    const pot = 2 * 1000;
    const prize = pot - Math.floor(pot * 0.1);
    expect(prize).toBe(1800);
  });
});
