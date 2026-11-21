import { describe, it, expect } from 'vitest';
import { canakBus, onCanakNews, fmtChips, type CanakNews } from './canakBus';

describe('canakBus', () => {
  it('her dinleyiciye haber dağıtır ve çözülen dinleyici artık almaz', () => {
    const got: string[] = [];
    const off1 = onCanakNews((n) => got.push('a:' + n.name));
    const off2 = onCanakNews((n) => got.push('b:' + n.name));
    const n: CanakNews = { game: 'okey', gameLbl: '101 Okey', uid: 'u1', name: 'Mehmet', amount: 1250000, postId: 7 };
    canakBus.emit('burst', n);
    off1();
    canakBus.emit('burst', { ...n, name: 'Ali' });
    off2();
    canakBus.emit('burst', { ...n, name: 'Veli' });
    expect(got).toEqual(['a:Mehmet', 'b:Mehmet', 'b:Ali']);
  });
  it('dinleyici hatası diğerlerini durdurmaz', () => {
    const got: string[] = [];
    const off1 = onCanakNews(() => { throw new Error('x'); });
    const off2 = onCanakNews((n) => got.push(n.name));
    canakBus.emit('burst', { game: '51', gameLbl: '51', uid: 'u', name: 'Z', amount: 1, postId: 0 });
    off1(); off2();
    expect(got).toEqual(['Z']);
  });
  it('tutarı binlik ayraçla yazar', () => {
    expect(fmtChips(1250000)).toBe('1.250.000');
    expect(fmtChips(999)).toBe('999');
  });
});
