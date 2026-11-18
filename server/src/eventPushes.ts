import { rpcService } from './supabase';

/**
 * 18.11 ZAMANLANMIŞ BİLDİRİMLER — Türkiye saatine göre (Render sunucusu UTC çalışır; eskiden getHours() UTC'ydi
 * ve 19:00 hatırlatması TR 22:00'de gidiyordu).
 *  - 19:00 günlük ödül hatırlatması (enqueue_daily_reminders)
 *  - 19:50 Kahve Saati hatırlatması (enqueue_coffee_hour_reminders)
 *  - Haftanın Kahvecisi: hafta kapanınca ilk 10'a bildirim (enqueue_weekly_winner_pushes, weekly_close_due sonrası)
 * Hepsi DB tarafında günlük/haftalık tekrar korumalı; sunucu yeniden başlasa da çift gitmez.
 */
export function trClock(now = new Date()): { day: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<any>;
export interface EventPushState { daily: string; coffee: string }

/** Tek tur: saati gelen işleri bir kez çalıştırır. Test edilebilir (saat ve rpc dışarıdan). */
export async function eventPushTick(state: EventPushState, now = new Date(), rpc: Rpc = rpcService): Promise<string[]> {
  const c = trClock(now);
  const done: string[] = [];
  if (c.hour === 19 && state.daily !== c.day) {
    state.daily = c.day;
    const n = await rpc('enqueue_daily_reminders', {}).catch((e: any) => { console.error('[daily-reminder]', e?.message || e); return null; });
    if (n != null) { console.log('[daily-reminder] kuyruklandı:', n); done.push('daily'); }
  }
  if (c.hour === 19 && c.minute >= 48 && state.coffee !== c.day) {
    state.coffee = c.day;
    const n = await rpc('enqueue_coffee_hour_reminders', {}).catch((e: any) => { console.error('[coffee-reminder]', e?.message || e); return null; });
    if (n != null) { console.log('[coffee-reminder] kuyruklandı:', n); done.push('coffee'); }
  }
  return done;
}

export async function weeklyCloseTick(rpc: Rpc = rpcService): Promise<number> {
  const n = Number(await rpc('weekly_close_due', {}).catch((e: any) => { console.warn('[weekly]', e?.message || e); return 0; })) || 0;
  if (n > 0) console.log('[weekly] ödül dağıtıldı:', n);
  // ödül dağıtıldıysa (veya önceki tur bildirim kuyruklayamadıysa) kazananlara bildirim — idempotent
  const p = Number(await rpc('enqueue_weekly_winner_pushes', {}).catch((e: any) => { console.warn('[weekly-push]', e?.message || e); return 0; })) || 0;
  if (p > 0) console.log('[weekly-push] kuyruklandı:', p);
  return n;
}

export function startEventPushes(): void {
  const state: EventPushState = { daily: '', coffee: '' };
  setInterval(() => { void eventPushTick(state); }, 2 * 60 * 1000).unref?.();
  setInterval(() => { void weeklyCloseTick(); }, 10 * 60 * 1000).unref?.();
}
