import { describe, expect, it } from 'vitest';
import { eventPushTick, trClock, weeklyCloseTick } from './eventPushes';

const at = (iso: string) => new Date(iso);

describe('zamanlanmış bildirimler (TR saati)', () => {
  it('TR saatini UTC sunucuda doğru okur', () => {
    expect(trClock(at('2026-11-18T16:50:00Z'))).toEqual({ day: '2026-11-18', hour: 19, minute: 50 });
    expect(trClock(at('2026-11-18T21:30:00Z')).day).toBe('2026-11-19');
  });

  it('19:00 TR günlük hatırlatma, 19:48+ Kahve Saati; her biri günde bir kez', async () => {
    const calls: string[] = [];
    const rpc = async (fn: string) => { calls.push(fn); return 3; };
    const st = { daily: '', coffee: '' };
    await eventPushTick(st, at('2026-11-18T15:59:00Z'), rpc);           // 18:59 TR
    expect(calls).toEqual([]);
    await eventPushTick(st, at('2026-11-18T16:01:00Z'), rpc);           // 19:01 TR
    expect(calls).toEqual(['enqueue_daily_reminders']);
    await eventPushTick(st, at('2026-11-18T16:30:00Z'), rpc);           // 19:30 TR
    expect(calls).toEqual(['enqueue_daily_reminders']);
    await eventPushTick(st, at('2026-11-18T16:49:00Z'), rpc);           // 19:49 TR
    await eventPushTick(st, at('2026-11-18T16:55:00Z'), rpc);           // 19:55 TR (tekrar yok)
    expect(calls).toEqual(['enqueue_daily_reminders', 'enqueue_coffee_hour_reminders']);
    await eventPushTick(st, at('2026-11-18T19:00:00Z'), rpc);           // 22:00 TR — eski UTC hatası artık tetiklemez
    expect(calls.length).toBe(2);
    await eventPushTick(st, at('2026-11-19T16:50:00Z'), rpc);           // ertesi gün 19:50
    expect(calls.slice(2)).toEqual(['enqueue_daily_reminders', 'enqueue_coffee_hour_reminders']);
  });

  it('hafta kapanışı sonrası kazanan bildirimi kuyruklanır; hata turu bozmaz', async () => {
    const calls: string[] = [];
    expect(await weeklyCloseTick(async (fn) => { calls.push(fn); return fn === 'weekly_close_due' ? 10 : 10; })).toBe(10);
    expect(calls).toEqual(['weekly_close_due', 'enqueue_weekly_winner_pushes']);
    expect(await weeklyCloseTick(async () => { throw new Error('db'); })).toBe(0);
  });
});
