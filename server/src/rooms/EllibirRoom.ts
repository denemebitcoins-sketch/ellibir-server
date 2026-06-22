import { Room, Client } from '@colyseus/core';
import { createGame, startNextHand } from '../../../packages/engine/src/game';
import { clientViewFor } from '../clientView';
import { applyClientCommand, stepEngine, CmdError } from '../gameCommands';

/**
 * Bir MASA = bir oda. Engine state odada bellekte; her komutta oyunculara kendi
 * (Unity-uyumlu) view'ı WebSocket ile PUSH edilir. Client protokolü (openSelected,
 * play, isle, continue, move...) gameCommands ile engine Move'a çevrilir; sorgu/bot
 * otomasyonu stepEngine'de. State senkronu "view mesajı" modeli.
 */
export class EllibirRoom extends Room {
  maxClients = 4;

  private game: any;
  private seats = new Map<string, number>();   // sessionId → koltuk
  private humanSeats: number[] = [];
  private handEndTimer: NodeJS.Timeout | null = null;

  onCreate(options: any) {
    const seed = options?.seed ?? Math.floor(Math.random() * 1_000_000_000);
    const names = options?.names ?? ['Oyuncu 1', 'Oyuncu 2', 'Oyuncu 3', 'Oyuncu 4'];
    this.humanSeats = Array.isArray(options?.humanSeats) ? options.humanSeats : [0];
    const botSeats = [0, 1, 2, 3].filter((s) => !this.humanSeats.includes(s));
    this.game = createGame({ seed, playerNames: names, botSeats });
    this.setMetadata({ table: options?.table ?? 0, humans: this.humanSeats.length });

    // Tek mesaj kanalı: client'ın tüm komutları "cmd" olarak gelir (t alanı tipi belirler).
    this.onMessage('cmd', (client, raw) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null) return;
      let cmd: any;
      try { cmd = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch { client.send('moveError', { code: 'bad_json' }); return; }
      try {
        const r = applyClientCommand(this.game, cmd, seat);
        this.game = r.state;
        if (!r.skipBots) this.game = stepEngine(this.game, (s) => this.isHumanTurn(s));
      } catch (e: any) {
        if (e instanceof CmdError) client.send('moveError', { code: e.code });
        else { console.error('[cmd] hata:', e?.message, e?.stack); client.send('moveError', { code: 'internal' }); }
        return;
      }
      this.afterStep();
    });

    console.log(`[EllibirRoom] oluştu seed=${seed} humans=${this.humanSeats}`);
  }

  onJoin(client: Client, _options: any) {
    const taken = new Set(this.seats.values());
    const seat = this.humanSeats.find((s) => !taken.has(s)) ?? this.seats.size;
    this.seats.set(client.sessionId, seat);
    client.send('seat', { seat });
    console.log(`[onJoin] koltuk=${seat}, dolu=`, [...this.seats.values()]);
    // Oyuncu oturdu → botları/terk koltukları işlet (insan sırasında durur).
    this.game = stepEngine(this.game, (s) => this.isHumanTurn(s));
    this.pushViews();
  }

  async onLeave(client: Client, consented: boolean) {
    if (consented) { this.seats.delete(client.sessionId); return; }
    try {
      await this.allowReconnection(client, 90);
      this.pushViews();
    } catch {
      // Dönmedi → koltuğu boşalt: bot devralır.
      this.seats.delete(client.sessionId);
      this.game = stepEngine(this.game, (s) => this.isHumanTurn(s));
      this.afterStep();
    }
  }

  // O koltukta KARAR verecek bağlı (gerçek) oyuncu var mı?
  private isHumanTurn(seat: number): boolean {
    return [...this.seats.values()].includes(seat);
  }

  private afterStep() {
    this.pushViews();
    if (this.game.phase === 'handEnded') {
      console.log('[el bitti] 3sn sonra yeni el');
      if (this.handEndTimer) clearTimeout(this.handEndTimer);
      this.handEndTimer = setTimeout(() => this.continueHand(), 3000);
    }
    // TODO: matchEnded → Supabase çip settle (auth + bet bağlanınca).
  }

  private continueHand() {
    if (this.game.phase !== 'handEnded') return;
    try {
      this.game = startNextHand(this.game);
      this.game = stepEngine(this.game, (s) => this.isHumanTurn(s));
    } catch (e: any) { console.error('[continueHand] hata:', e?.message); return; }
    this.afterStep();
  }

  private pushViews() {
    this.clients.forEach((c) => {
      const seat = this.seats.get(c.sessionId);
      if (seat != null) c.send('view', JSON.stringify(clientViewFor(this.game, seat)));
    });
  }

  onDispose() {
    if (this.handEndTimer) clearTimeout(this.handEndTimer);
  }
}
