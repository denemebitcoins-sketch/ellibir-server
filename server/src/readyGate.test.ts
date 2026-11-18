import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { ReadyGate, KICK_BAN_MS } from './readyGate';

describe('ReadyGate (6.9 hazır sistemi)', () => {
  it('yalnız tüm insan oturumlar yeni istemciyse açılır', () => {
    const g = new ReadyGate(() => {});
    g.observe('a', { readyGate: true });
    g.observe('b', {});
    expect(g.active(['a'])).toBe(true);
    expect(g.active(['a', 'b'])).toBe(false);
    expect(g.active([])).toBe(false);
  });

  it('hazır fazı: herkes hazır olunca açılır, sıfırlanınca kapanır', () => {
    const g = new ReadyGate(() => {});
    expect(g.enter(1000)).toBe(true);
    expect(g.enter(2000)).toBe(false);
    g.ready.add(0); g.ready.add(1);
    expect(g.allReady([0, 1, 2])).toBe(false);
    g.ready.add(2);
    expect(g.allReady([0, 1, 2])).toBe(true);
    g.reset();
    expect(g.inPhase).toBe(false);
    expect(g.ready.size).toBe(0);
    g.dispose();
  });

  it('20 sn dolunca zaman aşımı çağrılır', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const g = new ReadyGate(onTimeout, 20_000);
    g.enter();
    vi.advanceTimersByTime(19_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('masa sahibi en erken oturan; ayrılınca sıradaki', () => {
    const g = new ReadyGate(() => {});
    g.noteSeated(2); g.noteSeated(0); g.noteSeated(3);
    expect(g.ownerSeat([0, 2, 3])).toBe(2);
    g.noteLeft(2);
    expect(g.ownerSeat([0, 3])).toBe(0);
  });

  it('atılan oyuncu 10 dk oturamaz', () => {
    const g = new ReadyGate(() => {});
    g.ban('u1', 0);
    expect(g.banLeftMs('u1', 1000)).toBe(KICK_BAN_MS - 1000);
    expect(g.banLeftMs('u1', KICK_BAN_MS + 1)).toBe(0);
    expect(g.banLeftMs('u2', 0)).toBe(0);
  });

  it('canlı botlar birkaç saniyede HAZIR der; faz biterse demez', () => {
    vi.useFakeTimers();
    const g = new ReadyGate(() => {}, 20_000);
    const seen: number[] = [];
    g.enter();
    g.scheduleBots([1, 3], (s) => seen.push(s), 1000, 1001);
    vi.advanceTimersByTime(999);
    expect(g.ready.size).toBe(0);
    vi.advanceTimersByTime(5);
    expect([...g.ready].sort()).toEqual([1, 3]);
    expect(seen.sort()).toEqual([1, 3]);
    g.reset();
    g.enter();
    g.scheduleBots([2], () => {}, 1000, 1001);
    g.reset();
    vi.advanceTimersByTime(2000);
    expect(g.ready.has(2)).toBe(false);
    vi.useRealTimers();
  });

  it('masa boşalınca atma yasakları düşer', () => {
    const g = new ReadyGate(() => {});
    g.ban('u1');
    expect(g.banLeftMs('u1')).toBeGreaterThan(0);
    g.clearBans();
    expect(g.banLeftMs('u1')).toBe(0);
  });

  it('maç sonu oyları yeni maçın hazırı olur', () => {
    const g = new ReadyGate(() => {});
    g.seed([1, 3]);
    expect(g.allReady([1, 3])).toBe(true);
    expect(g.inPhase).toBe(false);
  });
});

describe('odalar hazır sistemine bağlı', () => {
  it.each(['EllibirRoom.ts', 'OkeyRoom.ts', 'TavlaRoom.ts'])('%s', (name) => {
    const src = readFileSync(resolve(__dirname, `rooms/${name}`), 'utf8');
    expect(src).toMatch(/this\.readyGate\.observe\(client\.sessionId, options\)/);
    expect(src).toMatch(/if \(!this\.readyGateOpen\(\)\) \{ this\.pushViews\(\); return; \}/);
    expect(src).toMatch(/onMessage\('preReady'/);
    expect(src).toMatch(/onMessage\('kick'/);
    expect(src).toMatch(/this\.readyGate\.noteLeft\(seat\)/);
    expect(src).toMatch(/this\.readyGate\.seed\(/);
    expect(src).toMatch(/readySeats = \[\.\.\.this\.readyGate\.ready\]/);
    expect(src).toMatch(/kickBanReason\(uid\)/);
    expect(src).toMatch(/scheduleBots\(botSeats/);
    expect(src).toMatch(/if \(this\.seats\.size === 0\) this\.readyGate\.clearBans\(\)/);
    expect(src).toMatch(/scheduleBots\(botSeats/);
    expect(src).toMatch(/if \(this\.seats\.size === 0\) this\.readyGate\.clearBans\(\)/);
  });
});
