/**
 * 6.9 HAZIR SİSTEMİ (kullanıcı kuralları):
 *  - Masa dolmadan HAZIR denemez. Dolunca istemciye "tableFull" (ses + mesaj) gider.
 *  - Herkes HAZIR → 3 sn geri sayım → oyun başlar. Biri kalkarsa koltuk boşalır, hazırlar sıfırlanır.
 *  - 20 sn içinde HAZIR demeyen masadan kaldırılır (izleyiciye düşer).
 *  - Maç sonu "Devam/HAZIR" oyu bir sonraki maçın hazırı sayılır (rematch oyları taşınır).
 *  - Masa sahibi (masaya ilk oturan; ayrılırsa sıradaki) yalnız BEKLERKEN atabilir; atılan 10 dk o masaya oturamaz.
 * Geriye uyum: sistem YALNIZ masadaki tüm insan oturumlar katılırken `readyGate:true` bildirdiyse açılır
 * (6.7 istemcileri hazır düğmesini bilmez → eski 7 sn otomatik başlangıç sürer).
 */
export const READY_TIMEOUT_MS = 20_000;
export const READY_START_MS = 3_000;
export const KICK_BAN_MS = 10 * 60_000;

export class ReadyGate {
  readonly ready = new Set<number>();
  private readonly capable = new Set<string>();
  private readonly seatOrder = new Map<number, number>();
  private readonly bans = new Map<string, number>();
  private orderSeq = 0;
  private phaseAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onTimeout: () => void,
    private readonly timeoutMs = Number(process.env.READY_TIMEOUT_MS) > 0 ? Number(process.env.READY_TIMEOUT_MS) : READY_TIMEOUT_MS) {}

  observe(sessionId: string, options: any) {
    const v = options?.readyGate;
    if (v === true || v === 'true' || v === 1 || v === '1') this.capable.add(sessionId);
  }

  /** Masadaki tüm insan oturumları yeni istemciyse true (en az bir insan olmalı). */
  active(humanSessionIds: Iterable<string>): boolean {
    let any = false;
    for (const sid of humanSessionIds) { any = true; if (!this.capable.has(sid)) return false; }
    return any;
  }

  get inPhase(): boolean { return this.phaseAt > 0; }

  /** Hazır fazına gir; ilk girişte true (masa yeni doldu). */
  enter(now = Date.now()): boolean {
    if (this.phaseAt > 0) return false;
    this.phaseAt = now;
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; this.onTimeout(); }, this.timeoutMs);
    (this.timer as any)?.unref?.();
    return true;
  }

  msLeft(now = Date.now()): number {
    return this.phaseAt > 0 ? Math.max(0, this.timeoutMs - (now - this.phaseAt)) : 0;
  }

  allReady(seats: Iterable<number>): boolean {
    let any = false;
    for (const s of seats) { any = true; if (!this.ready.has(s)) return false; }
    return any;
  }

  /** Faz biter, hazırlar silinir (biri kalktı / oyun başladı / süre doldu). */
  reset() { this.ready.clear(); this.phaseAt = 0; this.clearTimer(); }

  /** Maç sonu oyları bir sonraki maçın hazırı olur. */
  seed(seats: Iterable<number>) { this.reset(); for (const s of seats) this.ready.add(s); }

  noteSeated(seat: number) { this.seatOrder.set(seat, ++this.orderSeq); }
  noteLeft(seat: number) { this.seatOrder.delete(seat); this.ready.delete(seat); }

  /** Masa sahibi: oturanlar içinde en erken oturan. Yoksa -1. */
  ownerSeat(occupied: Iterable<number>): number {
    let best = -1, bestOrder = Number.POSITIVE_INFINITY;
    for (const s of occupied) {
      const o = this.seatOrder.get(s);
      if (o != null && o < bestOrder) { bestOrder = o; best = s; }
    }
    return best;
  }

  ban(uid: string, now = Date.now()) { if (uid) this.bans.set(uid, now + KICK_BAN_MS); }
  banLeftMs(uid: string | null | undefined, now = Date.now()): number {
    if (!uid) return 0;
    const until = this.bans.get(uid);
    if (until == null) return 0;
    if (until <= now) { this.bans.delete(uid); return 0; }
    return until - now;
  }

  dispose() { this.clearTimer(); }
  private clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
}
