/**
 * 21.11 AFK KORUMASI (etkinlik puanı kasma önlemi).
 *
 * Bir insan üst üste AFK_LATE_TURNS sırasını süresinde oynamazsa (ilk hamlesi görünen süre dolduktan
 * sonra gelir ya da sunucu süresi dolunca otomatik oynar) "AFK" sayılır: koltuğu bot devralır ve
 * AFK_RETURN_MS (3 dk) içinde süresinde bir hamle yapmazsa masadan çıkarılır (onLeave yolu →
 * kalıcı bot; haftalık puan / Kahve Saati gibi katılım ödüllerini almaz).
 *
 * "away" (uygulama arka planda / menüye döndü) da AFK sayılır. Geri dönüş (away=false) süreyi
 * DURDURUR ama sıfırlamaz: süresinde oynanan ilk sıra her şeyi temizler; yeniden AFK olursa
 * kalan süreden devam eder (arka plana at-geri gel ile sonsuz uzatma yok).
 */
export const AFK_LATE_TURNS = 3;
export const AFK_RETURN_MS = 180_000;
/** İstemci otomatik oynaması görünen süre DOLUNCA olur; bu kadar öncesi "zamanında" sayılır. */
export const AFK_LATE_SLACK_MS = 300;

export interface AfkHooks {
  /** Koltuğu bota devret (room.abandoned / setAbandoned) + oyuncuya bildir. */
  takeOver(seat: number, msLeft: number): void;
  /** Süre doldu: oyuncuyu masadan çıkar. */
  remove(seat: number): void;
}

export class AfkGuard {
  private streak = new Map<number, number>();
  private deadline = new Map<number, number>();
  private suspended = new Map<number, number>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private turnSeat = -1;
  private turnLate = false;

  constructor(private hooks: AfkHooks, private returnMs = AFK_RETURN_MS, private lateTurns = AFK_LATE_TURNS,
    private now: () => number = () => Date.now()) {}

  /** İnsan oyuncunun sırasındaki her komuttan ÖNCE çağrılır (visibleDeadlineAt: ekranda görünen süre sonu, 0 = süre yok). */
  beforeCommand(seat: number, visibleDeadlineAt: number) {
    if (this.turnSeat === seat) return;               // aynı sıranın sonraki adımı: ilk hamle belirler
    this.turnSeat = seat;
    this.turnLate = visibleDeadlineAt > 0 && this.now() >= visibleDeadlineAt - AFK_LATE_SLACK_MS;
  }

  /** Komut uygulandıktan sonra: sıra bu koltuktan çıktıysa sıra kapanır. */
  afterCommand(seat: number, stillMyTurn: boolean) {
    if (stillMyTurn || this.turnSeat !== seat) return;
    const late = this.turnLate;
    this.turnSeat = -1; this.turnLate = false;
    this.turnEnded(seat, late);
  }

  /** Sunucu süresi dolunca otomatik oynadı. */
  timedOut(seat: number) {
    if (this.turnSeat === seat) { this.turnSeat = -1; this.turnLate = false; }
    this.turnEnded(seat, true);
  }

  turnEnded(seat: number, late: boolean) {
    if (!late) { this.clearSeat(seat); return; }
    const n = (this.streak.get(seat) ?? 0) + 1;
    this.streak.set(seat, n);
    if (n >= this.lateTurns) this.markAfk(seat, true);
  }

  /** away=true: koltuk zaten bota geçti (oda yapar) → yalnız süre başlar. away=false: süre durur. */
  away(seat: number, away: boolean) {
    if (away) { this.markAfk(seat, false); return; }
    const at = this.deadline.get(seat);
    if (at == null) return;
    this.suspended.set(seat, Math.max(30_000, at - this.now()));
    this.deadline.delete(seat);
    const t = this.timers.get(seat); if (t) clearTimeout(t); this.timers.delete(seat);
  }

  isAfk(seat: number) { return this.deadline.has(seat); }
  msLeft(seat: number) { const at = this.deadline.get(seat); return at == null ? 0 : Math.max(0, at - this.now()); }

  private markAfk(seat: number, takeOver: boolean) {
    if (!this.deadline.has(seat)) {
      const ms = this.suspended.get(seat) ?? this.returnMs;
      this.suspended.delete(seat);
      this.deadline.set(seat, this.now() + ms);
      const t = setTimeout(() => {
        this.timers.delete(seat); this.deadline.delete(seat); this.streak.delete(seat); this.suspended.delete(seat);
        this.hooks.remove(seat);
      }, ms);
      (t as any).unref?.();
      this.timers.set(seat, t);
    }
    if (takeOver) this.hooks.takeOver(seat, this.msLeft(seat));
  }

  clearSeat(seat: number) {
    this.streak.delete(seat); this.deadline.delete(seat); this.suspended.delete(seat);
    const t = this.timers.get(seat); if (t) clearTimeout(t); this.timers.delete(seat);
    if (this.turnSeat === seat) { this.turnSeat = -1; this.turnLate = false; }
  }

  reset() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear(); this.streak.clear(); this.deadline.clear(); this.suspended.clear();
    this.turnSeat = -1; this.turnLate = false;
  }
}
