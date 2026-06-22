import { Room, Client } from '@colyseus/core';
import { createGame, startNextHand } from '../../../packages/engine/src/game';
import { clientViewFor } from '../clientView';
import { applyClientCommand, stepOnce, CmdError } from '../gameCommands';

/**
 * Bir MASA = bir oda. Engine state odada bellekte. Client protokolü (openSelected,
 * play, isle, continue, move...) gameCommands ile engine Move'a çevrilir.
 * Bot/sorgu adımları TEK TEK, her biri GECİKMELİ ayrı "view" olarak push edilir →
 * botların çekip atması istemcide animasyonlu görünür (Edge "frames" modelinin karşılığı).
 */
export class EllibirRoom extends Room {
  maxClients = 1;

  private game: any;
  private seats = new Map<string, number>();   // sessionId → koltuk
  private humanSeats: number[] = [];
  private handEndTimer: NodeJS.Timeout | null = null;
  private busy = false;                        // runEngine yeniden-giriş kilidi
  private readonly STEP_MS = 850;              // bot adımları arası gecikme (animasyon)

  onCreate(options: any) {
    const seed = options?.seed ?? Math.floor(Math.random() * 1_000_000_000);
    const names = options?.names ?? ['Oyuncu 1', 'Oyuncu 2', 'Oyuncu 3', 'Oyuncu 4'];
    const mode = options?.mode === 'duo' ? 'duo' : 'solo';

    // solo: 1 insan (seat 0) + 3 bot. duo (eşli): 2 insan PARTNER (seat 0,2) + 2 bot (seat 1,3).
    this.humanSeats = mode === 'duo' ? [0, 2] : [0];
    this.maxClients = this.humanSeats.length;
    const botSeats = [0, 1, 2, 3].filter((s) => !this.humanSeats.includes(s));

    // Client'tan gelen kural seti (RuleConfig JSON). duo → teamMode garanti.
    let rules: any;
    try { rules = typeof options?.rules === 'string' ? JSON.parse(options.rules) : options?.rules; }
    catch { rules = undefined; }
    if (rules && mode === 'duo') rules.teamMode = true;

    this.game = createGame({ seed, playerNames: names, botSeats, rules });
    this.setMetadata({ mode, humans: this.humanSeats.length });

    // Tek mesaj kanalı: client'ın tüm komutları "cmd" (JSON string) olarak gelir.
    this.onMessage('cmd', (client, raw) => {
      const seat = this.seats.get(client.sessionId);
      if (seat == null) return;
      let cmd: any;
      try { cmd = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch { client.send('moveError', { code: 'bad_json' }); return; }
      try {
        const r = applyClientCommand(this.game, cmd, seat);
        this.game = r.state;
        this.pushViews();                       // insan hamlesi anında yansır
        if (!r.skipBots) this.runEngine();      // botlar gecikmeli oynar
        else this.checkHandEnd();
      } catch (e: any) {
        if (e instanceof CmdError) client.send('moveError', { code: e.code });
        else { console.error('[cmd] hata:', e?.message, e?.stack); client.send('moveError', { code: 'internal' }); }
      }
    });

    console.log(`[EllibirRoom] oluştu seed=${seed} humans=${this.humanSeats}`);
  }

  onJoin(client: Client, _options: any) {
    const taken = new Set(this.seats.values());
    const seat = this.humanSeats.find((s) => !taken.has(s)) ?? this.seats.size;
    this.seats.set(client.sessionId, seat);
    client.send('seat', { seat });
    console.log(`[onJoin] koltuk=${seat}, dolu=`, [...this.seats.values()]);
    this.pushViews();
    this.runEngine();   // dağıtıcı bot ise oynamaya başlar (insan sırasında durur)
  }

  async onLeave(client: Client, consented: boolean) {
    if (consented) { this.seats.delete(client.sessionId); return; }
    try {
      await this.allowReconnection(client, 90);
      this.pushViews();
    } catch {
      this.seats.delete(client.sessionId);  // bot devralır
      this.runEngine();
    }
  }

  // İnsan koltuğu mu? (bağlı olmasa bile) → o koltuk sırasında oyun BEKLER, bot oynamaz.
  // Böylece 2. oyuncu masaya gelene kadar onun koltuğunu bot çalmaz.
  private isHumanTurn(seat: number): boolean {
    return this.humanSeats.includes(seat);
  }

  // Bot/sorgu adımlarını TEK TEK, aralarında gecikmeyle oynat ve her adımı push et.
  private async runEngine() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (true) {
        // ÖNCE bekle: bir önceki hamlenin (insanın ıskartası dahil) uçuş animasyonu bitsin,
        // sonra bot oynasın. Aksi halde sen atarken sıradaki bot kartın havadayken çekiyor.
        await new Promise((res) => setTimeout(res, this.STEP_MS));
        const r = stepOnce(this.game, (s) => this.isHumanTurn(s));
        if (!r.moved) break;
        this.game = r.state;
        this.pushViews();
      }
    } catch (e: any) {
      console.error('[runEngine] hata:', e?.message);
    } finally {
      this.busy = false;
    }
    this.checkHandEnd();
  }

  private checkHandEnd() {
    if (this.game.phase === 'handEnded') {
      console.log('[el bitti] 3sn sonra yeni el');
      if (this.handEndTimer) clearTimeout(this.handEndTimer);
      this.handEndTimer = setTimeout(() => this.continueHand(), 3000);
    }
    // TODO: matchEnded → Supabase çip settle (auth + bet bağlanınca).
  }

  private continueHand() {
    if (this.game.phase !== 'handEnded') return;
    try { this.game = startNextHand(this.game); }
    catch (e: any) { console.error('[continueHand] hata:', e?.message); return; }
    this.pushViews();
    this.runEngine();
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
