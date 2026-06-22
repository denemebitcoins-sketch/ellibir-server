import { Room, Client } from '@colyseus/core';
// Mevcut TS motor — RN-free, olduğu gibi kullanılır.
import { createGame, applyMove, viewFor, startNextHand } from '../../../packages/engine/src/game';
import { HeuristicBot } from '../../../packages/engine/src/bot';
import { clientViewFor } from '../clientView';

/**
 * Bir MASA = bir oda. Engine state odada bellekte; her hamlede oyunculara kendi
 * (Unity-uyumlu) view'ı WebSocket ile PUSH edilir. Bot adımlama, el geçişi ve
 * reconnect odada yönetilir. State senkronu "view mesajı" modeli.
 */
export class EllibirRoom extends Room {
  maxClients = 4;

  private game: any;
  private seats = new Map<string, number>();   // sessionId → koltuk
  private humanSeats: number[] = [];           // gerçek oyuncu koltukları
  private handEndTimer: NodeJS.Timeout | null = null;
  private bot = new HeuristicBot('normal');

  onCreate(options: any) {
    const seed = options?.seed ?? Math.floor(Math.random() * 1_000_000_000);
    const names = options?.names ?? ['Oyuncu 1', 'Oyuncu 2', 'Oyuncu 3', 'Oyuncu 4'];
    this.humanSeats = Array.isArray(options?.humanSeats) ? options.humanSeats : [0];
    const botSeats = [0, 1, 2, 3].filter((s) => !this.humanSeats.includes(s));
    this.game = createGame({ seed, playerNames: names, botSeats });

    // Lobi/matchmaking metadata (boş koltuk bilgisi).
    this.setMetadata({ table: options?.table ?? 0, humans: this.humanSeats.length });

    this.onMessage('move', (client, move) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null) return;
      try {
        this.game = applyMove(this.game, move);
      } catch (e: any) {
        client.send('moveError', { code: e?.code ?? 'err', message: e?.message ?? '' });
        return;
      }
      this.afterMove();
    });

    // Dağıtıcı bot olabilir → ilk adımları işlet.
    this.stepBots();
    console.log(`[EllibirRoom] oluştu seed=${seed} humans=${this.humanSeats}`);
  }

  onJoin(client: Client, _options: any) {
    // İlk boş İNSAN koltuğunu ver.
    const taken = new Set(this.seats.values());
    const seat = this.humanSeats.find((s) => !taken.has(s)) ?? this.seats.size;
    this.seats.set(client.sessionId, seat);
    client.send('seat', { seat });
    this.pushViews();
  }

  async onLeave(client: Client, consented: boolean) {
    const seat = this.seats.get(client.sessionId);
    if (consented) { this.seats.delete(client.sessionId); return; }
    try {
      // Reconnect penceresi: 90 sn içinde dönerse koltuk korunur (token'la).
      await this.allowReconnection(client, 90);
      this.pushViews();
    } catch {
      // Dönmedi → koltuk "abandoned": bot devralır (stepBots o koltuğu da oynar).
      this.seats.delete(client.sessionId);
      this.afterMove();
    }
  }

  // ── Hamle sonrası: bot adımla, view push, el sonu otomasyonu ──────────────
  private afterMove() {
    this.stepBots();
    this.pushViews();
    if (this.game.phase === 'handEnded') {
      if (this.handEndTimer) clearTimeout(this.handEndTimer);
      this.handEndTimer = setTimeout(() => this.continueHand(), 3000);
    }
  }

  private continueHand() {
    if (this.game.phase !== 'handEnded') return;
    try { this.game = startNextHand(this.game); } catch { return; }
    this.stepBots();
    this.pushViews();
  }

  // ── Bot/terk eden koltukları otomatik oynat (Edge bot loop ile aynı) ──────
  private stepBots() {
    for (let guard = 0; guard < 400; guard++) {
      const phase = this.game.phase;
      if (phase === 'matchEnded' || phase === 'handEnded') return;

      // Sırada/sorguda karar verecek koltuk:
      let decider = this.game.currentSeat;
      const sorgu = this.game.sorgu;
      if (sorgu) {
        decider = sorgu.asama === 'ortakGorus' ? sorgu.partnerSeat
                : sorgu.asama === 'cevap'      ? sorgu.sorulanSeat
                : sorgu.askerSeat;
      }
      // Bu koltukta GERÇEK (bağlı) oyuncu varsa dur — onu bekle.
      const occupied = new Set(this.seats.values());
      if (occupied.has(decider)) return;

      // Boş/bot koltuk → bot oynar.
      try {
        const view = viewFor(this.game, decider);
        this.game = applyMove(this.game, this.bot.nextMove(view));
      } catch {
        return; // bot çıkmaza girerse döngüyü kır
      }
    }
  }

  private pushViews() {
    this.clients.forEach((c) => {
      const seat = this.seats.get(c.sessionId);
      if (seat != null) c.send('view', clientViewFor(this.game, seat));
    });
  }

  onDispose() {
    if (this.handEndTimer) clearTimeout(this.handEndTimer);
  }
}
