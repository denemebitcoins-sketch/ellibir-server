import { Room, Client } from '@colyseus/core';
// Mevcut TS motor — RN-free, olduğu gibi kullanılır.
import { createGame, applyMove, viewFor } from '../../../packages/engine/src/game';

/**
 * Bir MASA = bir oda. Engine state odada bellekte; her hamlede oyunculara
 * kendi view'ı WebSocket ile PUSH edilir (poll yok, anlık). Reconnect built-in.
 * State senkronu "view mesajı" modeli (Colyseus Schema kullanmıyoruz).
 */
export class EllibirRoom extends Room {
  maxClients = 4;

  private game: any;
  private seats = new Map<string, number>(); // sessionId → koltuk

  onCreate(options: any) {
    const seed = options?.seed ?? Math.floor(Math.random() * 1_000_000_000);
    const names = options?.names ?? ['Oyuncu 1', 'Oyuncu 2', 'Oyuncu 3', 'Oyuncu 4'];
    const botSeats = options?.botSeats ?? [1, 2, 3];
    this.game = createGame({ seed, playerNames: names, botSeats });

    this.onMessage('move', (client, move) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null) return;
      // Otorite: sadece sırası olan oynar (sorgu hamleleri hariç engine kontrol eder).
      try {
        this.game = applyMove(this.game, move);
      } catch (e: any) {
        client.send('moveError', { code: e?.code ?? 'err', message: e?.message ?? '' });
        return;
      }
      this.pushViews();
    });

    console.log(`[EllibirRoom] oluşturuldu (seed=${seed})`);
  }

  onJoin(client: Client, _options: any) {
    const seat = this.seats.size; // sıradaki boş koltuk
    this.seats.set(client.sessionId, seat);
    client.send('seat', { seat });
    this.pushViews();
    console.log(`[EllibirRoom] katıldı seat=${seat} (${client.sessionId})`);
  }

  async onLeave(client: Client, consented: boolean) {
    const seat = this.seats.get(client.sessionId);
    if (consented) { this.seats.delete(client.sessionId); return; }
    // Reconnect penceresi: 60 sn içinde dönerse koltuk korunur (token'la geri bağlanır).
    try {
      await this.allowReconnection(client, 60);
      console.log(`[EllibirRoom] geri döndü seat=${seat}`);
      this.pushViews();
    } catch {
      this.seats.delete(client.sessionId);
      console.log(`[EllibirRoom] düştü seat=${seat} (reconnect süresi doldu)`);
      // İLERİDE: boş koltuğu bota devret.
    }
  }

  private pushViews() {
    this.clients.forEach((c) => {
      const seat = this.seats.get(c.sessionId);
      if (seat != null) c.send('view', viewFor(this.game, seat));
    });
  }
}
